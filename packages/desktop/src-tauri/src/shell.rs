// ウィンドウとメニュー（Tauri 依存の部分）。判定ロジックは lib 側の純粋関数に置く。
use nod_desktop::about::about_text;
use nod_desktop::navigation::{decide, is_openable_local_url, NavDecision};
use nod_desktop::window_state::{self, Rect};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::menu::{
    AboutMetadata, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu,
};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

pub const MAIN_WINDOW: &str = "main";
const STATE_FILE: &str = "window-state.json";
const SAVE_INTERVAL: Duration = Duration::from_millis(500);

const ID_RELOAD: &str = "view.reload";
const ID_OPEN_IN_BROWSER: &str = "view.open_in_browser";
const ID_DEVTOOLS: &str = "help.devtools";

/// 位置とサイズの保存先と、直近の値。
pub struct WindowStateStore {
    path: Option<PathBuf>,
    current: Mutex<Option<Rect>>,
    last_write: Mutex<Option<Instant>>,
}

impl WindowStateStore {
    pub fn new(handle: &AppHandle) -> Self {
        let path = handle.path().app_data_dir().ok().map(|d| d.join(STATE_FILE));
        Self { path, current: Mutex::new(None), last_write: Mutex::new(None) }
    }

    fn load(&self) -> Option<Rect> {
        let text = std::fs::read_to_string(self.path.as_ref()?).ok()?;
        window_state::parse(&text)
    }

    fn write_current(&self) {
        let Some(path) = &self.path else { return };
        let Some(rect) = *self.current.lock().unwrap() else { return };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(path, window_state::serialize(&rect));
        *self.last_write.lock().unwrap() = Some(Instant::now());
    }

    /// 通常の状態（最大化・最小化・フルスクリーン・非表示でない）のときだけ現在値を取り込む。
    fn capture(&self, w: &WebviewWindow) {
        let normal = w.is_visible().unwrap_or(false)
            && !w.is_minimized().unwrap_or(true)
            && !w.is_maximized().unwrap_or(true)
            && !w.is_fullscreen().unwrap_or(true);
        if !normal {
            return;
        }
        let (Ok(size), Ok(pos)) = (w.inner_size(), w.outer_position()) else { return };
        *self.current.lock().unwrap() =
            Some(Rect { x: pos.x, y: pos.y, width: size.width, height: size.height });
    }

    fn capture_and_throttled_write(&self, w: &WebviewWindow) {
        self.capture(w);
        let due = self.last_write.lock().unwrap().is_none_or(|t| t.elapsed() >= SAVE_INTERVAL);
        if due {
            self.write_current();
        }
    }

    fn capture_and_write(&self, w: &WebviewWindow) {
        self.capture(w);
        self.write_current();
    }

    /// 終了時。ウィンドウが残っていれば取り込み、直近の値を書き出す。
    pub fn flush(&self, handle: &AppHandle) {
        if let Some(w) = handle.get_webview_window(MAIN_WINDOW) {
            self.capture(&w);
        }
        self.write_current();
    }
}

fn open_in_default_browser(url: &Url) {
    // 呼び出し側で http(s) に限定済み。ブラウザの起動はアプリの動作に影響させない。
    let _ = std::process::Command::new("open").arg(url.as_str()).spawn();
}

pub fn show_main(handle: &AppHandle) {
    if let Some(w) = handle.get_webview_window(MAIN_WINDOW) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// 主ウィンドウを 1 枚だけ作る。すでにあれば前面に出す。常に見える状態で開く。
pub fn open_main_window(handle: &AppHandle, url: &str) {
    if handle.get_webview_window(MAIN_WINDOW).is_some() {
        show_main(handle);
        return;
    }
    let Ok(parsed) = url.parse::<Url>() else { return };
    let Some(own_port) = parsed.port_or_known_default() else { return };

    let new_win_handle = handle.clone();
    let built = WebviewWindowBuilder::new(handle, MAIN_WINDOW, WebviewUrl::External(parsed))
        .title("nod")
        .inner_size(1280.0, 800.0)
        .min_inner_size(1024.0, 640.0)
        .visible(false)
        // 自分の origin 以外へは遷移させない。外部 http(s) は既定ブラウザへ。
        .on_navigation(move |u| match decide(u, own_port) {
            NavDecision::Allow => true,
            NavDecision::OpenExternal => {
                open_in_default_browser(u);
                false
            }
            NavDecision::Deny => false,
        })
        // window.open / target=_blank。新しいウィンドウは作らない。
        .on_new_window(move |u, _features| {
            match decide(&u, own_port) {
                NavDecision::Allow => {
                    if let Some(w) = new_win_handle.get_webview_window(MAIN_WINDOW) {
                        let _ = w.navigate(u);
                    }
                }
                NavDecision::OpenExternal => open_in_default_browser(&u),
                NavDecision::Deny => {}
            }
            NewWindowResponse::Deny
        })
        .build();
    let Ok(win) = built else { return };

    // 保存位置の復元。画面外なら既定サイズで中央に置く。
    let store = handle.state::<WindowStateStore>();
    let monitors: Vec<Rect> = handle
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| Rect {
            x: m.position().x,
            y: m.position().y,
            width: m.size().width,
            height: m.size().height,
        })
        .collect();
    match window_state::resolve_placement(store.load(), &monitors) {
        Some(r) => {
            let _ = win.set_size(tauri::PhysicalSize::new(r.width, r.height));
            let _ = win.set_position(tauri::PhysicalPosition::new(r.x, r.y));
        }
        None => {
            let _ = win.center();
        }
    }

    let w = win.clone();
    let h = handle.clone();
    win.on_window_event(move |event| {
        let store = h.state::<WindowStateStore>();
        match event {
            // 閉じる操作は非表示にするだけ。アプリと sidecar は存続させる。
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                store.capture_and_write(&w);
                let _ = w.hide();
            }
            WindowEvent::Moved(_) | WindowEvent::Resized(_) => store.capture_and_throttled_write(&w),
            WindowEvent::Focused(false) => store.capture_and_write(&w),
            _ => {}
        }
    });

    let _ = win.show();
    let _ = win.set_focus();
}

pub fn build_menu(handle: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let info = handle
        .path()
        .resource_dir()
        .ok()
        .and_then(|d| std::fs::read_to_string(d.join("build-info")).ok());
    let about = about_text(info.as_deref());

    let app_menu = Submenu::with_items(
        handle,
        "nod",
        true,
        &[
            &PredefinedMenuItem::about(
                handle,
                Some("nod について"),
                Some(AboutMetadata {
                    name: Some("nod".into()),
                    // macOS の標準パネルでは「<version> (<short_version>)」と表示される（実測）。
                    version: Some(about.version.clone()),
                    short_version: Some(about.commit.clone()),
                    credits: Some(about.credits.clone()),
                    ..Default::default()
                }),
            )?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::hide(handle, Some("nod を隠す"))?,
            &PredefinedMenuItem::hide_others(handle, Some("ほかを隠す"))?,
            &PredefinedMenuItem::show_all(handle, Some("すべてを表示"))?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::quit(handle, Some("nod を終了"))?,
        ],
    )?;

    let file_menu = Submenu::with_items(
        handle,
        "ファイル",
        true,
        &[&PredefinedMenuItem::close_window(handle, Some("閉じる"))?],
    )?;

    let edit_menu = Submenu::with_items(
        handle,
        "編集",
        true,
        &[
            &PredefinedMenuItem::undo(handle, Some("元に戻す"))?,
            &PredefinedMenuItem::redo(handle, Some("やり直す"))?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::cut(handle, Some("切り取り"))?,
            &PredefinedMenuItem::copy(handle, Some("コピー"))?,
            &PredefinedMenuItem::paste(handle, Some("貼り付け"))?,
            &PredefinedMenuItem::select_all(handle, Some("すべて選択"))?,
        ],
    )?;

    let view_menu = Submenu::with_items(
        handle,
        "表示",
        true,
        &[
            &MenuItem::with_id(handle, ID_RELOAD, "再読み込み", true, Some("CmdOrCtrl+R"))?,
            &MenuItem::with_id(
                handle,
                ID_OPEN_IN_BROWSER,
                "ブラウザで開く",
                true,
                Some("CmdOrCtrl+Shift+O"),
            )?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::fullscreen(handle, Some("フルスクリーンにする"))?,
        ],
    )?;

    let window_menu = Submenu::with_items(
        handle,
        "ウィンドウ",
        true,
        &[
            &PredefinedMenuItem::minimize(handle, Some("しまう"))?,
            &PredefinedMenuItem::maximize(handle, Some("拡大/縮小"))?,
        ],
    )?;

    // Task 6 で「ログを開く」「診断情報をコピー」をここ（開発者ツールの前）に足す。
    let help_menu = Submenu::with_items(
        handle,
        "ヘルプ",
        true,
        &[&MenuItem::with_id(handle, ID_DEVTOOLS, "開発者ツール", true, Some("CmdOrCtrl+Alt+I"))?],
    )?;

    let menu = Menu::with_items(
        handle,
        &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu, &help_menu],
    )?;
    #[cfg(target_os = "macos")]
    {
        let _ = window_menu.set_as_windows_menu_for_nsapp();
        let _ = help_menu.set_as_help_menu_for_nsapp();
    }
    Ok(menu)
}

pub fn on_menu_event(handle: &AppHandle, event: MenuEvent) {
    let Some(w) = handle.get_webview_window(MAIN_WINDOW) else { return };
    match event.id().as_ref() {
        // 現在のページだけを再読み込みする。sidecar は再起動しない。
        ID_RELOAD => {
            let _ = w.reload();
        }
        ID_OPEN_IN_BROWSER => {
            if let Ok(u) = w.url() {
                if is_openable_local_url(&u) {
                    open_in_default_browser(&u);
                }
            }
        }
        ID_DEVTOOLS => {
            if w.is_devtools_open() {
                w.close_devtools();
            } else {
                w.open_devtools();
            }
        }
        _ => {}
    }
}

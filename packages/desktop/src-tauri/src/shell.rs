// ウィンドウとメニュー（Tauri 依存の部分）。判定ロジックは lib 側の純粋関数に置く。
use nod_desktop::about::about_text;
use crate::status::{self, Status};
use nod_desktop::navigation::{
    decide, is_app_page, is_openable_local_url, parse_action, NavDecision,
};
use nod_desktop::window_state::{self, Rect};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU16, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
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
const ID_OPEN_LOGS: &str = "help.open_logs";
const ID_COPY_DIAGNOSTICS: &str = "help.copy_diagnostics";

/// いま主ウィンドウが開いている sidecar の port（再試行で変わる）。0 は未確定。
#[derive(Default)]
pub struct OwnPort(AtomicU16);

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

/// 読み込みの開始・完了の通し番号。開始から LOAD_STALL を過ぎても完了が追いつかなければ「未完了」
#[derive(Default)]
struct LoadSeq {
    started: AtomicU64,
    finished: AtomicU64,
}

const LOAD_STALL: Duration = Duration::from_secs(10);

/// 主ウィンドウを作る（非表示のまま返す）。位置とサイズの復元・遷移の制限・閉じる操作を設定する。
fn build_main(handle: &AppHandle, url: Url) -> Option<WebviewWindow> {
    let new_win_handle = handle.clone();
    let nav_handle = handle.clone();
    let load_handle = handle.clone();
    let load_seq = Arc::new(LoadSeq::default());
    let built = WebviewWindowBuilder::new(handle, MAIN_WINDOW, WebviewUrl::External(url))
        .title("nod")
        .inner_size(1280.0, 800.0)
        .min_inner_size(1024.0, 640.0)
        .visible(false)
        // 自分の origin 以外へは遷移させない。外部 http(s) は既定ブラウザへ。
        // アプリの静的画面（tauri://localhost）と、そのボタン（nod-action://）だけは別扱い。
        .on_navigation(move |u| {
            if let Some(action) = parse_action(u) {
                // ボタンは静的画面からのみ受け付ける（sidecar のページ内のリンクでは動かさない）。
                if nav_handle.state::<Arc<Status>>().page_is_app() {
                    status::dispatch(&nav_handle, action);
                }
                return false;
            }
            if is_app_page(u) {
                return true;
            }
            let own_port = nav_handle.state::<OwnPort>().0.load(Ordering::SeqCst);
            match decide(u, own_port) {
                NavDecision::Allow => true,
                NavDecision::OpenExternal => {
                    open_in_default_browser(u);
                    false
                }
                NavDecision::Deny => false,
            }
        })
        // 読み込みの開始と完了を記録する（URL の origin とパスのみ。クエリ・本文は残さない）。
        // Tauri の API は読み込みの失敗そのものを通知しないため、開始から LOAD_STALL 以内に完了しなければ
        // 「未完了」を記録して失敗の手がかりにする。
        .on_page_load(move |_w, payload| {
            let u = payload.url();
            let origin = format!("{}://{}{}", u.scheme(), u.host_str().unwrap_or(""), u.path());
            let logger = load_handle.state::<Arc<Status>>().logger.clone();
            let seq = &load_seq;
            match payload.event() {
                tauri::webview::PageLoadEvent::Started => {
                    let id = seq.started.fetch_add(1, Ordering::SeqCst) + 1;
                    logger.event(nod_desktop::log::Stage::Running, &format!("WebView の読み込み開始: {origin}"));
                    let seq = seq.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(LOAD_STALL);
                        if seq.finished.load(Ordering::SeqCst) < id {
                            logger.event(
                                nod_desktop::log::Stage::Running,
                                &format!("WebView の読み込みが {} 秒以内に完了しませんでした: {origin}", LOAD_STALL.as_secs()),
                            );
                        }
                    });
                }
                tauri::webview::PageLoadEvent::Finished => {
                    seq.finished.store(seq.started.load(Ordering::SeqCst), Ordering::SeqCst);
                    logger.event(nod_desktop::log::Stage::Running, &format!("WebView の読み込み完了: {origin}"));
                }
            }
        })
        // window.open / target=_blank。新しいウィンドウは作らない。
        .on_new_window(move |u, _features| {
            let own_port = new_win_handle.state::<OwnPort>().0.load(Ordering::SeqCst);
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
    let win = built.ok()?;

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
    Some(win)
}

fn show_window(win: &WebviewWindow) {
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
}

/// 主ウィンドウ（1 枚）で `url` を表示する。なければ作る。いずれも見える状態にする。
fn show_url(handle: &AppHandle, url: Url) {
    if let Some(w) = handle.get_webview_window(MAIN_WINDOW) {
        let _ = w.navigate(url);
        show_window(&w);
    } else if let Some(w) = build_main(handle, url) {
        show_window(&w);
    }
}

/// sidecar の URL を主ウィンドウで開く（起動中・失敗画面からの遷移を含む）。
/// `reveal` が false なら、利用者が隠しているウィンドウは出さず、あるウィンドウの遷移だけを行う。
pub fn open_main_window(handle: &AppHandle, url: &str, reveal: bool) {
    let Ok(parsed) = url.parse::<Url>() else { return };
    let Some(port) = parsed.port_or_known_default() else { return };
    // 復旧でポートが変わりうる。遷移の判定（on_navigation / on_new_window）が新しい origin に追従する。
    handle.state::<OwnPort>().0.store(port, Ordering::SeqCst);
    if reveal {
        show_url(handle, parsed);
    } else if let Some(w) = handle.get_webview_window(MAIN_WINDOW) {
        let _ = w.navigate(parsed);
    } else {
        show_url(handle, parsed);
    }
}

/// 起動中の画面などを、ウィンドウの表示状態を変えずに出す。ウィンドウが無ければ何もしない。
pub fn show_app_page_quiet(handle: &AppHandle, page: &str) {
    if let (Some(w), Ok(url)) =
        (handle.get_webview_window(MAIN_WINDOW), format!("tauri://localhost/{page}").parse::<Url>())
    {
        let _ = w.navigate(url);
    }
}

/// アプリの静的画面（frontend の HTML）を主ウィンドウで表示する。
pub fn show_app_page(handle: &AppHandle, page: &str, query: Option<&str>) {
    let mut u = format!("tauri://localhost/{page}");
    if let Some(q) = query {
        u.push('?');
        u.push_str(q);
    }
    if let Ok(url) = u.parse::<Url>() {
        show_url(handle, url);
    }
}

/// 失敗画面のボタンの結果などを、表示中の静的画面へ知らせる。
pub fn notify_page(handle: &AppHandle, text: &str) {
    if let Some(w) = handle.get_webview_window(MAIN_WINDOW) {
        let msg = serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into());
        let _ = w.eval(format!("window.__nodNotice && window.__nodNotice({msg})"));
    }
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

    let help_menu = Submenu::with_items(
        handle,
        "ヘルプ",
        true,
        &[
            &MenuItem::with_id(handle, ID_OPEN_LOGS, "ログを開く", true, None::<&str>)?,
            &MenuItem::with_id(handle, ID_COPY_DIAGNOSTICS, "診断情報をコピー", true, None::<&str>)?,
            &PredefinedMenuItem::separator(handle)?,
            &MenuItem::with_id(handle, ID_DEVTOOLS, "開発者ツール", true, Some("CmdOrCtrl+Alt+I"))?,
        ],
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
    // ログと診断情報は、ウィンドウがない起動待機中でも使える。
    match event.id().as_ref() {
        ID_OPEN_LOGS => return status::dispatch(handle, nod_desktop::navigation::UiAction::OpenLogs),
        ID_COPY_DIAGNOSTICS => {
            return status::dispatch(handle, nod_desktop::navigation::UiAction::CopyDiagnostics)
        }
        _ => {}
    }
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

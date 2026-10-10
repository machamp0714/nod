// Tauri のイベントループ側。起動・停止のロジックは lib（nod_desktop）にあり、ここは薄く保つ。
// ウィンドウとメニューは shell.rs、起動状態・ログ・失敗画面のボタンは status.rs。
mod shell;
mod status;
use nod_desktop::{
    run_launch, stop_process, Failure, LaunchConfig, LaunchOutcome, RealPlatform, Stage, Supervisor,
    STOP_GRACE,
};
use status::Status;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::{Manager, RunEvent};

fn sidecar_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    // .../nod.app/Contents/MacOS/<main> と同じディレクトリに externalBin の nod がある。
    Ok(exe.parent().ok_or("exe に親がありません")?.join("nod"))
}

fn launch_config(handle: &tauri::AppHandle) -> Result<LaunchConfig, String> {
    let web_dir = handle.path().resource_dir().map_err(|e| e.to_string())?.join("web");
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let nonce = format!("{}_{}", std::process::id(), nanos);
    Ok(LaunchConfig::new(sidecar_path()?, web_dir, nonce))
}

/// 起動中の画面を出すまでの猶予。これより早く終われば、ウィンドウは完成後に初めて出る。
const STARTING_SCREEN_DELAY: Duration = Duration::from_secs(2);

fn start_launch(handle: tauri::AppHandle) {
    let sup = handle.state::<Arc<Supervisor>>().inner().clone();
    let status = handle.state::<Arc<Status>>().inner().clone();
    let Some(token) = sup.begin_launch() else { return };
    let launch_id = status.begin(token);
    status.logger.event(Stage::App, &format!("起動を開始しました（起動単位 {launch_id}）"));

    // 再試行など、すでにウィンドウがあるときは、古い失敗画面を残さず起動中の画面へ戻す。
    if handle.get_webview_window(shell::MAIN_WINDOW).is_some() {
        let h = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            shell::show_app_page(&h, "index.html", None);
        });
    }

    // 2 秒を超えても終わらない場合だけ、起動中の画面を出す。
    {
        let (h, sup, status) = (handle.clone(), sup.clone(), status.clone());
        std::thread::spawn(move || {
            std::thread::sleep(STARTING_SCREEN_DELAY);
            if !sup.is_current(token) || !status.is_launching(token) {
                return;
            }
            let (h2, sup2, status2) = (h.clone(), sup.clone(), status.clone());
            let _ = h.run_on_main_thread(move || {
                // 結果の通知もメインスレッドで処理するため、ここでの再確認で競合しない。
                if sup2.is_current(token) && status2.is_launching(token) {
                    status2.logger.event(Stage::Startup, "起動中の画面を表示しました");
                    shell::show_app_page(&h2, "index.html", None);
                }
            });
        });
    }

    std::thread::spawn(move || {
        let platform = RealPlatform::with_logger(status.logger.clone());
        // 前回の失敗で残っている sidecar があれば止める（起動中の再試行でも安全）。
        if let Some(old) = sup.take_current() {
            stop_process(&platform, old.as_ref(), STOP_GRACE);
        }
        let show_failure = |f: Failure| {
            status.logger.event(
                Stage::App,
                &format!("失敗画面を表示します（段階 {}、分類 {}）", f.stage.as_str(), f.kind.as_str()),
            );
            let (h, s, sup) = (handle.clone(), status.clone(), sup.clone());
            let _ = handle.run_on_main_thread(move || {
                // 世代はメインスレッドで再確認する（終了・再試行との競合を避ける）。
                if sup.is_current(token) {
                    let query = nod_desktop::failure::page_query(&f);
                    s.fail(token, f);
                    shell::show_app_page(&h, "failure.html", Some(&query));
                }
            });
        };
        let cfg = match launch_config(&handle) {
            Ok(c) => c,
            Err(_) => return show_failure(nod_desktop::failure::internal(Stage::App)),
        };
        match run_launch(&platform, &cfg, &sup, token) {
            LaunchOutcome::Ready(url) => {
                let (h, s, sup) = (handle.clone(), status.clone(), sup.clone());
                let _ = handle.run_on_main_thread(move || {
                    if sup.is_current(token) {
                        let port = url::Url::parse(&url).ok().and_then(|u| u.port());
                        s.ready(token, sup.current_pid(), port);
                        s.logger.event(Stage::Running, &format!("主ウィンドウを表示します（{url}）"));
                        shell::open_main_window(&h, &url);
                    }
                });
            }
            LaunchOutcome::Discarded => {}
            LaunchOutcome::Failed(e) => show_failure(nod_desktop::classify(&e)),
        }
    });
}

fn main() {
    let app = tauri::Builder::default()
        // 二重起動では既存のウィンドウを前面に出す。ウィンドウが未作成の待機中は何もしない。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            shell::show_main(app);
        }))
        .on_menu_event(shell::on_menu_event)
        .manage(Arc::new(Supervisor::new()))
        .setup(|app| {
            app.manage(shell::WindowStateStore::new(app.handle()));
            app.manage(shell::OwnPort::default());
            app.manage(Arc::new(Status::new(app.handle())));
            // resource_dir は setup 以降でないと使えないため、メニューもここで設定する。
            let menu = shell::build_menu(app.handle())?;
            app.set_menu(menu)?;
            start_launch(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("tauri の初期化に失敗しました");

    app.run(|handle, event| {
        // Dock のクリックで、非表示にした主ウィンドウを再表示する。
        if let RunEvent::Reopen { .. } = event {
            shell::show_main(handle);
        }
        if let RunEvent::Exit = event {
            if let Some(store) = handle.try_state::<shell::WindowStateStore>() {
                store.flush(handle);
            }
            // 終了後に遅れて届く起動成功は世代で無効になる。SIGTERM → 猶予 → SIGKILL。
            let sup = handle.state::<Arc<Supervisor>>();
            if let Some(proc) = sup.quit() {
                let platform = match handle.try_state::<Arc<Status>>() {
                    Some(st) => RealPlatform::with_logger(st.logger.clone()),
                    None => RealPlatform::new(),
                };
                stop_process(&platform, proc.as_ref(), STOP_GRACE);
            }
        }
    });
}

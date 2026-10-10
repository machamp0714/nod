// Tauri のイベントループ側。起動・停止のロジックは lib（nod_desktop）にあり、ここは薄く保つ。
// ウィンドウの作り込み・失敗画面・ログは後続の Task。
use nod_desktop::{
    run_launch, stop_process, LaunchConfig, LaunchOutcome, RealPlatform, Supervisor, STOP_GRACE,
};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

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

fn open_window(handle: &tauri::AppHandle, url: &str) {
    let Ok(parsed) = url.parse() else { return };
    let _ = WebviewWindowBuilder::new(handle, "main", WebviewUrl::External(parsed))
        .title("nod")
        .inner_size(1280.0, 800.0)
        .build();
}

fn start_launch(handle: tauri::AppHandle) {
    let sup = handle.state::<Arc<Supervisor>>().inner().clone();
    let Some(token) = sup.begin_launch() else { return };
    std::thread::spawn(move || {
        let platform = RealPlatform::new();
        let cfg = match launch_config(&handle) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("nod: 起動に失敗しました: {e}");
                handle.exit(1);
                return;
            }
        };
        match run_launch(&platform, &cfg, &sup, token) {
            LaunchOutcome::Ready(url) => {
                // 世代はメインスレッドで再確認する（終了・再試行との競合を避ける）。
                let (h, s) = (handle.clone(), sup.clone());
                let _ = handle.run_on_main_thread(move || {
                    if s.is_current(token) {
                        open_window(&h, &url);
                    }
                });
            }
            LaunchOutcome::Discarded => {}
            LaunchOutcome::Failed(e) => {
                eprintln!("nod: 起動に失敗しました: {e}");
                handle.exit(1);
            }
        }
    });
}

fn main() {
    let app = tauri::Builder::default()
        // 二重起動では既存のウィンドウを前面に出す。ウィンドウが未作成の待機中は何もしない。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .manage(Arc::new(Supervisor::new()))
        .setup(|app| {
            start_launch(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("tauri の初期化に失敗しました");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            // 終了後に遅れて届く起動成功は世代で無効になる。SIGTERM → 猶予 → SIGKILL。
            let sup = handle.state::<Arc<Supervisor>>();
            if let Some(proc) = sup.quit() {
                stop_process(&RealPlatform::new(), proc.as_ref(), STOP_GRACE);
            }
        }
    });
}

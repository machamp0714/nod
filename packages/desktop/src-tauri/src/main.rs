// Tauri のイベントループ側。起動・停止のロジックは lib（nod_desktop）にあり、ここは薄く保つ。
// ウィンドウとメニューは shell.rs、起動状態・ログ・失敗画面のボタンは status.rs。
mod shell;
mod status;
use nod_desktop::recovery::{monitor, Recovery, RecoveryHooks};
use nod_desktop::{
    run_launch, stop_sidecar, Failure, LaunchConfig, LaunchOutcome, RealPlatform, Stage, Supervisor,
    STOP_GRACE,
};
use status::Status;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
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
    let mut cfg = LaunchConfig::new(sidecar_path()?, web_dir, nonce);
    // 孤児の回収と記録に使う。ログと同じ場所（NOD_DESKTOP_LOG_DIR で隔離できる）。
    cfg.pidfile = Some(handle.state::<Arc<Status>>().pidfile());
    Ok(cfg)
}

/// 稼働中の異常終了からの復旧を、ウィンドウとステータスへ伝える。
/// 結果は必ずメインスレッドで世代を再確認してから反映する（終了・再試行との競合を避ける）。
struct DesktopHooks {
    handle: tauri::AppHandle,
    sup: Arc<Supervisor>,
    status: Arc<Status>,
}

impl RecoveryHooks for DesktopHooks {
    fn restarting(&self, token: u64, attempt: u32, delay: Duration) {
        let id = self.status.begin(token);
        self.status.logger.event(
            Stage::Running,
            &format!("sidecar を再起動します（{attempt} 回目、{} 秒後、起動単位 {id}）", delay.as_secs()),
        );
        let (h, sup) = (self.handle.clone(), self.sup.clone());
        let _ = self.handle.run_on_main_thread(move || {
            // 起動中の画面。利用者が閉じて隠しているウィンドウは出さない。
            if sup.is_current(token) {
                shell::show_app_page_quiet(&h, "index.html");
            }
        });
    }

    fn recovered(&self, token: u64, url: &str, pid: Option<u32>) {
        let (h, s, sup, url) = (self.handle.clone(), self.status.clone(), self.sup.clone(), url.to_string());
        let _ = self.handle.run_on_main_thread(move || {
            if sup.is_current(token) {
                let port = url::Url::parse(&url).ok().and_then(|u| u.port());
                s.ready(token, pid, port);
                s.logger.event(Stage::Running, &format!("復旧しました。新しい URL へ遷移します（{url}）"));
                // GET の遷移のみ。直前のリクエストは再送しない。ポートが変わりうるため origin も更新する。
                shell::open_main_window(&h, &url, false);
            }
        });
    }

    fn gave_up(&self, token: u64, failure: Failure) {
        show_failure_page(&self.handle, &self.sup, &self.status, token, failure);
    }
}

fn show_failure_page(
    handle: &tauri::AppHandle,
    sup: &Arc<Supervisor>,
    status: &Arc<Status>,
    token: u64,
    f: Failure,
) {
    status.logger.event(
        Stage::App,
        &format!("失敗画面を表示します（段階 {}、分類 {}）", f.stage.as_str(), f.kind.as_str()),
    );
    let (h, s, sup) = (handle.clone(), status.clone(), sup.clone());
    let _ = handle.run_on_main_thread(move || {
        if sup.is_current(token) {
            let query = nod_desktop::failure::page_query(&f);
            s.fail(token, f);
            shell::show_app_page(&h, "failure.html", Some(&query));
        }
    });
}

/// 起動中の画面を出すまでの猶予。これより早く終われば、ウィンドウは完成後に初めて出る。
const STARTING_SCREEN_DELAY: Duration = Duration::from_secs(2);

fn start_launch(handle: tauri::AppHandle) {
    let sup = handle.state::<Arc<Supervisor>>().inner().clone();
    let status = handle.state::<Arc<Status>>().inner().clone();
    let Some(token) = sup.begin_launch() else { return };
    // 手動の再試行（と最初の起動）で、自動の再起動の数え方を 0 に戻す。
    handle.state::<Arc<Recovery>>().reset();
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
        let pidfile = status.pidfile();
        // 前回の失敗で残っている sidecar があれば止める（起動中の再試行でも安全）。
        if let Some(old) = sup.take_current() {
            stop_sidecar(&platform, old.as_ref(), STOP_GRACE, Some(&pidfile));
        }
        let show_failure = |f: Failure| show_failure_page(&handle, &sup, &status, token, f);
        let cfg = match launch_config(&handle) {
            Ok(c) => c,
            Err(_) => return show_failure(nod_desktop::failure::internal(Stage::App)),
        };
        match run_launch(&platform, &cfg, &sup, token) {
            LaunchOutcome::Ready(url) => {
                let (h, s, sup2) = (handle.clone(), status.clone(), sup.clone());
                let _ = handle.run_on_main_thread(move || {
                    if sup2.is_current(token) {
                        let port = url::Url::parse(&url).ok().and_then(|u| u.port());
                        s.ready(token, sup2.current_pid(), port);
                        s.logger.event(Stage::Running, &format!("主ウィンドウを表示します（{url}）"));
                        shell::open_main_window(&h, &url, true);
                    }
                });
                // 起動完了後は、異常終了を監視して自動で復旧する（終了・再試行まで戻らない）。
                let hooks = DesktopHooks { handle: handle.clone(), sup: sup.clone(), status: status.clone() };
                let rec = handle.state::<Arc<Recovery>>().inner().clone();
                monitor(&platform, &cfg, &sup, &rec, &hooks, token);
            }
            LaunchOutcome::Discarded => {}
            LaunchOutcome::Failed(e) => show_failure(nod_desktop::classify(&e)),
        }
    });
}

/// SIGTERM・SIGHUP・SIGINT を受けたら、通常の終了要求（ExitRequested 経路）へ回す。
/// 既定の動作だとアプリが即座に消え、sidecar が孤児になる。ハンドラは旗を立てるだけにする。
static SIGNALLED: AtomicBool = AtomicBool::new(false);

extern "C" fn on_signal(_: libc::c_int) {
    SIGNALLED.store(true, Ordering::SeqCst);
}

fn watch_signals(handle: tauri::AppHandle) {
    for sig in [libc::SIGTERM, libc::SIGHUP, libc::SIGINT] {
        unsafe { libc::signal(sig, on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t) };
    }
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(100));
        if SIGNALLED.swap(false, Ordering::SeqCst) {
            if let Some(st) = handle.try_state::<Arc<Status>>() {
                st.logger.event(Stage::Shutdown, "終了シグナルを受けたため、通常の終了要求へ回します");
            }
            handle.exit(0);
        }
    });
}

/// 終了処理。SIGTERM → 3 秒 → SIGKILL で sidecar（と環境取得中のシェル）を止め、pidfile を消す。
/// WAL/SHM は掃除しない。ExitRequested と Exit の両方から呼ぶ（2 回目は停止対象が無く何もしない）。
///
/// 登録順の調査結果（tauri 2.12.2 / tauri-plugin-single-instance 2.5.2 のソースと実機のログ）:
/// - ソース: `on_event_loop_event` はイベントごとに、先にプラグインの `on_event`、後にアプリの
///   コールバックを呼ぶ。single-instance が Exit で行うのはソケットの削除だけで、sidecar は kill しない。
/// - 実測（macOS 26、隔離データ）: アプリ自身の `exit(0)` と SIGTERM（ハンドラ経由で exit）は
///   ExitRequested → Exit の順に来る。AppleScript の `quit`（NSApplication の terminate。Cmd+Q・Dock の終了・
///   ログアウトの終了要求と同じ経路と推測）は ExitRequested を経ず Exit だけが来る。このため Exit にも
///   停止処理を置いている。Exit でもプラグインの処理の後に SIGTERM で正常に止まることを確認した。
/// - ログアウト自体は実施していない（未確認）。
fn shutdown(handle: &tauri::AppHandle, via: &str) {
    let Some(sup) = handle.try_state::<Arc<Supervisor>>() else { return };
    let status = handle.try_state::<Arc<Status>>();
    let platform = match &status {
        Some(st) => RealPlatform::with_logger(st.logger.clone()),
        None => RealPlatform::new(),
    };
    // 先に quitting を立て、以降の再起動・起動成功の通知を無効にする。
    let proc = sup.quit();
    if let Some(st) = &status {
        st.logger.event(
            Stage::Shutdown,
            &format!("終了処理を開始します（経路 {via}、停止対象 {}）", if proc.is_some() { "あり" } else { "なし" }),
        );
    }
    if let Some(store) = handle.try_state::<shell::WindowStateStore>() {
        store.flush(handle);
    }
    if let Some(proc) = proc {
        let pidfile = status.as_ref().map(|s| s.pidfile());
        stop_sidecar(&platform, proc.as_ref(), STOP_GRACE, pidfile.as_deref());
    }
}

fn main() {
    let app = tauri::Builder::default()
        // 二重起動では既存のウィンドウを前面に出す。ウィンドウが未作成の待機中は何もしない。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            shell::show_main(app);
        }))
        .on_menu_event(shell::on_menu_event)
        .manage(Arc::new(Supervisor::new()))
        .manage(Arc::new(Recovery::new()))
        .setup(|app| {
            app.manage(shell::WindowStateStore::new(app.handle()));
            app.manage(shell::OwnPort::default());
            app.manage(Arc::new(Status::new(app.handle())));
            // resource_dir は setup 以降でないと使えないため、メニューもここで設定する。
            let menu = shell::build_menu(app.handle())?;
            app.set_menu(menu)?;
            watch_signals(app.handle().clone());
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
        // OS の終了・ログアウト・Cmd+Q・失敗画面の「終了」は、まず ExitRequested に来る。
        // プラグインの Exit 処理より前に、自作の停止を済ませる。Exit は保険。
        match event {
            RunEvent::ExitRequested { .. } => shutdown(handle, "ExitRequested"),
            RunEvent::Exit => shutdown(handle, "Exit"),
            _ => {}
        }
    });
}

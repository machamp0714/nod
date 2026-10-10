// 起動状態の保持と、ログ・診断情報・失敗画面のボタンの実体（Tauri 依存の部分）。
// 整形や分類は lib 側（failure.rs・log.rs）にあり、ここは状態とコマンド実行だけを持つ。
use crate::shell;
use nod_desktop::about::about_text;
use nod_desktop::log::{log_dir, LOG_DIR_ENV};
use nod_desktop::navigation::UiAction;
use nod_desktop::{diagnostics, DiagInput, Failure, Logger, RunState, Stage};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

struct Inner {
    token: u64,
    state: RunState,
    failure: Option<Failure>,
    pid: Option<u32>,
    port: Option<u16>,
}

pub struct Status {
    inner: Mutex<Inner>,
    pub logger: Arc<Logger>,
    version: String,
    commit: String,
    os: String,
    log_dir: PathBuf,
}

fn command_output(program: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(program).args(args).output().ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !s.is_empty()).then_some(s)
}

impl Status {
    pub fn new(handle: &AppHandle) -> Self {
        let info = handle
            .path()
            .resource_dir()
            .ok()
            .and_then(|d| std::fs::read_to_string(d.join("build-info")).ok());
        let about = about_text(info.as_deref());
        let home = std::env::var("HOME").ok();
        let over = std::env::var(LOG_DIR_ENV).ok();
        // HOME も決まらない場合だけ、一時ディレクトリへ逃がす（書けなくてもアプリは動く）。
        let dir = log_dir(over.as_deref(), home.as_deref())
            .unwrap_or_else(|| std::env::temp_dir().join("io.github.machamp0714.nod-logs"));
        let os = command_output("/usr/bin/sw_vers", &["-productVersion"])
            .map(|v| format!("macOS {v}"))
            .unwrap_or_else(|| "macOS（版は不明）".into());
        Self {
            inner: Mutex::new(Inner {
                token: 0,
                state: RunState::Starting,
                failure: None,
                pid: None,
                port: None,
            }),
            logger: Arc::new(Logger::new(dir.clone(), about.version.clone())),
            version: about.version,
            commit: about.commit,
            os,
            log_dir: dir,
        }
    }

    /// sidecar の pidfile。ログと同じ場所に置く。
    pub fn pidfile(&self) -> PathBuf {
        self.log_dir.join(nod_desktop::orphan::PIDFILE_NAME)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 新しい起動を始める。起動単位の識別子を作り直し、前回の結果を消す。
    pub fn begin(&self, token: u64) -> String {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let id = format!("{:x}-{token}", nanos / 1_000_000);
        self.logger.set_launch_id(&id);
        let mut g = self.lock();
        *g = Inner { token, state: RunState::Starting, failure: None, pid: None, port: None };
        id
    }

    pub fn is_launching(&self, token: u64) -> bool {
        let g = self.lock();
        g.token == token && g.state == RunState::Starting
    }

    pub fn ready(&self, token: u64, pid: Option<u32>, port: Option<u16>) {
        let mut g = self.lock();
        if g.token == token {
            g.state = RunState::Running;
            g.pid = pid;
            g.port = port;
        }
    }

    pub fn fail(&self, token: u64, f: Failure) {
        let mut g = self.lock();
        if g.token == token {
            g.state = RunState::Failed;
            g.failure = Some(f);
        }
    }

    /// 表示中のページがアプリの静的画面か（sidecar のページではないか）。
    pub fn page_is_app(&self) -> bool {
        self.lock().state != RunState::Running
    }

    pub fn diagnostics_text(&self) -> String {
        let g = self.lock();
        diagnostics(&DiagInput {
            app_version: &self.version,
            commit: &self.commit,
            launch_id: &self.logger.launch_id(),
            state: g.state,
            failure: g.failure.as_ref(),
            sidecar_pid: g.pid,
            port: g.port,
            os: &self.os,
            arch: std::env::consts::ARCH,
            log_dir: &self.log_dir.to_string_lossy(),
        })
    }
}

/// ログのディレクトリを Finder で開く。メニューと失敗画面の共通。
pub fn open_logs(handle: &AppHandle) {
    let status = handle.state::<Arc<Status>>();
    let _ = std::fs::create_dir_all(&status.log_dir);
    let ok = Command::new("open").arg(&status.log_dir).spawn().is_ok();
    status.logger.event(Stage::App, if ok { "ログのディレクトリを開きました" } else { "ログのディレクトリを開けませんでした" });
}

/// 診断情報をクリップボードへ（pbcopy）。メニューと失敗画面の共通。
pub fn copy_diagnostics(handle: &AppHandle) {
    let status = handle.state::<Arc<Status>>();
    let text = status.diagnostics_text();
    let copied = (|| -> std::io::Result<bool> {
        let mut child = Command::new("pbcopy").stdin(Stdio::piped()).spawn()?;
        child.stdin.take().ok_or(std::io::ErrorKind::BrokenPipe)?.write_all(text.as_bytes())?;
        Ok(child.wait()?.success())
    })()
    .unwrap_or(false);
    status
        .logger
        .event(Stage::App, if copied { "診断情報をコピーしました" } else { "診断情報をコピーできませんでした" });
    shell::notify_page(handle, if copied { "診断情報をコピーしました" } else { "コピーに失敗しました" });
}

/// 失敗画面のボタン。ナビゲーションのコールバックを塞がないよう別スレッドで実行する。
pub fn dispatch(handle: &AppHandle, action: UiAction) {
    let h = handle.clone();
    std::thread::spawn(move || match action {
        UiAction::Retry => {
            h.state::<Arc<Status>>().logger.event(Stage::App, "再試行が選ばれました");
            crate::start_launch(h);
        }
        UiAction::Quit => h.exit(0),
        UiAction::OpenLogs => open_logs(&h),
        UiAction::CopyDiagnostics => copy_diagnostics(&h),
    });
}

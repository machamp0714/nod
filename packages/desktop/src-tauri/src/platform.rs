// 外部効果（プロセス・HTTP・時計・ポート・環境変数・ログ）の境界。
use crate::log::{Logger, Stage};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::mpsc::{channel, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Default)]
pub struct SpawnSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// Some なら環境をこの内容だけにする。None なら自分の環境を引き継ぐ。
    pub env: Option<Vec<(String, String)>>,
    /// 引き継いだ環境（または env）へ重ねる値。
    pub extra_env: Vec<(String, String)>,
    pub cwd: Option<PathBuf>,
    /// 新しいプロセスグループで起動する（孫プロセスごと kill するため）。
    pub new_group: bool,
    /// 標準エラーを自分の標準エラーへ流しつつ、末尾だけ分類用に保持する（false なら捨てる）。
    pub inherit_stderr: bool,
}

impl SpawnSpec {
    fn stderr_is_null(&self) -> bool {
        !self.inherit_stderr
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProcEvent {
    Stdout(Vec<u8>),
    /// 標準出力を読み切り、プロセスが終了した。コードは signal 終了なら None。
    Exited(Option<i32>),
}

pub trait Proc: Send + Sync {
    fn pid(&self) -> u32;
    /// 待たずに次のイベントを返す。
    fn poll(&self) -> Option<ProcEvent>;
    fn is_exited(&self) -> bool;
    fn terminate(&self);
    fn kill(&self);
    /// 以降の標準出力を読み捨てる（パイプを詰まらせず、メモリも使わない）。
    fn discard_output(&self);
    /// 標準エラーの末尾（分類専用。ログにも画面にも載せない）。取得していなければ空。
    fn stderr_tail(&self) -> String {
        String::new()
    }
    /// シグナルで終了した場合のシグナル番号。
    fn exit_signal(&self) -> Option<i32> {
        None
    }
}

/// OS が報告するプロセスの素性。孤児の照合に使う（PID だけでは再利用で別物になりうる）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcInfo {
    /// `ps -o lstart=` の開始時刻（秒単位）。
    pub started: String,
    /// `ps -o comm=` の実行パス。
    pub exe: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Signal {
    Term,
    Kill,
}

/// 標準エラーの保持量。SCHEMA_TOO_NEW などの行を拾えれば足りる。
const STDERR_TAIL_BYTES: usize = 4096;

pub trait Platform: Send + Sync {
    /// 起動からの経過時間。単調増加。
    fn now(&self) -> Duration;
    fn sleep(&self, d: Duration);
    fn spawn(&self, spec: &SpawnSpec) -> Result<Arc<dyn Proc>, String>;
    /// 200 などのステータス。接続できない・応答がなければ None。
    fn http_status(&self, url: &str) -> Option<u16>;
    fn port_is_free(&self, port: u16) -> bool;
    fn var(&self, key: &str) -> Option<String>;
    fn log(&self, msg: &str);
    /// 子ではない PID の素性（孤児の照合用）。存在しなければ None。既定は常に None。
    fn process_info(&self, _pid: u32) -> Option<ProcInfo> {
        None
    }
    /// 子ではない PID へのシグナル（孤児の停止用）。既定は何もしない。
    fn signal_pid(&self, _pid: u32, _sig: Signal) {}
    /// 処理段階つきのログ。既定は段階なしの `log`。
    fn log_at(&self, _stage: Stage, msg: &str) {
        self.log(msg);
    }
}

pub struct RealPlatform {
    start: Instant,
    logger: Option<Arc<Logger>>,
}

impl RealPlatform {
    pub fn new() -> Self {
        Self { start: Instant::now(), logger: None }
    }

    /// ファイルにもログを残す。
    pub fn with_logger(logger: Arc<Logger>) -> Self {
        Self { start: Instant::now(), logger: Some(logger) }
    }
}

impl Default for RealPlatform {
    fn default() -> Self {
        Self::new()
    }
}

impl Platform for RealPlatform {
    fn now(&self) -> Duration {
        self.start.elapsed()
    }
    fn sleep(&self, d: Duration) {
        std::thread::sleep(d);
    }
    fn spawn(&self, spec: &SpawnSpec) -> Result<Arc<dyn Proc>, String> {
        let mut cmd = Command::new(&spec.program);
        cmd.args(&spec.args);
        if let Some(env) = &spec.env {
            cmd.env_clear();
            cmd.envs(env.iter().map(|(k, v)| (k, v)));
        }
        cmd.envs(spec.extra_env.iter().map(|(k, v)| (k, v)));
        if let Some(cwd) = &spec.cwd {
            cmd.current_dir(cwd);
        }
        cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(if spec.inherit_stderr {
            Stdio::piped()
        } else {
            Stdio::null()
        });
        if spec.new_group {
            cmd.process_group(0);
        }
        let mut child = cmd.spawn().map_err(|e| format!("{}: {e}", spec.program.display()))?;
        let pid = child.id();
        let mut stdout = child.stdout.take().ok_or("標準出力を取得できません")?;
        let (tx, rx) = channel();
        let exited = Arc::new(AtomicBool::new(false));
        let discard = Arc::new(AtomicBool::new(false));
        let tail: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        let signal = Arc::new(AtomicI32::new(0));
        let stderr_done = Arc::new(AtomicBool::new(spec.stderr_is_null()));
        if let Some(mut stderr) = child.stderr.take() {
            let (tail, done) = (tail.clone(), stderr_done.clone());
            std::thread::spawn(move || {
                let mut buf = [0u8; 1024];
                loop {
                    match stderr.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let _ = std::io::stderr().write_all(&buf[..n]);
                            let mut t = tail.lock().unwrap_or_else(|e| e.into_inner());
                            t.extend_from_slice(&buf[..n]);
                            if t.len() > STDERR_TAIL_BYTES {
                                let cut = t.len() - STDERR_TAIL_BYTES;
                                t.drain(..cut);
                            }
                        }
                    }
                }
                done.store(true, Ordering::SeqCst);
            });
        }
        {
            let (exited, discard, signal, stderr_done) =
                (exited.clone(), discard.clone(), signal.clone(), stderr_done.clone());
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                loop {
                    match stdout.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if !discard.load(Ordering::SeqCst) {
                                let _ = tx.send(ProcEvent::Stdout(buf[..n].to_vec()));
                            }
                        }
                    }
                }
                let status = child.wait().ok();
                let code = status.and_then(|s| s.code());
                if let Some(sig) = status.and_then(|s| s.signal()) {
                    signal.store(sig, Ordering::SeqCst);
                }
                // 標準エラーの読み切りを（孫が握っていても）短時間だけ待つ。
                for _ in 0..30 {
                    if stderr_done.load(Ordering::SeqCst) {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                exited.store(true, Ordering::SeqCst);
                let _ = tx.send(ProcEvent::Exited(code));
            });
        }
        Ok(Arc::new(RealProc {
            pid,
            group: spec.new_group,
            rx: Mutex::new(rx),
            exited,
            discard,
            tail,
            signal,
        }))
    }
    fn http_status(&self, url: &str) -> Option<u16> {
        http_status(url, Duration::from_secs(1))
    }
    fn port_is_free(&self, port: u16) -> bool {
        TcpListener::bind(("127.0.0.1", port)).is_ok()
    }
    fn var(&self, key: &str) -> Option<String> {
        std::env::var(key).ok()
    }
    fn log(&self, msg: &str) {
        self.log_at(Stage::App, msg);
    }
    fn process_info(&self, pid: u32) -> Option<ProcInfo> {
        // ロケールで書式が変わらないよう C に固定する。出力が取れなければ「存在しない」扱い。
        let ps = |field: &str| -> Option<String> {
            let out = Command::new("/bin/ps")
                .args(["-o", field, "-p", &pid.to_string()])
                .env("LC_ALL", "C")
                .stdin(Stdio::null())
                .stderr(Stdio::null())
                .output()
                .ok()?;
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            (out.status.success() && !s.is_empty()).then_some(s)
        };
        let started = ps("lstart=")?;
        let exe = ps("comm=")?;
        Some(ProcInfo { started, exe })
    }
    fn signal_pid(&self, pid: u32, sig: Signal) {
        let n = match sig {
            Signal::Term => libc::SIGTERM,
            Signal::Kill => libc::SIGKILL,
        };
        if pid > 1 {
            unsafe { libc::kill(pid as i32, n) };
        }
    }
    fn log_at(&self, stage: Stage, msg: &str) {
        eprintln!("nod: {msg}");
        if let Some(l) = &self.logger {
            l.event(stage, msg);
        }
    }
}

struct RealProc {
    pid: u32,
    group: bool,
    rx: Mutex<Receiver<ProcEvent>>,
    exited: Arc<AtomicBool>,
    discard: Arc<AtomicBool>,
    tail: Arc<Mutex<Vec<u8>>>,
    signal: Arc<AtomicI32>,
}

impl Proc for RealProc {
    fn pid(&self) -> u32 {
        self.pid
    }
    fn poll(&self) -> Option<ProcEvent> {
        self.rx.lock().unwrap().try_recv().ok()
    }
    fn is_exited(&self) -> bool {
        self.exited.load(Ordering::SeqCst)
    }
    fn terminate(&self) {
        if !self.is_exited() {
            unsafe { libc::kill(self.pid as i32, libc::SIGTERM) };
        }
    }
    fn kill(&self) {
        // 子が終了済みでも孫が残りうるため、グループには常に送る（回収済みの PID 再利用は
        // グループ起動の場合 pgid が残る間は起きない）。単独 PID は終了済みなら送らない。
        if self.group {
            unsafe { libc::killpg(self.pid as i32, libc::SIGKILL) };
        } else if !self.is_exited() {
            unsafe { libc::kill(self.pid as i32, libc::SIGKILL) };
        }
    }
    fn discard_output(&self) {
        self.discard.store(true, Ordering::SeqCst);
    }
    fn stderr_tail(&self) -> String {
        String::from_utf8_lossy(&self.tail.lock().unwrap_or_else(|e| e.into_inner())).into_owned()
    }
    fn exit_signal(&self) -> Option<i32> {
        match self.signal.load(Ordering::SeqCst) {
            0 => None,
            n => Some(n),
        }
    }
}

/// `http://127.0.0.1:PORT/path` への最小の GET。ステータスコードだけ返す。
pub fn http_status(url: &str, timeout: Duration) -> Option<u16> {
    let rest = url.strip_prefix("http://")?;
    let (hostport, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let addr: SocketAddr = hostport.parse().ok()?;
    let mut s = TcpStream::connect_timeout(&addr, timeout).ok()?;
    s.set_read_timeout(Some(timeout)).ok()?;
    s.set_write_timeout(Some(timeout)).ok()?;
    write!(s, "GET {path} HTTP/1.1\r\nHost: {hostport}\r\nConnection: close\r\n\r\n").ok()?;
    let mut head = Vec::new();
    let mut buf = [0u8; 256];
    while !head.contains(&b'\n') && head.len() < 1024 {
        let n = s.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        head.extend_from_slice(&buf[..n]);
    }
    let line = String::from_utf8_lossy(&head);
    let line = line.lines().next()?;
    let mut parts = line.split_whitespace();
    if !parts.next()?.starts_with("HTTP/") {
        return None;
    }
    parts.next()?.parse().ok()
}

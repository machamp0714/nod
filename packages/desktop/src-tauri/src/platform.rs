// 外部効果（プロセス・HTTP・時計・ポート・環境変数・ログ）の境界。
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
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
    /// 標準エラーを自分の標準エラーへ流す（false なら捨てる）。
    pub inherit_stderr: bool,
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
}

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
}

pub struct RealPlatform {
    start: Instant,
}

impl RealPlatform {
    pub fn new() -> Self {
        Self { start: Instant::now() }
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
            Stdio::inherit()
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
        {
            let (exited, discard) = (exited.clone(), discard.clone());
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
                let code = child.wait().ok().and_then(|s| s.code());
                exited.store(true, Ordering::SeqCst);
                let _ = tx.send(ProcEvent::Exited(code));
            });
        }
        Ok(Arc::new(RealProc { pid, group: spec.new_group, rx: Mutex::new(rx), exited, discard }))
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
        eprintln!("nod: {msg}");
    }
}

struct RealProc {
    pid: u32,
    group: bool,
    rx: Mutex<Receiver<ProcEvent>>,
    exited: Arc<AtomicBool>,
    discard: Arc<AtomicBool>,
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

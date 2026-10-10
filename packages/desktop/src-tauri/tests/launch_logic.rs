// 起動・監督ロジックの振る舞いテスト。プロセス・HTTP・時計・ポートは仮想。
use nod_desktop::*;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

type Clock = Arc<Mutex<Duration>>;
type SpawnFn = Box<dyn Fn(&SpawnSpec, &Clock) -> Result<Arc<dyn Proc>, String> + Send + Sync>;

struct Fake {
    clock: Clock,
    spawned: Mutex<Vec<SpawnSpec>>,
    spawn_fn: SpawnFn,
    /// この時刻以降、/api/workspaces に 200 を返す。None なら応答なし。
    http_ok_after: Mutex<Option<Duration>>,
    /// 200 を返すたびに呼ぶ（世代の切り替えを差し込むため）。
    on_http_ok: Mutex<Option<Box<dyn Fn() + Send>>>,
    free_ports: Vec<u16>,
}

impl Fake {
    fn new(
        free_ports: Vec<u16>,
        f: impl Fn(&SpawnSpec, &Clock) -> Result<Arc<dyn Proc>, String> + Send + Sync + 'static,
    ) -> Fake {
        Fake {
            clock: Arc::new(Mutex::new(Duration::ZERO)),
            spawned: Mutex::new(vec![]),
            spawn_fn: Box::new(f),
            http_ok_after: Mutex::new(None),
            on_http_ok: Mutex::new(None),
            free_ports,
        }
    }
    fn http_ok_from(&self, ms: u64) {
        *self.http_ok_after.lock().unwrap() = Some(Duration::from_millis(ms));
    }
    fn elapsed(&self) -> Duration {
        *self.clock.lock().unwrap()
    }
    fn spawned_args(&self, i: usize) -> Vec<String> {
        self.spawned.lock().unwrap()[i].args.clone()
    }
}

impl Platform for Fake {
    fn now(&self) -> Duration {
        self.elapsed()
    }
    fn sleep(&self, d: Duration) {
        *self.clock.lock().unwrap() += d;
    }
    fn spawn(&self, spec: &SpawnSpec) -> Result<Arc<dyn Proc>, String> {
        self.spawned.lock().unwrap().push(spec.clone());
        (self.spawn_fn)(spec, &self.clock)
    }
    fn http_status(&self, _url: &str) -> Option<u16> {
        match *self.http_ok_after.lock().unwrap() {
            Some(t) if self.elapsed() >= t => {
                if let Some(f) = self.on_http_ok.lock().unwrap().as_ref() {
                    f();
                }
                Some(200)
            }
            _ => None,
        }
    }
    fn port_is_free(&self, port: u16) -> bool {
        self.free_ports.contains(&port)
    }
    fn var(&self, key: &str) -> Option<String> {
        match key {
            "SHELL" => Some("/bin/fakesh".into()),
            "HOME" => Some("/home/u".into()),
            _ => None,
        }
    }
    fn log(&self, _msg: &str) {}
}

/// 指定時刻（ミリ秒）以降にイベントを返す仮想プロセス。
struct FakeProc {
    clock: Clock,
    events: Mutex<VecDeque<(Duration, ProcEvent)>>,
    killed: AtomicBool,
    terminated: AtomicBool,
    exit_on_term: bool,
    exited: AtomicBool,
}

impl FakeProc {
    fn make(clock: &Clock, events: Vec<(u64, ProcEvent)>, exit_on_term: bool) -> Arc<FakeProc> {
        Arc::new(FakeProc {
            clock: clock.clone(),
            events: Mutex::new(events.into_iter().map(|(ms, e)| (Duration::from_millis(ms), e)).collect()),
            killed: AtomicBool::new(false),
            terminated: AtomicBool::new(false),
            exit_on_term,
            exited: AtomicBool::new(false),
        })
    }
    fn new(clock: &Clock, events: Vec<(u64, ProcEvent)>) -> Arc<FakeProc> {
        Self::make(clock, events, true)
    }
}

impl Proc for FakeProc {
    fn pid(&self) -> u32 {
        4242
    }
    fn poll(&self) -> Option<ProcEvent> {
        let now = *self.clock.lock().unwrap();
        let mut q = self.events.lock().unwrap();
        if q.front().map(|(t, _)| *t <= now).unwrap_or(false) {
            let (_, e) = q.pop_front().unwrap();
            if matches!(e, ProcEvent::Exited(_)) {
                self.exited.store(true, Ordering::SeqCst);
            }
            Some(e)
        } else {
            None
        }
    }
    fn is_exited(&self) -> bool {
        self.exited.load(Ordering::SeqCst)
    }
    fn terminate(&self) {
        self.terminated.store(true, Ordering::SeqCst);
        if self.exit_on_term {
            self.exited.store(true, Ordering::SeqCst);
        }
    }
    fn kill(&self) {
        self.killed.store(true, Ordering::SeqCst);
        self.exited.store(true, Ordering::SeqCst);
    }
    fn discard_output(&self) {}
}

fn cfg() -> LaunchConfig {
    LaunchConfig::new(PathBuf::from("/app/nod"), PathBuf::from("/app/web"), "N".into())
}

fn env_output() -> Vec<u8> {
    b"motd noise\n__NOD_ENV_BEGIN_N__HOME=/home/u\0PATH=/opt/homebrew/bin:/usr/bin\0NOD_DB=/x/nod.db\0__NOD_ENV_END_N__trailing\n".to_vec()
}

fn is_shell(spec: &SpawnSpec) -> bool {
    spec.program == Path::new("/bin/fakesh")
}

fn shell_ok(clock: &Clock) -> Arc<dyn Proc> {
    FakeProc::new(clock, vec![(10, ProcEvent::Stdout(env_output())), (10, ProcEvent::Exited(Some(0)))])
}

fn out(s: &str) -> ProcEvent {
    ProcEvent::Stdout(s.as_bytes().to_vec())
}

const URL_LINE: &str = "nod ui: http://127.0.0.1:4700/（DB: /x/nod.db）\n";

type Procs = Arc<Mutex<Vec<Arc<FakeProc>>>>;

/// シェルは正常。sidecar は呼ばれるたびに `sidecar(n)` の結果を返す。
fn with_sidecar(
    free_ports: Vec<u16>,
    sidecar: impl Fn(u32, &Clock) -> Arc<FakeProc> + Send + Sync + 'static,
) -> (Fake, Procs) {
    let procs: Procs = Arc::new(Mutex::new(vec![]));
    let p2 = procs.clone();
    let n = AtomicU32::new(0);
    let fake = Fake::new(free_ports, move |spec, clock| {
        if is_shell(spec) {
            return Ok(shell_ok(clock));
        }
        let p = sidecar(n.fetch_add(1, Ordering::SeqCst), clock);
        p2.lock().unwrap().push(p.clone());
        Ok(p)
    });
    (fake, procs)
}

fn run(p: &Fake, cfg: &LaunchConfig) -> Result<Launched, LaunchError> {
    launch(p, cfg, &|| false, &|_| {})
}

#[test]
fn 環境取得が失敗したら_sidecar_を起動しない() {
    let fake = Fake::new(vec![4700], |spec, clock| {
        assert!(is_shell(spec), "シェル以外は起動しない");
        Ok(FakeProc::new(clock, vec![(5, out("boom")), (5, ProcEvent::Exited(Some(1)))]) as Arc<dyn Proc>)
    });
    assert!(matches!(run(&fake, &cfg()), Err(LaunchError::EnvFailed(_))));
    assert_eq!(fake.spawned.lock().unwrap().len(), 1);
}

#[test]
fn 印が無い出力は失敗として扱う() {
    let fake = Fake::new(vec![4700], |_, clock| {
        Ok(FakeProc::new(clock, vec![(5, out("PATH=/usr/bin\0")), (5, ProcEvent::Exited(Some(0)))]) as Arc<dyn Proc>)
    });
    assert!(matches!(run(&fake, &cfg()), Err(LaunchError::EnvFailed(_))));
    assert_eq!(fake.spawned.lock().unwrap().len(), 1);
}

#[test]
fn 環境取得は_5秒で打ち切りシェルを_kill_する() {
    let shell: Arc<Mutex<Option<Arc<FakeProc>>>> = Arc::new(Mutex::new(None));
    let s = shell.clone();
    let fake = Fake::new(vec![4700], move |spec, clock| {
        assert!(is_shell(spec));
        let p = FakeProc::new(clock, vec![]); // 何も出さず終わらない
        *s.lock().unwrap() = Some(p.clone());
        Ok(p as Arc<dyn Proc>)
    });
    assert_eq!(run(&fake, &cfg()).err(), Some(LaunchError::EnvTimeout));
    assert!(fake.elapsed() >= Duration::from_secs(5) && fake.elapsed() < Duration::from_millis(5200));
    assert!(shell.lock().unwrap().as_ref().unwrap().killed.load(Ordering::SeqCst));
    assert_eq!(fake.spawned.lock().unwrap().len(), 1, "sidecar は起動しない");
}

#[test]
fn シェルの環境が_sidecar_へ渡り_cwd_は_home_で_シェルは_ilc_で起動する() {
    let (fake, _) = with_sidecar(vec![4700], |_, c| FakeProc::new(c, vec![(0, out(URL_LINE))]));
    fake.http_ok_from(0);
    let l = run(&fake, &cfg()).expect("起動できる");
    assert_eq!(l.url, "http://127.0.0.1:4700/");
    let spawned = fake.spawned.lock().unwrap();
    assert_eq!(spawned[0].args[0], "-ilc");
    assert!(spawned[0].args[1].contains("env -0"), "eval ではなく env -0 を使う");
    let side = &spawned[1];
    assert_eq!(side.cwd, Some(PathBuf::from("/home/u")));
    let env = side.env.as_ref().unwrap();
    assert!(env.contains(&("PATH".into(), "/opt/homebrew/bin:/usr/bin".into())));
    assert!(env.contains(&("NOD_DB".into(), "/x/nod.db".into())));
    assert_eq!(&side.args[..4], &["ui", "--port", "4700", "--no-open"]);
}

#[test]
fn 使用中なら最初から空きポートで起動する() {
    let (fake, _) = with_sidecar(vec![], |_, c| {
        FakeProc::new(c, vec![(0, out("nod ui: http://127.0.0.1:51234/（DB: x）\n"))])
    });
    fake.http_ok_from(0);
    let l = run(&fake, &cfg()).unwrap();
    assert_eq!(l.url, "http://127.0.0.1:51234/");
    assert_eq!(fake.spawned.lock().unwrap().len(), 2, "4700 での試行はない");
    assert_eq!(&fake.spawned_args(1)[1..3], &["--port", "0"]);
}

#[test]
fn url_行だけでは完了にならず_15秒で失敗し_kill_する() {
    let (fake, procs) = with_sidecar(vec![4700], |_, c| FakeProc::new(c, vec![(0, out(URL_LINE))]));
    // http は一度も 200 を返さない
    assert_eq!(run(&fake, &cfg()).err(), Some(LaunchError::StartupTimeout { url_seen: true }));
    assert!(fake.elapsed() >= Duration::from_secs(15) && fake.elapsed() < Duration::from_millis(15300));
    assert!(procs.lock().unwrap()[0].killed.load(Ordering::SeqCst));
}

#[test]
fn 二百だけでは完了にならない() {
    let (fake, _) = with_sidecar(vec![4700], |_, c| FakeProc::new(c, vec![]));
    fake.http_ok_from(0); // URL 行が無いまま 200
    assert_eq!(run(&fake, &cfg()).err(), Some(LaunchError::StartupTimeout { url_seen: false }));
}

#[test]
fn url_行と_200_が揃った時点で完了する() {
    let (fake, _) = with_sidecar(vec![4700], |_, c| FakeProc::new(c, vec![(200, out(URL_LINE))]));
    fake.http_ok_from(3000);
    let l = run(&fake, &cfg()).unwrap();
    assert!(fake.elapsed() >= Duration::from_millis(3000) && fake.elapsed() < Duration::from_secs(4));
    assert_eq!(l.port_requested, 4700);
}

#[test]
fn 空きポートでの早期終了はやり直さず失敗する() {
    let (fake, _) = with_sidecar(vec![], |_, c| FakeProc::new(c, vec![(10, ProcEvent::Exited(Some(2)))]));
    assert_eq!(run(&fake, &cfg()).err(), Some(LaunchError::EarlyExit(Some(2))));
    assert_eq!(fake.spawned.lock().unwrap().len(), 2);
}

#[test]
fn 競合で再利用になったら_0_でやり直し_再利用の_url_は採用しない() {
    let (fake, procs) = with_sidecar(vec![4700], |n, c| {
        if n == 0 {
            FakeProc::new(
                c,
                vec![
                    (5, out("すでに起動している nod ui を開きます: http://127.0.0.1:4700/\n")),
                    (6, ProcEvent::Exited(Some(0))),
                ],
            )
        } else {
            FakeProc::new(c, vec![(5, out("nod ui: http://127.0.0.1:50001/（DB: x）\n"))])
        }
    });
    fake.http_ok_from(0);
    let l = run(&fake, &cfg()).unwrap();
    assert_eq!(l.url, "http://127.0.0.1:50001/");
    assert_eq!(&fake.spawned_args(2)[1..3], &["--port", "0"]);
    assert_eq!(procs.lock().unwrap().len(), 2);
}

#[test]
fn 現在の世代の成功は_ready_になる() {
    let (fake, _) = with_sidecar(vec![4700], |_, c| FakeProc::new(c, vec![(0, out(URL_LINE))]));
    fake.http_ok_from(0);
    let sup = Supervisor::new();
    let t = sup.begin_launch().unwrap();
    assert_eq!(run_launch(&fake, &cfg(), &sup, t), LaunchOutcome::Ready("http://127.0.0.1:4700/".into()));
}

#[test]
fn 古い世代の成功通知は捨てられ_sidecar_は止まる() {
    let (fake, procs) = with_sidecar(vec![4700], |_, c| FakeProc::new(c, vec![(0, out(URL_LINE))]));
    fake.http_ok_from(0);
    let sup = Arc::new(Supervisor::new());
    let t1 = sup.begin_launch().unwrap();
    // 200 が返った瞬間に再試行（新しい世代）が始まった状況。
    let s = sup.clone();
    *fake.on_http_ok.lock().unwrap() = Some(Box::new(move || {
        s.begin_launch();
    }));
    assert_eq!(run_launch(&fake, &cfg(), &sup, t1), LaunchOutcome::Discarded);
    let p = procs.lock().unwrap()[0].clone();
    assert!(p.terminated.load(Ordering::SeqCst), "止める");
}

#[test]
fn 終了要求の後の成功通知ではウィンドウを開かない() {
    let (fake, procs) = with_sidecar(vec![4700], |_, c| FakeProc::new(c, vec![(0, out(URL_LINE))]));
    fake.http_ok_from(0);
    let sup = Arc::new(Supervisor::new());
    let t = sup.begin_launch().unwrap();
    let s = sup.clone();
    *fake.on_http_ok.lock().unwrap() = Some(Box::new(move || {
        s.quit();
    }));
    assert_eq!(run_launch(&fake, &cfg(), &sup, t), LaunchOutcome::Discarded);
    assert!(procs.lock().unwrap()[0].terminated.load(Ordering::SeqCst));
    assert!(sup.begin_launch().is_none(), "終了後は起動できない");
}

#[test]
fn 待機中の終了要求は起動を取り消し_登録済みの_sidecar_を_quit_で取り出せる() {
    let (fake, procs) = with_sidecar(vec![4700], |_, c| FakeProc::new(c, vec![(0, out(URL_LINE))])); // 200 は返らない
    let sup = Supervisor::new();
    let t = sup.begin_launch().unwrap();
    // 起動待機の 3 秒後に終了要求が来る（仮想時計で判定）
    let clock = fake.clock.clone();
    let quitted: Mutex<Option<Arc<dyn Proc>>> = Mutex::new(None);
    let r = launch(
        &fake,
        &cfg(),
        &|| {
            if *clock.lock().unwrap() >= Duration::from_secs(3) {
                let mut q = quitted.lock().unwrap();
                if q.is_none() {
                    *q = sup.quit();
                }
            }
            !sup.is_current(t)
        },
        &|p| assert!(sup.register(t, p.clone())),
    );
    assert_eq!(r.err(), Some(LaunchError::Cancelled));
    let proc = quitted.lock().unwrap().take().expect("sidecar が返る");
    stop_process(&fake, proc.as_ref(), STOP_GRACE);
    assert!(procs.lock().unwrap()[0].terminated.load(Ordering::SeqCst) || procs.lock().unwrap()[0].killed.load(Ordering::SeqCst));
}

#[test]
fn 停止は_sigterm_で止まらなければ猶予後に_sigkill() {
    let fake = Fake::new(vec![], |_, _| Err("unused".into()));
    let stubborn = FakeProc::make(&fake.clock, vec![], false);
    stop_process(&fake, stubborn.as_ref(), Duration::from_secs(3));
    assert!(stubborn.terminated.load(Ordering::SeqCst));
    assert!(stubborn.killed.load(Ordering::SeqCst));
    assert!(fake.elapsed() >= Duration::from_secs(3));

    let polite = FakeProc::new(&fake.clock, vec![]);
    let before = fake.elapsed();
    stop_process(&fake, polite.as_ref(), Duration::from_secs(3));
    assert!(polite.terminated.load(Ordering::SeqCst));
    assert!(fake.elapsed() - before < Duration::from_secs(1), "すぐ止まれば待たない");
}

#[test]
fn 環境ブロックの解析はノイズと改行を含む値に耐える() {
    let raw = b"zsh: warning\n<<B>>A=1\0MULTI=l1\nl2\0EMPTY=\0junk\0=bad\0<<E>>bye";
    let v = parse_env_block(raw, "<<B>>", "<<E>>").unwrap();
    assert_eq!(
        v,
        vec![
            ("A".to_string(), "1".to_string()),
            ("MULTI".to_string(), "l1\nl2".to_string()),
            ("EMPTY".to_string(), "".to_string())
        ]
    );
    assert!(parse_env_block(b"<<B>>A=1", "<<B>>", "<<E>>").is_err());
}

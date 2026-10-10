// sidecar の監督（自動再起動・孤児の回収・停止）の振る舞いテスト。
// プロセス・HTTP・時計は仮想。OS のプロセス表（PID・開始時刻・実行パス）も仮想にする。
use nod_desktop::recovery::{Decision, Recovery, RecoveryHooks, RestartCounter};
use nod_desktop::*;
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

type Clock = Arc<Mutex<Duration>>;
type Callback<T> = Box<dyn Fn(T) + Send>;
type SidecarFn = Box<dyn Fn(u32, &Clock) -> Arc<FakeProc> + Send + Sync>;

#[derive(Clone)]
enum OnTerm {
    Exits,
    Ignores,
    /// SIGKILL でも残る（回収できない）。
    Immortal,
    /// 元のプロセスは終わり、同じ PID を別のプロセスが取る（PID 再利用）。
    ReusedBy(ProcInfo),
}

struct Fake {
    clock: Clock,
    spawned: Mutex<Vec<SpawnSpec>>,
    next_sidecar: AtomicU32,
    sidecar_fn: SidecarFn,
    /// OS のプロセス表。
    os: Mutex<HashMap<u32, (ProcInfo, OnTerm)>>,
    signals: Mutex<Vec<(u32, Signal)>>,
    /// 孤児の掃除より前に、環境取得のシェルが起動されたかを見るための記録。
    events: Mutex<Vec<String>>,
}

impl Fake {
    fn new(sidecar: impl Fn(u32, &Clock) -> Arc<FakeProc> + Send + Sync + 'static) -> Arc<Fake> {
        Arc::new(Fake {
            clock: Arc::new(Mutex::new(Duration::ZERO)),
            spawned: Mutex::new(vec![]),
            next_sidecar: AtomicU32::new(0),
            sidecar_fn: Box::new(sidecar),
            os: Mutex::new(HashMap::new()),
            signals: Mutex::new(vec![]),
            events: Mutex::new(vec![]),
        })
    }
    fn elapsed(&self) -> Duration {
        *self.clock.lock().unwrap()
    }
    fn sidecar_spawns(&self) -> usize {
        self.next_sidecar.load(Ordering::SeqCst) as usize
    }
    fn put_process(&self, pid: u32, started: &str, exe: &str, on_term: OnTerm) {
        self.os
            .lock()
            .unwrap()
            .insert(pid, (ProcInfo { started: started.into(), exe: exe.into() }, on_term));
    }
    fn signals(&self) -> Vec<(u32, Signal)> {
        self.signals.lock().unwrap().clone()
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
        if spec.program == Path::new("/bin/fakesh") {
            self.events.lock().unwrap().push("shell".into());
            let out = b"__NOD_ENV_BEGIN_N__HOME=/home/u\0PATH=/usr/bin\0__NOD_ENV_END_N__".to_vec();
            return Ok(FakeProc::with_events(
                &self.clock,
                vec![(10, ProcEvent::Stdout(out)), (10, ProcEvent::Exited(Some(0)))],
                1,
            ));
        }
        let n = self.next_sidecar.fetch_add(1, Ordering::SeqCst);
        self.events.lock().unwrap().push(format!("sidecar{n}"));
        let p = (self.sidecar_fn)(n, &self.clock);
        Ok(p)
    }
    fn http_status(&self, _url: &str) -> Option<u16> {
        Some(200)
    }
    fn port_is_free(&self, port: u16) -> bool {
        port == 4700
    }
    fn var(&self, key: &str) -> Option<String> {
        match key {
            "SHELL" => Some("/bin/fakesh".into()),
            "HOME" => Some("/home/u".into()),
            _ => None,
        }
    }
    fn log(&self, _msg: &str) {}
    fn process_info(&self, pid: u32) -> Option<ProcInfo> {
        self.os.lock().unwrap().get(&pid).map(|(i, _)| i.clone())
    }
    fn signal_pid(&self, pid: u32, sig: Signal) {
        self.signals.lock().unwrap().push((pid, sig));
        let mut os = self.os.lock().unwrap();
        match sig {
            Signal::Kill => {
                if !matches!(os.get(&pid), Some((_, OnTerm::Immortal))) {
                    os.remove(&pid);
                }
            }
            Signal::Term => {
                let Some((_, behavior)) = os.get(&pid).cloned() else { return };
                match behavior {
                    OnTerm::Exits => {
                        os.remove(&pid);
                    }
                    OnTerm::Ignores | OnTerm::Immortal => {}
                    OnTerm::ReusedBy(info) => {
                        os.insert(pid, (info, OnTerm::Ignores));
                    }
                }
            }
        }
    }
}

struct FakeProc {
    pid: u32,
    clock: Clock,
    events: Mutex<VecDeque<(Duration, ProcEvent)>>,
    /// この時刻以降に終了している（起動完了後の異常終了）。
    crash_at: Option<Duration>,
    exited: AtomicBool,
    terminated: AtomicBool,
    killed: AtomicBool,
}

impl FakeProc {
    fn with_events(clock: &Clock, events: Vec<(u64, ProcEvent)>, pid: u32) -> Arc<FakeProc> {
        Arc::new(Self::raw(clock, events, pid))
    }
    fn raw(clock: &Clock, events: Vec<(u64, ProcEvent)>, pid: u32) -> FakeProc {
        FakeProc {
            pid,
            clock: clock.clone(),
            events: Mutex::new(events.into_iter().map(|(ms, e)| (Duration::from_millis(ms), e)).collect()),
            crash_at: None,
            exited: AtomicBool::new(false),
            terminated: AtomicBool::new(false),
            killed: AtomicBool::new(false),
        }
    }
    /// 起動時に URL 行を出し、`crash_after` 後に異常終了する。None なら落ちない。
    fn sidecar(clock: &Clock, port: u16, crash_after: Option<Duration>) -> Arc<FakeProc> {
        let now = *clock.lock().unwrap();
        let line = format!("nod ui: http://127.0.0.1:{port}/（DB: x）\n");
        let mut p = Self::raw(clock, vec![(0, ProcEvent::Stdout(line.into_bytes()))], 5000 + port as u32);
        p.crash_at = crash_after.map(|d| now + d);
        Arc::new(p)
    }
    fn early_exit(clock: &Clock, n: u32) -> Arc<FakeProc> {
        Self::with_events(clock, vec![(10, ProcEvent::Exited(Some(2)))], 6000 + n)
    }
}

impl Proc for FakeProc {
    fn pid(&self) -> u32 {
        self.pid
    }
    fn poll(&self) -> Option<ProcEvent> {
        let now = *self.clock.lock().unwrap();
        let mut q = self.events.lock().unwrap();
        if q.front().map(|(t, _)| *t <= now).unwrap_or(false) {
            let (_, e) = q.pop_front().unwrap();
            if matches!(e, ProcEvent::Exited(_)) {
                self.exited.store(true, Ordering::SeqCst);
            }
            return Some(e);
        }
        None
    }
    fn is_exited(&self) -> bool {
        if let Some(t) = self.crash_at {
            if *self.clock.lock().unwrap() >= t {
                self.exited.store(true, Ordering::SeqCst);
            }
        }
        self.exited.load(Ordering::SeqCst)
    }
    fn terminate(&self) {
        self.terminated.store(true, Ordering::SeqCst);
        self.exited.store(true, Ordering::SeqCst);
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

fn tmpdir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("nod-supervision-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[derive(Default)]
struct Rec {
    restarting: Mutex<Vec<(u64, u32, Duration, Duration)>>,
    recovered: Mutex<Vec<(u64, String)>>,
    gave_up: Mutex<Vec<(u64, Failure)>>,
    clock: Option<Clock>,
    on_restarting: Mutex<Option<Callback<u64>>>,
    on_recovered: Mutex<Option<Callback<usize>>>,
}

impl Rec {
    fn new(clock: &Clock) -> Arc<Rec> {
        Arc::new(Rec { clock: Some(clock.clone()), ..Default::default() })
    }
    fn now(&self) -> Duration {
        *self.clock.as_ref().unwrap().lock().unwrap()
    }
    fn attempts(&self) -> Vec<(u32, Duration)> {
        self.restarting.lock().unwrap().iter().map(|(_, a, d, _)| (*a, *d)).collect()
    }
}

impl RecoveryHooks for Rec {
    fn restarting(&self, token: u64, attempt: u32, delay: Duration) {
        self.restarting.lock().unwrap().push((token, attempt, delay, self.now()));
        if let Some(f) = self.on_restarting.lock().unwrap().as_ref() {
            f(token);
        }
    }
    fn recovered(&self, token: u64, url: &str, _pid: Option<u32>) {
        self.recovered.lock().unwrap().push((token, url.to_string()));
        let n = self.recovered.lock().unwrap().len();
        if let Some(f) = self.on_recovered.lock().unwrap().as_ref() {
            f(n);
        }
    }
    fn gave_up(&self, token: u64, failure: Failure) {
        self.gave_up.lock().unwrap().push((token, failure));
    }
}

const S: fn(u64) -> Duration = Duration::from_secs;

/// 最初の起動を済ませ、監督ループへ入る。
fn start(fake: &Fake, sup: &Supervisor, rec: &Recovery, hooks: &Rec) -> u64 {
    let token = sup.begin_launch().unwrap();
    let cfg = cfg();
    assert!(matches!(run_launch(fake, &cfg, sup, token), LaunchOutcome::Ready(_)));
    recovery::monitor(fake, &cfg, sup, rec, hooks, token);
    token
}

// ---- 数え方（連続失敗） ----

#[test]
fn 連続失敗は_1_2_4_秒の間隔で_3_回まで再起動し_4_回目で諦める() {
    let mut c = RestartCounter::new();
    c.on_ready(S(0));
    assert_eq!(c.on_failure(S(1)), Decision::Restart { attempt: 1, delay: S(1) });
    assert_eq!(c.on_failure(S(2)), Decision::Restart { attempt: 2, delay: S(2) });
    assert_eq!(c.on_failure(S(3)), Decision::Restart { attempt: 3, delay: S(4) });
    assert!(matches!(c.on_failure(S(4)), Decision::GiveUp { .. }));
}

#[test]
fn 手動の再試行で数え方は_0_に戻る() {
    let mut c = RestartCounter::new();
    for _ in 0..3 {
        c.on_failure(S(1));
    }
    assert!(matches!(c.on_failure(S(2)), Decision::GiveUp { .. }));
    c.reset();
    assert_eq!(c.on_failure(S(3)), Decision::Restart { attempt: 1, delay: S(1) });
}

#[test]
fn 起動完了から_10_分安定したら数え方は_0_に戻る_9_分では戻らない() {
    let mut c = RestartCounter::new();
    c.on_failure(S(1));
    c.on_failure(S(2)); // 2 回目
    c.on_ready(S(10));
    // 9 分 59 秒で落ちた: まだ 3 回目
    assert_eq!(c.on_failure(S(10 + 599)), Decision::Restart { attempt: 3, delay: S(4) });

    let mut c = RestartCounter::new();
    c.on_failure(S(1));
    c.on_failure(S(2));
    c.on_ready(S(10));
    // 10 分ちょうどで落ちた: 1 回目から数え直す
    assert_eq!(c.on_failure(S(10 + 600)), Decision::Restart { attempt: 1, delay: S(1) });
}

// ---- 監督ループ ----

#[test]
fn 異常終了すると_1_秒空けて再起動し_新しい_url_で復旧を知らせる() {
    let fake = Fake::new(|n, c| FakeProc::sidecar(c, 4700 + n as u16, if n == 0 { Some(S(5)) } else { None }));
    let (sup, rec) = (Arc::new(Supervisor::new()), Recovery::new());
    let hooks = Rec::new(&fake.clock);
    // 復旧したら終了して、ループを抜ける
    let s = sup.clone();
    *hooks.on_recovered.lock().unwrap() = Some(Box::new(move |_| {
        s.quit();
    }));
    start(&fake, &sup, &rec, &hooks);
    assert_eq!(hooks.attempts(), vec![(1, S(1))]);
    let started_at = hooks.restarting.lock().unwrap()[0].3;
    assert!(started_at >= S(5), "異常終了を検知してから再起動を告げる");
    assert_eq!(hooks.recovered.lock().unwrap()[0].1, "http://127.0.0.1:4701/");
    assert!(fake.elapsed() >= started_at + S(1), "1 秒空けてから起動する");
    assert_eq!(fake.sidecar_spawns(), 2);
    assert!(hooks.gave_up.lock().unwrap().is_empty());
}

#[test]
fn すぐ落ち続けると_3_回再起動して失敗画面へ_4_回目の起動はしない() {
    let fake = Fake::new(|n, c| FakeProc::sidecar(c, 4700 + n as u16, Some(S(1))));
    let (sup, rec) = (Arc::new(Supervisor::new()), Recovery::new());
    let hooks = Rec::new(&fake.clock);
    start(&fake, &sup, &rec, &hooks);
    assert_eq!(hooks.attempts(), vec![(1, S(1)), (2, S(2)), (3, S(4))]);
    assert_eq!(fake.sidecar_spawns(), 4, "最初 + 再起動 3 回");
    let g = hooks.gave_up.lock().unwrap();
    assert_eq!(g.len(), 1);
    assert_eq!(g[0].1.stage, Stage::Running);
}

#[test]
fn 再起動した起動が失敗しても数え_最後の原因を失敗画面へ渡す() {
    let fake = Fake::new(|n, c| {
        if n == 0 {
            FakeProc::sidecar(c, 4700, Some(S(1)))
        } else {
            FakeProc::early_exit(c, n)
        }
    });
    let (sup, rec) = (Arc::new(Supervisor::new()), Recovery::new());
    let hooks = Rec::new(&fake.clock);
    start(&fake, &sup, &rec, &hooks);
    assert_eq!(hooks.attempts().len(), 3);
    let g = hooks.gave_up.lock().unwrap();
    assert_eq!(g[0].1.kind, FailureKind::EarlyExit);
}

#[test]
fn 長く安定して動いた後の異常終了は_回数が戻っているので何度でも復旧できる() {
    let fake = Fake::new(|n, c| FakeProc::sidecar(c, 4700 + n as u16, Some(S(11 * 60))));
    let (sup, rec) = (Arc::new(Supervisor::new()), Recovery::new());
    let hooks = Rec::new(&fake.clock);
    let s = sup.clone();
    *hooks.on_recovered.lock().unwrap() = Some(Box::new(move |n| {
        if n >= 5 {
            s.quit();
        }
    }));
    start(&fake, &sup, &rec, &hooks);
    assert_eq!(hooks.recovered.lock().unwrap().len(), 5);
    assert!(hooks.attempts().iter().all(|(a, d)| *a == 1 && *d == S(1)), "{:?}", hooks.attempts());
    assert!(hooks.gave_up.lock().unwrap().is_empty());
}

#[test]
fn 終了処理中の_sidecar_の終了では再起動しない() {
    let fake = Fake::new(|n, c| FakeProc::sidecar(c, 4700 + n as u16, Some(S(5))));
    let (sup, rec) = (Arc::new(Supervisor::new()), Recovery::new());
    let hooks = Rec::new(&fake.clock);
    // 終了要求と sidecar の終了がほぼ同時に起きる（SIGTERM で止まった sidecar を異常終了と取り違えない）。
    let token = sup.begin_launch().unwrap();
    assert!(matches!(run_launch(&*fake, &cfg(), &sup, token), LaunchOutcome::Ready(_)));
    let proc = sup.quit().expect("登録済み");
    proc.terminate();
    recovery::monitor(&*fake, &cfg(), &sup, &rec, &*hooks, token);
    assert!(hooks.attempts().is_empty());
    assert_eq!(fake.sidecar_spawns(), 1);
    assert!(hooks.gave_up.lock().unwrap().is_empty());
}

#[test]
fn 待機中に手動の再試行が始まったら_古い再起動は起動しない() {
    let fake = Fake::new(|n, c| FakeProc::sidecar(c, 4700 + n as u16, if n == 0 { Some(S(5)) } else { None }));
    let (sup, rec) = (Arc::new(Supervisor::new()), Recovery::new());
    let hooks = Rec::new(&fake.clock);
    let s = sup.clone();
    // 再起動の待機中に、失敗画面などからの再試行（新しい世代）が始まる。
    *hooks.on_restarting.lock().unwrap() = Some(Box::new(move |_| {
        s.begin_launch();
    }));
    start(&fake, &sup, &rec, &hooks);
    assert_eq!(fake.sidecar_spawns(), 1, "古い世代の再起動は何も起動しない");
    assert!(hooks.recovered.lock().unwrap().is_empty());
    assert!(hooks.gave_up.lock().unwrap().is_empty());
}

#[test]
fn 再起動は_get_の再読み込みだけで_書き込みの再送を持たない() {
    // 再起動で起動するのは sidecar だけで、フックが受け取るのは URL のみ（リクエストの内容は渡らない）。
    let fake = Fake::new(|n, c| FakeProc::sidecar(c, 4700 + n as u16, if n == 0 { Some(S(5)) } else { None }));
    let (sup, rec) = (Arc::new(Supervisor::new()), Recovery::new());
    let hooks = Rec::new(&fake.clock);
    let s = sup.clone();
    *hooks.on_recovered.lock().unwrap() = Some(Box::new(move |_| {
        s.quit();
    }));
    start(&fake, &sup, &rec, &hooks);
    let spawned = fake.spawned.lock().unwrap();
    assert!(spawned.iter().all(|s| s.program == Path::new("/bin/fakesh") || s.args[0] == "ui"));
    assert_eq!(hooks.recovered.lock().unwrap()[0].1, "http://127.0.0.1:4701/");
}

// ---- 孤児の回収 ----

fn pidfile_for(dir: &Path, pid: u32, started: &str, exe: &str) -> PathBuf {
    let path = dir.join("sidecar.pid");
    std::fs::write(&path, orphan::PidRecord { pid, started: started.into(), exe: exe.into() }.to_json()).unwrap();
    path
}

const NEVER: &dyn Fn() -> bool = &|| false;

#[test]
fn pid_開始時刻_実行パスが全て一致した孤児だけ_sigterm_で止める() {
    let fake = Fake::new(|_, c| FakeProc::sidecar(c, 4700, None));
    fake.put_process(777, "Sat Oct 10 10:00:00 2026", "/Applications/nod.app/Contents/MacOS/nod", OnTerm::Exits);
    let dir = tmpdir("match");
    let path = pidfile_for(&dir, 777, "Sat Oct 10 10:00:00 2026", "/Applications/nod.app/Contents/MacOS/nod");
    assert_eq!(orphan::reclaim_orphan(&*fake, &path, NEVER), orphan::Reclaim::Stopped);
    assert_eq!(fake.signals(), vec![(777, Signal::Term)]);
    assert!(!path.exists(), "回収したら pidfile は消す");
}

#[test]
fn 開始時刻か実行パスが違えば_pid_が同じでも止めない() {
    for (started, exe) in [
        ("Sun Oct 11 09:00:00 2026", "/Applications/nod.app/Contents/MacOS/nod"), // PID 再利用（別の時刻）
        ("Sat Oct 10 10:00:00 2026", "/usr/bin/vim"),                              // 別のプログラム
    ] {
        let fake = Fake::new(|_, c| FakeProc::sidecar(c, 4700, None));
        fake.put_process(777, started, exe, OnTerm::Exits);
        let dir = tmpdir("mismatch");
        let path = pidfile_for(&dir, 777, "Sat Oct 10 10:00:00 2026", "/Applications/nod.app/Contents/MacOS/nod");
        assert_eq!(orphan::reclaim_orphan(&*fake, &path, NEVER), orphan::Reclaim::Mismatch);
        assert!(fake.signals().is_empty(), "不一致の PID にはシグナルを送らない");
        assert!(fake.process_info(777).is_some());
    }
}

#[test]
fn プロセスが無ければ何もせず_pidfile_が無くても何もしない() {
    let fake = Fake::new(|_, c| FakeProc::sidecar(c, 4700, None));
    let dir = tmpdir("gone");
    let path = pidfile_for(&dir, 999, "x", "y");
    assert_eq!(orphan::reclaim_orphan(&*fake, &path, NEVER), orphan::Reclaim::Gone);
    assert_eq!(orphan::reclaim_orphan(&*fake, &dir.join("none.pid"), NEVER), orphan::Reclaim::NoRecord);
    // 壊れた pidfile は何も止めない
    std::fs::write(dir.join("bad.pid"), "{not json").unwrap();
    assert_eq!(orphan::reclaim_orphan(&*fake, &dir.join("bad.pid"), NEVER), orphan::Reclaim::NoRecord);
    assert!(fake.signals().is_empty());
}

#[test]
fn sigterm_で止まらない孤児は_再照合して一致するときだけ_sigkill() {
    let fake = Fake::new(|_, c| FakeProc::sidecar(c, 4700, None));
    fake.put_process(777, "t", "/x/nod", OnTerm::Ignores);
    let dir = tmpdir("stubborn");
    let path = pidfile_for(&dir, 777, "t", "/x/nod");
    assert_eq!(orphan::reclaim_orphan(&*fake, &path, NEVER), orphan::Reclaim::Stopped);
    assert_eq!(fake.signals(), vec![(777, Signal::Term), (777, Signal::Kill)]);
    assert!(fake.elapsed() >= orphan::ORPHAN_TERM_WAIT);

    // SIGTERM の後に同じ PID を別のプロセスが取った: SIGKILL は送らない
    let fake = Fake::new(|_, c| FakeProc::sidecar(c, 4700, None));
    fake.put_process(
        777,
        "t",
        "/x/nod",
        OnTerm::ReusedBy(ProcInfo { started: "later".into(), exe: "/usr/bin/other".into() }),
    );
    let path = pidfile_for(&dir, 777, "t", "/x/nod");
    assert_eq!(orphan::reclaim_orphan(&*fake, &path, NEVER), orphan::Reclaim::Stopped);
    assert_eq!(fake.signals(), vec![(777, Signal::Term)]);
    assert!(fake.process_info(777).is_some(), "別のプロセスは残る");
}

#[test]
fn 起動は孤児の回収の後_環境取得の前に行い_回収できなければ起動しない() {
    let fake = Fake::new(|_, c| FakeProc::sidecar(c, 4700, None));
    fake.put_process(777, "t", "/x/nod", OnTerm::Exits);
    let dir = tmpdir("launch-order");
    let mut c = cfg();
    c.pidfile = Some(pidfile_for(&dir, 777, "t", "/x/nod"));
    let l = launch(&*fake, &c, &|| false, &|_| {}).expect("起動できる");
    assert_eq!(fake.signals(), vec![(777, Signal::Term)]);
    assert_eq!(fake.events.lock().unwrap()[0], "shell");
    assert_eq!(l.url, "http://127.0.0.1:4700/");
    // pidfile は起動成功時に、起動した sidecar の記録へ書き換わる
    fake.put_process(l.proc.pid(), "t2", "/x/nod", OnTerm::Exits);
    let _ = std::fs::remove_file(c.pidfile.as_ref().unwrap());
    let l2 = launch(&*fake, &c, &|| false, &|_| {});
    assert!(l2.is_ok());

}

#[test]
fn 孤児を止められなければ_sidecar_もシェルも起動しない() {
    let fake = Fake::new(|_, c| FakeProc::sidecar(c, 4700, None));
    fake.put_process(888, "t", "/x/nod", OnTerm::Immortal);
    let dir = tmpdir("immortal");
    let mut c = cfg();
    c.pidfile = Some(pidfile_for(&dir, 888, "t", "/x/nod"));
    let r = launch(&*fake, &c, &|| false, &|_| {});
    assert_eq!(r.err(), Some(LaunchError::OrphanAlive));
    assert!(fake.spawned.lock().unwrap().is_empty());
    assert_eq!(fake.signals(), vec![(888, Signal::Term), (888, Signal::Kill)]);
}

#[test]
fn 起動成功で_pidfile_を書き_正常停止で消す() {
    let fake = Fake::new(|_, c| FakeProc::sidecar(c, 4700, None));
    let dir = tmpdir("pidfile");
    let mut c = cfg();
    let path = dir.join("sidecar.pid");
    c.pidfile = Some(path.clone());
    // sidecar の pid は 5000 + port。OS の表にも載せる。
    fake.put_process(9700, "Sat Oct 10 10:00:00 2026", "/app/nod", OnTerm::Exits);
    let l = launch(&*fake, &c, &|| false, &|_| {}).unwrap();
    assert_eq!(l.proc.pid(), 9700);
    let rec = orphan::read_pidfile(&path).expect("書かれている");
    assert_eq!(
        rec,
        orphan::PidRecord { pid: 9700, started: "Sat Oct 10 10:00:00 2026".into(), exe: "/app/nod".into() }
    );
    orphan::stop_sidecar(&*fake, l.proc.as_ref(), STOP_GRACE, Some(&path));
    assert!(!path.exists());
}

#[test]
fn 起動完了の前に_pidfile_を書き_失敗したら消す() {
    // 起動完了を待つ間にアプリが強制終了しても、次回起動で回収できるようにする。
    let fake = Fake::new(|_, c| FakeProc::with_events(c, vec![], 7000));
    fake.put_process(7000, "Sat Oct 10 10:00:00 2026", "/app/nod", OnTerm::Exits);
    let dir = tmpdir("pidfile-early");
    let mut c = cfg();
    let path = dir.join("sidecar.pid");
    c.pidfile = Some(path.clone());
    let seen = std::cell::Cell::new(false);
    let r = launch(&*fake, &c, &|| {
        // spawn の後で、起動完了の前（URL 行なし）に pidfile が見えたら中断する
        let exists = path.exists();
        seen.set(seen.get() || exists);
        exists
    }, &|_| {});
    assert_eq!(r.err(), Some(LaunchError::Cancelled));
    assert!(seen.get(), "起動完了の前に pidfile が書かれている");
    assert!(!path.exists(), "失敗して止めたら消す");
}

#[test]
fn spawn_直後に_pidfile_を書けなくても_起動完了の前にもう一度書く() {
    // spawn 直後は ps が情報を返さない（OS の表に無い）。起動完了までに現れたら書く。
    let fake = Fake::new(|_, c| FakeProc::sidecar(c, 4700, None));
    let dir = tmpdir("pidfile-retry");
    let mut c = cfg();
    let path = dir.join("sidecar.pid");
    c.pidfile = Some(path.clone());
    let calls_after_spawn = std::cell::Cell::new(0);
    let f = fake.clone();
    let l = launch(&*fake, &c, &|| {
        if !f.spawned.lock().unwrap().is_empty() {
            calls_after_spawn.set(calls_after_spawn.get() + 1);
            // 1 回目は spawn 直後の書き込みの前の確認。2 回目（ループの先頭）で現れる
            if calls_after_spawn.get() == 2 {
                f.put_process(9700, "Sat Oct 10 10:00:00 2026", "/app/nod", OnTerm::Exits);
            }
        }
        false
    }, &|_| {})
    .unwrap();
    assert_eq!(l.proc.pid(), 9700);
    assert!(orphan::read_pidfile(&path).is_some_and(|r| r.pid == 9700), "完了の前に書き直されている");
}

#[test]
fn 環境取得中の終了要求ではシェルも停止対象として取り出せる() {
    // シェルが終わらない。起動待機中に Cmd+Q が来て、アプリが先に終わっても孤児にしないため。
    let fake = Fake::new(|_, c| FakeProc::sidecar(c, 4700, None));
    struct HangShell(Arc<Fake>);
    impl Platform for HangShell {
        fn now(&self) -> Duration {
            self.0.now()
        }
        fn sleep(&self, d: Duration) {
            self.0.sleep(d)
        }
        fn spawn(&self, _s: &SpawnSpec) -> Result<Arc<dyn Proc>, String> {
            Ok(FakeProc::with_events(&self.0.clock, vec![], 1234))
        }
        fn http_status(&self, _u: &str) -> Option<u16> {
            None
        }
        fn port_is_free(&self, _p: u16) -> bool {
            true
        }
        fn var(&self, _k: &str) -> Option<String> {
            Some("/bin/fakesh".into())
        }
        fn log(&self, _m: &str) {}
    }
    let p = HangShell(fake.clone());
    let sup = Supervisor::new();
    let t = sup.begin_launch().unwrap();
    let clock = fake.clock.clone();
    let taken: Mutex<Option<Arc<dyn Proc>>> = Mutex::new(None);
    let r = launch(
        &p,
        &cfg(),
        &|| {
            if *clock.lock().unwrap() >= S(1) {
                let mut q = taken.lock().unwrap();
                if q.is_none() {
                    *q = sup.quit();
                }
            }
            !sup.is_current(t)
        },
        &|proc| {
            sup.register(t, proc.clone());
        },
    );
    assert_eq!(r.err(), Some(LaunchError::Cancelled));
    let shell = taken.lock().unwrap().take().expect("環境取得中のシェルが停止対象に入っている");
    assert_eq!(shell.pid(), 1234);
}

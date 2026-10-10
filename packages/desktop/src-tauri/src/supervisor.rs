// 起動の世代管理と停止。ウィンドウ操作を持たないので、Tauri なしでテストできる。
use crate::launch::{launch, LaunchConfig, LaunchError};
use crate::platform::{Platform, Proc};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// SIGTERM 後に SIGKILL へ切り替えるまでの待機。
pub const STOP_GRACE: Duration = Duration::from_secs(3);

struct Inner {
    generation: u64,
    quitting: bool,
    current: Option<Arc<dyn Proc>>,
}

pub struct Supervisor {
    inner: Mutex<Inner>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum LaunchOutcome {
    /// この世代の起動が完了した。ウィンドウを開いてよい。
    Ready(String),
    /// 終了・再試行などで世代が古くなった。成功していても何も開かない。
    Discarded,
    Failed(LaunchError),
}

impl Default for Supervisor {
    fn default() -> Self {
        Self::new()
    }
}

impl Supervisor {
    pub fn new() -> Self {
        Self { inner: Mutex::new(Inner { generation: 0, quitting: false, current: None }) }
    }

    /// 新しい起動の世代番号を発行する。以前の世代は無効になる。終了後は None。
    pub fn begin_launch(&self) -> Option<u64> {
        let mut g = self.inner.lock().unwrap();
        if g.quitting {
            return None;
        }
        g.generation += 1;
        Some(g.generation)
    }

    pub fn is_current(&self, token: u64) -> bool {
        let g = self.inner.lock().unwrap();
        !g.quitting && g.generation == token
    }

    /// 起動した sidecar を登録する。世代が古ければ false（呼び出し側が止める）。
    pub fn register(&self, token: u64, proc: Arc<dyn Proc>) -> bool {
        let mut g = self.inner.lock().unwrap();
        if g.quitting || g.generation != token {
            return false;
        }
        g.current = Some(proc);
        true
    }

    /// 終了要求。以降の起動はすべて無効になる。停止すべき sidecar を返す。
    pub fn quit(&self) -> Option<Arc<dyn Proc>> {
        let mut g = self.inner.lock().unwrap();
        g.quitting = true;
        g.generation += 1;
        g.current.take()
    }

    pub fn quitting(&self) -> bool {
        self.inner.lock().unwrap().quitting
    }
}

/// SIGTERM を送り、grace の間だけ停止を待ち、残っていれば SIGKILL する。
/// Task 7 で待機時間や登録順を調整する際はここだけを変える。
pub fn stop_process(p: &dyn Platform, proc: &dyn Proc, grace: Duration) {
    if proc.is_exited() {
        proc.kill(); // グループに孫が残っていれば片付ける
        return;
    }
    p.log(&format!("sidecar に SIGTERM を送ります（pid {}）", proc.pid()));
    proc.terminate();
    let deadline = p.now() + grace;
    while !proc.is_exited() && p.now() < deadline {
        p.sleep(Duration::from_millis(25));
    }
    if !proc.is_exited() {
        p.log(&format!("sidecar が止まらないため SIGKILL を送ります（pid {}）", proc.pid()));
    }
    proc.kill();
}

/// 1 回の起動を実行し、世代が古ければ成功しても Discarded にして sidecar を止める。
pub fn run_launch(
    p: &dyn Platform,
    cfg: &LaunchConfig,
    sup: &Supervisor,
    token: u64,
) -> LaunchOutcome {
    let cancel = || !sup.is_current(token);
    let on_spawn = |proc: &Arc<dyn Proc>| {
        if !sup.register(token, proc.clone()) {
            proc.kill();
        }
    };
    match launch(p, cfg, &cancel, &on_spawn) {
        Ok(l) => {
            if sup.is_current(token) {
                LaunchOutcome::Ready(l.url)
            } else {
                stop_process(p, l.proc.as_ref(), STOP_GRACE);
                LaunchOutcome::Discarded
            }
        }
        Err(LaunchError::Cancelled) => LaunchOutcome::Discarded,
        Err(_) if !sup.is_current(token) => LaunchOutcome::Discarded,
        Err(e) => LaunchOutcome::Failed(e),
    }
}

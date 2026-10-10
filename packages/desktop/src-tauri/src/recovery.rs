// 稼働中の sidecar の異常終了からの自動復旧。
//
// 方針:
// - 終了処理中（quitting）や、手動の再試行・終了で世代が変わった後は、何もしない。
// - 再起動は 1 秒・2 秒・4 秒の間隔で最大 3 回。数え方は連続失敗で、手動の再試行で 0、
//   起動完了から 10 分安定して動いたら 0 に戻る。再起動した起動が失敗した場合も 1 回に数える。
// - 再起動は「sidecar を起動し直し、WebView を新しい URL（GET）へ遷移させる」だけで、
//   何も再送しない。結果が不明な書き込み（POST など）を自動で再送しないための実装であり、
//   未保存の入力は保証しない。
use crate::failure::{self, Failure};
use crate::launch::{LaunchConfig, LaunchError};
use crate::log::Stage;
use crate::orphan;
use crate::platform::{Platform, Proc};
use crate::supervisor::{run_launch, LaunchOutcome, Supervisor};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const RESTART_BACKOFF: [Duration; 3] =
    [Duration::from_secs(1), Duration::from_secs(2), Duration::from_secs(4)];
/// この時間、起動完了のまま動き続けたら、失敗の数を 0 に戻す。設計上の値（実測ではない）。
pub const STABLE_AFTER: Duration = Duration::from_secs(10 * 60);
const WATCH_INTERVAL: Duration = Duration::from_millis(200);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Restart { attempt: u32, delay: Duration },
    GiveUp { failures: u32 },
}

#[derive(Debug, Default)]
pub struct RestartCounter {
    failures: u32,
    ready_at: Option<Duration>,
}

impl RestartCounter {
    pub fn new() -> Self {
        Self::default()
    }

    /// 起動が完了した時刻。
    pub fn on_ready(&mut self, now: Duration) {
        self.ready_at = Some(now);
    }

    /// 手動の再試行。数え直す。
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// 稼働中の異常終了、または再起動した起動の失敗。
    pub fn on_failure(&mut self, now: Duration) -> Decision {
        if let Some(t) = self.ready_at.take() {
            if now.saturating_sub(t) >= STABLE_AFTER {
                self.failures = 0;
            }
        }
        self.failures += 1;
        match RESTART_BACKOFF.get(self.failures as usize - 1) {
            Some(d) => Decision::Restart { attempt: self.failures, delay: *d },
            None => Decision::GiveUp { failures: self.failures },
        }
    }
}

/// アプリ全体で共有する数え方。
#[derive(Default)]
pub struct Recovery(Mutex<RestartCounter>);

impl Recovery {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn reset(&self) {
        self.lock().reset();
    }
    fn lock(&self) -> std::sync::MutexGuard<'_, RestartCounter> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// 復旧の経過をウィンドウ側へ伝える。実装はメインスレッドへ回すなどして世代を再確認する。
pub trait RecoveryHooks: Send + Sync {
    /// 再起動を始める（`delay` の待機を含む）。`token` はこの再起動の世代。起動中の画面を出す。
    fn restarting(&self, token: u64, attempt: u32, delay: Duration);
    /// 再起動に成功した。新しい URL へ遷移させる。
    fn recovered(&self, token: u64, url: &str, pid: Option<u32>);
    /// 上限を超えた。失敗画面を出す。
    fn gave_up(&self, token: u64, failure: Failure);
}

/// 起動完了済みの sidecar（`token` の世代、Supervisor に登録済み）を監督する。
/// 世代が変わる（終了・再試行）か、復旧を諦めるまで戻らない。専用スレッドで呼ぶ。
pub fn monitor(
    p: &dyn Platform,
    cfg: &LaunchConfig,
    sup: &Supervisor,
    rec: &Recovery,
    hooks: &dyn RecoveryHooks,
    token: u64,
) {
    let Some(first) = sup.current() else { return };
    let mut token = token;
    let mut proc: Option<Arc<dyn Proc>> = Some(first);
    let mut cause: Option<LaunchError> = None;
    rec.lock().on_ready(p.now());

    loop {
        // 1. 稼働中の監視。世代が変われば（終了・再試行）、予期した停止なので何もしない。
        if let Some(pr) = &proc {
            while sup.is_current(token) && !pr.is_exited() {
                p.sleep(WATCH_INTERVAL);
            }
        }
        if !sup.is_current(token) {
            return;
        }
        if let Some(pr) = proc.take() {
            p.log_at(
                Stage::Running,
                &format!(
                    "sidecar が予期せず終了しました（pid {}、シグナル {:?}）",
                    pr.pid(),
                    pr.exit_signal()
                ),
            );
            pr.kill(); // プロセスグループに孫が残っていれば片付ける
            if let Some(path) = &cfg.pidfile {
                orphan::forget(path, pr.pid());
            }
        }

        // 2. 再起動するか諦めるか。
        let decision = rec.lock().on_failure(p.now());
        let (attempt, delay) = match decision {
            Decision::GiveUp { failures } => {
                p.log_at(
                    Stage::Running,
                    &format!("自動の再起動の上限を超えたため、失敗画面を出します（連続 {failures} 回）"),
                );
                let f = cause.take().map(|e| failure::classify(&e)).unwrap_or_else(failure::crashed);
                hooks.gave_up(token, f);
                return;
            }
            Decision::Restart { attempt, delay } => (attempt, delay),
        };
        // 新しい世代を先に取り、古い世代の通知を無効にする。以降、手動の再試行が来ればこの世代が古くなる。
        let Some(next) = sup.begin_launch() else { return };
        token = next;
        p.log_at(
            Stage::Running,
            &format!("sidecar を {} 秒後に再起動します（{attempt} / {}）", delay.as_secs(), RESTART_BACKOFF.len()),
        );
        hooks.restarting(token, attempt, delay);
        let until = p.now() + delay;
        while p.now() < until && sup.is_current(token) {
            p.sleep(WATCH_INTERVAL.min(until.saturating_sub(p.now())));
        }
        if !sup.is_current(token) {
            return;
        }

        // 3. 再起動。成功したら監視に戻り、失敗したらもう 1 回数える。
        match run_launch(p, cfg, sup, token) {
            LaunchOutcome::Ready(url) => {
                let Some(pr) = sup.current() else { return };
                rec.lock().on_ready(p.now());
                cause = None;
                p.log_at(Stage::Running, &format!("sidecar の再起動に成功しました（{url}、pid {}）", pr.pid()));
                hooks.recovered(token, &url, Some(pr.pid()));
                proc = Some(pr);
            }
            LaunchOutcome::Discarded => return,
            LaunchOutcome::Failed(e) => {
                p.log_at(Stage::Running, &format!("sidecar の再起動に失敗しました（{e}）"));
                cause = Some(e);
            }
        }
    }
}

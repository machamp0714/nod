// sidecar の pidfile と、前回の孤児の回収。
// アプリが強制終了されると sidecar が残り、次回の起動で DB を二つのサーバーが握りかねない。
// PID だけで止めると、PID の再利用で無関係なプロセスを止める。そのため pidfile に
// 「PID・開始時刻・実行パス」を記録し、3 つがすべて一致した場合だけ止める。
use crate::log::Stage;
use crate::platform::{Platform, Proc, Signal};
use crate::supervisor::stop_process;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Duration;

pub const PIDFILE_NAME: &str = "sidecar.pid";
/// SIGTERM を送ってから、停止を待つ上限。
pub const ORPHAN_TERM_WAIT: Duration = Duration::from_secs(5);
/// SIGKILL を送ってから、停止を確かめる上限。
pub const ORPHAN_KILL_WAIT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PidRecord {
    pub pid: u32,
    pub started: String,
    pub exe: String,
}

impl PidRecord {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

pub fn read_pidfile(path: &Path) -> Option<PidRecord> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// 起動した sidecar の素性を OS から取得して記録する。取得できなければ書かない（false）。
pub fn write_pidfile(p: &dyn Platform, path: &Path, pid: u32) -> bool {
    let Some(info) = p.process_info(pid) else { return false };
    let rec = PidRecord { pid, started: info.started, exe: info.exe };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let tmp = path.with_extension("pid.tmp");
    std::fs::write(&tmp, rec.to_json()).and_then(|_| std::fs::rename(&tmp, path)).is_ok()
}

fn remove_if_pid(path: &Path, pid: u32) {
    if read_pidfile(path).is_some_and(|r| r.pid == pid) {
        let _ = std::fs::remove_file(path);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reclaim {
    /// pidfile が無い、または読めない。
    NoRecord,
    /// 記録の PID のプロセスはもう無い。
    Gone,
    /// PID はあるが開始時刻か実行パスが違う（PID 再利用など）。止めない。
    Mismatch,
    /// 一致した孤児を止めた。
    Stopped,
    /// 一致した孤児を止められなかった。
    Stuck,
    Cancelled,
}

fn matches(p: &dyn Platform, rec: &PidRecord) -> bool {
    p.process_info(rec.pid).is_some_and(|i| i.started == rec.started && i.exe == rec.exe)
}

fn wait_gone(p: &dyn Platform, rec: &PidRecord, limit: Duration, cancel: &dyn Fn() -> bool) -> Option<bool> {
    let deadline = p.now() + limit;
    while p.now() < deadline {
        if !matches(p, rec) {
            return Some(true);
        }
        if cancel() {
            return None;
        }
        p.sleep(Duration::from_millis(50));
    }
    Some(!matches(p, rec))
}

/// pidfile の記録が現在のプロセスと完全に一致するときだけ、SIGTERM（残れば再照合の上 SIGKILL）で止める。
pub fn reclaim_orphan(p: &dyn Platform, path: &Path, cancel: &dyn Fn() -> bool) -> Reclaim {
    let Some(rec) = read_pidfile(path) else { return Reclaim::NoRecord };
    if p.process_info(rec.pid).is_none() {
        p.log_at(Stage::Startup, &format!("前回の sidecar の記録（pid {}）は、すでに終了しています", rec.pid));
        let _ = std::fs::remove_file(path);
        return Reclaim::Gone;
    }
    if !matches(p, &rec) {
        p.log_at(
            Stage::Startup,
            &format!("pid {} は前回の sidecar と開始時刻または実行パスが違うため、止めません（PID の再利用）", rec.pid),
        );
        let _ = std::fs::remove_file(path);
        return Reclaim::Mismatch;
    }
    p.log_at(Stage::Startup, &format!("前回の sidecar（pid {}）が残っているため、SIGTERM で停止します", rec.pid));
    p.signal_pid(rec.pid, Signal::Term);
    match wait_gone(p, &rec, ORPHAN_TERM_WAIT, cancel) {
        None => return Reclaim::Cancelled,
        Some(true) => {
            let _ = std::fs::remove_file(path);
            p.log_at(Stage::Startup, "前回の sidecar を停止しました");
            return Reclaim::Stopped;
        }
        Some(false) => {}
    }
    // SIGKILL の直前に、まだ同じプロセスかを再照合する（待機中に PID が再利用されうる）。
    if !matches(p, &rec) {
        let _ = std::fs::remove_file(path);
        return Reclaim::Stopped;
    }
    p.log_at(Stage::Startup, &format!("前回の sidecar が止まらないため SIGKILL を送ります（pid {}）", rec.pid));
    p.signal_pid(rec.pid, Signal::Kill);
    match wait_gone(p, &rec, ORPHAN_KILL_WAIT, cancel) {
        None => Reclaim::Cancelled,
        Some(true) => {
            let _ = std::fs::remove_file(path);
            Reclaim::Stopped
        }
        Some(false) => {
            p.log_at(Stage::Startup, &format!("前回の sidecar（pid {}）を停止できませんでした", rec.pid));
            Reclaim::Stuck
        }
    }
}

/// 自分が起動した sidecar を止め（SIGTERM → grace → SIGKILL）、正常に止まったら pidfile を消す。
pub fn stop_sidecar(p: &dyn Platform, proc: &dyn Proc, grace: Duration, pidfile: Option<&Path>) {
    stop_process(p, proc, grace);
    if let Some(path) = pidfile {
        if proc.is_exited() {
            remove_if_pid(path, proc.pid());
        }
    }
}

/// 異常終了した sidecar の記録を消す（次の起動で誤って照合しないため）。
pub fn forget(path: &Path, pid: u32) {
    remove_if_pid(path, pid);
}

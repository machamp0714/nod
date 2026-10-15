//! ネイティブ通知の接続境界。未完了のクリック遷移をsidecarの復旧後にも保持する。
use serde::{Deserialize, Serialize};
use std::{sync::{Arc, Condvar, Mutex}, thread::JoinHandle, time::Duration};

pub const POLL_INTERVAL: Duration = Duration::from_secs(1);
#[derive(Default)]
struct Signal { stopped: bool, wake: bool }
pub struct DeliveryWorker {
    signal: Arc<(Mutex<Signal>, Condvar)>,
    thread: Mutex<Option<JoinHandle<()>>>,
}
impl DeliveryWorker {
    pub fn start(mut poll: impl FnMut() + Send + 'static) -> Self {
        let signal = Arc::new((Mutex::new(Signal::default()), Condvar::new()));
        let control = signal.clone();
        let thread = std::thread::spawn(move || loop {
            if control.0.lock().unwrap().stopped { break; }
            poll();
            let guard = control.0.lock().unwrap();
            let (mut guard, _) = control.1.wait_timeout_while(guard, POLL_INTERVAL, |s| !s.stopped && !s.wake).unwrap();
            if guard.stopped { break; }
            guard.wake = false;
        });
        Self { signal, thread: Mutex::new(Some(thread)) }
    }
    pub fn wake(&self) {
        self.signal.0.lock().unwrap().wake = true;
        self.signal.1.notify_all();
    }
    pub fn stop(&self) {
        self.signal.0.lock().unwrap().stopped = true;
        self.signal.1.notify_all();
        if let Some(thread) = self.thread.lock().unwrap().take() { let _ = thread.join(); }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Pending { pub issue_id: String, pub notification_id: u64 }

#[derive(Default)]
pub struct Navigation { port: u16, navigating: Option<(Pending, u16)> }
impl Navigation {
    pub fn connected(&mut self, port: u16) { self.port = port; self.reset(); }
    pub fn reset(&mut self) { self.navigating = None; }
    pub fn destination(&mut self, pending: &Pending) -> Option<String> {
        if self.port == 0 || self.navigating.as_ref() == Some(&(pending.clone(), self.port)) { return None; }
        self.navigating = Some((pending.clone(), self.port));
        Some(format!("http://127.0.0.1:{}/issues/{}", self.port, pending.issue_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 同じポートの復旧でも未完了のクリックを再遷移し周期内では繰り返さない() {
        let pending = Pending { issue_id: "API-12".into(), notification_id: 8 };
        let mut navigation = Navigation::default();
        assert_eq!(navigation.destination(&pending), None);
        navigation.connected(59123);
        assert_eq!(navigation.destination(&pending).as_deref(), Some("http://127.0.0.1:59123/issues/API-12"));
        assert_eq!(navigation.destination(&pending), None);
        // 復旧中の画面に戻ってから、同じポートのsidecarへ接続し直す。
        navigation.connected(0);
        assert_eq!(navigation.destination(&pending), None);
        navigation.connected(59123);
        assert_eq!(navigation.destination(&pending).as_deref(), Some("http://127.0.0.1:59123/issues/API-12"));
        assert_eq!(navigation.destination(&pending), None);
        navigation.connected(59124);
        assert_eq!(navigation.destination(&pending).as_deref(), Some("http://127.0.0.1:59124/issues/API-12"));
    }

    #[test]
    fn 復帰は同じ配信workerを起こし終了後は再起動しない() {
        use std::{sync::mpsc, time::Duration};
        let (sent, received) = mpsc::channel();
        let worker = DeliveryWorker::start(move || { sent.send(()).unwrap(); });
        received.recv_timeout(Duration::from_secs(5)).unwrap();
        for _ in 0..3 {
            worker.wake();
            received.recv_timeout(Duration::from_secs(5)).unwrap();
        }
        worker.stop();
        worker.stop();
        worker.wake();
        assert_eq!(received.try_recv(), Err(mpsc::TryRecvError::Disconnected));
    }
}

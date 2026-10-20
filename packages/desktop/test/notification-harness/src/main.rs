//! 実DB・HTTP契約を通す統合テスト専用の偽OS受け口。
use std::{io::BufRead, sync::{Arc, Mutex}, time::Duration};
#[path = "../../../src-tauri/src/notification_delivery.rs"]
mod notification_delivery;
#[path = "../../../src-tauri/src/notification_runtime.rs"]
mod notification_runtime;
use notification_delivery::{tick, HttpSource, Notification, Os};
use std::sync::atomic::{AtomicBool, Ordering};
static QUITTING: AtomicBool = AtomicBool::new(false);
struct FakeOs { received: Mutex<Vec<Notification>>, mode: String }
impl Os for FakeOs {
    fn permission(&self) -> Result<String, String> {
        match self.mode.as_str() {
            "permission-error" => Err("偽OSの許可取得失敗".into()),
            "denied" | "notDetermined" => Ok(self.mode.clone()),
            _ => Ok("granted".into()),
        }
    }
    fn send(&self, item: &Notification) -> Result<(), String> {
        if self.mode == "crash-before-send" {
            eprintln!("claim確定後に終了");
            std::process::exit(23);
        }
        if self.mode == "pause-before-send" {
            // claim確定後の外部OS境界で待ち、同時の利用者操作を再現する。
            eprintln!("送信待機");
            let mut release = String::new();
            std::io::stdin().read_line(&mut release).unwrap();
            assert_eq!(release.trim(), "release");
        }
        self.received.lock().unwrap().push(item.clone());
        if self.mode == "quit-after-first" { QUITTING.store(true, Ordering::SeqCst); }
        if self.mode == "crash-after-send" {
            eprintln!("OSへ送信依頼後に結果不明");
            std::process::exit(24);
        }
        if self.mode == "loop" { println!("{}", serde_json::to_string(item).unwrap()); }
        if self.mode == "fail" { Err("偽OSの送信失敗".into()) } else { Ok(()) }
    }
}
fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(2).map(String::as_str) == Some("loop") {
        let origin = Arc::new(Mutex::new(if args[1] == "disconnected" { None } else { Some(args[1].clone()) }));
        let current = origin.clone();
        println!("ready");
        let worker = notification_runtime::DeliveryWorker::start(move || {
            let Some(origin) = current.lock().unwrap().clone() else { return };
            let source = HttpSource { origin, client: reqwest::blocking::Client::builder().no_proxy().timeout(Duration::from_secs(3)).build().unwrap() };
            let os = FakeOs { received: Mutex::new(vec![]), mode: "loop".into() };
            if let Err(error) = tick(&source, &os) { eprintln!("{error}"); }
        });
        for line in std::io::stdin().lock().lines() {
            let line = line.unwrap();
            if line == "stop" { break; }
            if line == "disconnect" { *origin.lock().unwrap() = None; }
            else if let Some(value) = line.strip_prefix("connect ") { *origin.lock().unwrap() = Some(value.into()); }
            else { panic!("不明なworker操作"); }
            worker.wake();
        }
        worker.stop();
        println!("stopped");
        return;
    }
    let source = HttpSource { origin: args[1].clone(), client: reqwest::blocking::Client::builder().no_proxy().timeout(Duration::from_secs(3)).build().unwrap() };
    let os = FakeOs { received: Mutex::new(vec![]), mode: args.get(2).cloned().unwrap_or_else(|| "ok".into()) };
    for _ in 0..2 {
        let result = if os.mode == "quit-after-first" {
            notification_delivery::tick_while(&source, &os, || !QUITTING.load(Ordering::SeqCst))
        } else { tick(&source, &os) };
        if let Err(error) = result {
            if os.mode == "permission-error" || os.mode == "recoverable-error" { eprintln!("{error}"); } else { panic!("{error}"); }
        }
    }
    println!("{}", serde_json::to_string(&*os.received.lock().unwrap()).unwrap());
}

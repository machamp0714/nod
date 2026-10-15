//! 実DB・HTTP契約を通す統合テスト専用の偽OS受け口。
use std::{sync::Mutex, time::Duration};
#[path = "../../../src-tauri/src/notification_delivery.rs"]
mod notification_delivery;
use notification_delivery::{tick, HttpSource, Notification, Os};
struct FakeOs { received: Mutex<Vec<Notification>>, fail: bool }
impl Os for FakeOs {
    fn permission(&self) -> Result<String, String> { Ok("granted".into()) }
    fn send(&self, item: &Notification) -> Result<(), String> {
        self.received.lock().unwrap().push(item.clone());
        if self.fail { Err("偽OSの送信失敗".into()) } else { Ok(()) }
    }
}
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let source = HttpSource { origin: args[1].clone(), client: reqwest::blocking::Client::builder().no_proxy().timeout(Duration::from_secs(3)).build().unwrap() };
    let os = FakeOs { received: Mutex::new(vec![]), fail: args.get(2).is_some_and(|v| v == "fail") };
    tick(&source, &os).unwrap();
    tick(&source, &os).unwrap();
    println!("{}", serde_json::to_string(&*os.received.lock().unwrap()).unwrap());
}

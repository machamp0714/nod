//! 実DB・HTTP契約を通す統合テスト専用の偽OS受け口。
use std::{sync::Mutex, time::Duration};
#[path = "../../../src-tauri/src/notification_delivery.rs"]
mod notification_delivery;
use notification_delivery::{tick, HttpSource, Notification, Os};
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
        if self.mode == "pause-before-send" {
            // claim確定後の外部OS境界で待ち、同時の利用者操作を再現する。
            eprintln!("送信待機");
            let mut release = String::new();
            std::io::stdin().read_line(&mut release).unwrap();
            assert_eq!(release.trim(), "release");
        }
        self.received.lock().unwrap().push(item.clone());
        if self.mode == "fail" { Err("偽OSの送信失敗".into()) } else { Ok(()) }
    }
}
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let source = HttpSource { origin: args[1].clone(), client: reqwest::blocking::Client::builder().no_proxy().timeout(Duration::from_secs(3)).build().unwrap() };
    let os = FakeOs { received: Mutex::new(vec![]), mode: args.get(2).cloned().unwrap_or_else(|| "ok".into()) };
    for _ in 0..2 {
        if let Err(error) = tick(&source, &os) {
            if os.mode == "permission-error" { eprintln!("{error}"); } else { panic!("{error}"); }
        }
    }
    println!("{}", serde_json::to_string(&*os.received.lock().unwrap()).unwrap());
}

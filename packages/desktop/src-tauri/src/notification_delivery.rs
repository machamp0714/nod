//! ネイティブ配信の境界。実行ループとテストが同じ取得・送信・結果確定を通る。
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    pub notification_id: u64,
    pub issue_id: String,
    pub title: String,
    pub body: String,
    pub scheduled_at: String,
}
pub trait Source {
    fn claim(&self, permission: &str) -> Result<Vec<Notification>, String>;
    fn finish(&self, id: u64, state: &str) -> Result<(), String>;
}
pub trait Os {
    fn permission(&self) -> Result<String, String>;
    fn send(&self, item: &Notification) -> Result<(), String>;
}
pub fn tick(source: &impl Source, os: &impl Os) -> Result<(), String> {
    tick_while(source, os, || true)
}
pub fn tick_while(source: &impl Source, os: &impl Os, active: impl Fn() -> bool) -> Result<(), String> {
    if !active() { return Ok(()); }
    let permission = os.permission()?;
    if !active() { return Ok(()); }
    for item in source.claim(&permission)? {
        // 終了中に新たなOS送信を始めない。確定済みのclaimは再送しない契約を維持する。
        if !active() { break; }
        let state = if os.send(&item).is_ok() { "sent" } else { "failed" };
        // 結果保存の失敗でもclaimは残す。重複回避を優先し、送信を繰り返さない。
        source.finish(item.notification_id, state)?;
    }
    Ok(())
}
pub struct HttpSource { pub origin: String, pub client: reqwest::blocking::Client }
impl HttpSource {
    pub fn post(&self, path: &str, body: serde_json::Value) -> Result<serde_json::Value, String> {
        self.client.post(format!("{}/api/desktop-notifications/{path}", self.origin)).json(&body)
            .send().and_then(|r| r.error_for_status()).and_then(|r| r.json()).map_err(|_| "通知APIへ接続できません".into())
    }
}
impl Source for HttpSource {
    fn claim(&self, permission: &str) -> Result<Vec<Notification>, String> {
        serde_json::from_value(self.post("claim", serde_json::json!({ "permission": permission }))?).map_err(|_| "通知応答が不正です".into())
    }
    fn finish(&self, id: u64, state: &str) -> Result<(), String> {
        self.post("result", serde_json::json!({ "notificationId": id, "state": state }))?;
        Ok(())
    }
}

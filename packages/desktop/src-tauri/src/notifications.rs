//! Apple UserNotifications。delegateを起動直後から保持し、WebViewの存続に依存しない。
use std::{path::PathBuf, ptr::NonNull, sync::{mpsc, Arc, Mutex}, time::Duration};
use block2::{DynBlock, RcBlock};
use objc2::{define_class, msg_send, rc::Retained, runtime::{Bool, ProtocolObject}, DefinedClass, AnyThread};
use objc2_foundation::{NSDictionary, NSError, NSObject, NSObjectProtocol, NSString};
use objc2_user_notifications::*;
use nod_desktop::notification_delivery::{self, HttpSource, Notification, Os};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewWindow};
use crate::{shell, status::Status};
use nod_desktop::Stage;
use std::io::Write;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Pending { issue_id: String, notification_id: u64 }
pub struct State { pending: Mutex<Option<Pending>>, path: PathBuf, navigating: Mutex<Option<(Pending, u16)>> }
impl State {
    fn save(&self, value: Pending) -> Result<(), String> {
        // 保存障害時も、この起動中のクリック遷移は保持する。
        *self.pending.lock().unwrap() = Some(value.clone());
        *self.navigating.lock().unwrap() = None;
        let save = || -> std::io::Result<()> {
            if let Some(parent) = self.path.parent() { std::fs::create_dir_all(parent)?; }
            let temporary = self.path.with_extension("tmp");
            let mut file = std::fs::File::create(&temporary)?;
            file.write_all(&serde_json::to_vec(&value)?)?;
            file.sync_all()?;
            std::fs::rename(temporary, &self.path)
        };
        save().map_err(|_| "通知の遷移先を保存できませんでした。この起動中の遷移は保持します".to_string())
    }
}
struct Ivars { handle: AppHandle }
define_class!(
    #[unsafe(super = NSObject)]
    #[ivars = Ivars]
    struct Delegate;
    unsafe impl NSObjectProtocol for Delegate {}
    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn present(&self, _center: &UNUserNotificationCenter, _notification: &UNNotification, completion: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>) {
            completion.call((UNNotificationPresentationOptions::Banner | UNNotificationPresentationOptions::List | UNNotificationPresentationOptions::Sound,));
        }
        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn response(&self, _center: &UNUserNotificationCenter, response: &UNNotificationResponse, completion: &DynBlock<dyn Fn()>) {
            let data = response.notification().request().content().userInfo();
            let issue = data.objectForKey(&NSString::from_str("issueId")).and_then(|v| v.downcast::<NSString>().ok());
            let id = data.objectForKey(&NSString::from_str("notificationId")).and_then(|v| v.downcast::<NSString>().ok()).and_then(|v| v.to_string().parse::<u64>().ok());
            if let (Some(issue), Some(id)) = (issue, id) {
                let handle = &self.ivars().handle;
                if let Err(message) = handle.state::<Arc<State>>().save(Pending { issue_id: issue.to_string(), notification_id: id }) {
                    handle.state::<Arc<Status>>().logger.event(Stage::Running, &message);
                }
                let h = handle.clone();
                let _ = handle.run_on_main_thread(move || { shell::show_main(&h); navigate_pending(&h); });
            }
            completion.call(());
        }
    }
);
impl Delegate {
    fn new(handle: AppHandle) -> Retained<Self> {
        let this = Self::alloc().set_ivars(Ivars { handle });
        unsafe { msg_send![super(this), init] }
    }
}

pub struct AppleOs;
impl Os for AppleOs {
    fn permission(&self) -> Result<String, String> {
        let (send, receive) = mpsc::channel();
        let block = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
            let status = unsafe { settings.as_ref().authorizationStatus() };
            let value = if status == UNAuthorizationStatus::Authorized || status == UNAuthorizationStatus::Provisional { "granted" } else if status == UNAuthorizationStatus::NotDetermined { "notDetermined" } else { "denied" };
            let _ = send.send(value.to_string());
        });
        UNUserNotificationCenter::currentNotificationCenter().getNotificationSettingsWithCompletionHandler(&block);
        receive.recv_timeout(Duration::from_secs(3)).map_err(|_| "通知許可を取得できません".into())
    }
    fn send(&self, item: &Notification) -> Result<(), String> {
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(&item.title));
        content.setBody(&NSString::from_str(&item.body));
        let keys = [NSString::from_str("issueId"), NSString::from_str("notificationId")];
        let values = [NSString::from_str(&item.issue_id), NSString::from_str(&item.notification_id.to_string())];
        let data = NSDictionary::from_slices(&[&*keys[0], &*keys[1]], &[&*values[0], &*values[1]]);
        // 辞書のキー/値はNSStringのみ。Foundationの非ジェネリックAPIへ同じオブジェクトを渡す。
        unsafe { content.setUserInfo(&*(Retained::as_ptr(&data) as *const NSDictionary)); }
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&NSString::from_str(&format!("nod-inbox-{}", item.notification_id)), &content, None);
        let (send, receive) = mpsc::channel();
        let completion = RcBlock::new(move |error: *mut NSError| { let _ = send.send(error.is_null()); });
        UNUserNotificationCenter::currentNotificationCenter().addNotificationRequest_withCompletionHandler(&request, Some(&completion));
        match receive.recv_timeout(Duration::from_secs(3)) { Ok(true) => Ok(()), _ => Err("OS通知を送信できません".into()) }
    }
}
fn source(handle: &AppHandle) -> Result<HttpSource, String> {
    let port = shell::own_port(handle);
    if port == 0 { return Err("アプリを起動中です".into()); }
    let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(3)).no_proxy().build().map_err(|_| "通知APIを初期化できません")?;
    Ok(HttpSource { origin: format!("http://127.0.0.1:{port}"), client })
}
fn trusted(handle: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|_| "画面の接続先が不明です")?;
    if window.label() != shell::MAIN_WINDOW || url.scheme() != "http" || url.host_str() != Some("127.0.0.1") || url.port() != Some(shell::own_port(handle)) { return Err("通知操作はアプリの画面で行ってください".into()); }
    Ok(())
}
#[tauri::command]
pub async fn notification_permission(handle: AppHandle, window: WebviewWindow, request: bool) -> Result<String, String> {
    trusted(&handle, &window)?;
    tauri::async_runtime::spawn_blocking(move || {
        if request {
            let (send, receive) = mpsc::channel();
            let completion = RcBlock::new(move |_granted: Bool, _error: *mut NSError| { let _ = send.send(()); });
            UNUserNotificationCenter::currentNotificationCenter().requestAuthorizationWithOptions_completionHandler(UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound, &completion);
            let _ = receive.recv_timeout(Duration::from_secs(30));
        }
        AppleOs.permission()
    }).await.map_err(|_| "通知許可を確認できません".to_string())?
}
#[tauri::command]
pub async fn notification_opened(handle: AppHandle, window: WebviewWindow, issue_id: String) -> Result<(), String> {
    trusted(&handle, &window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<Arc<State>>();
        let pending = state.pending.lock().unwrap().clone();
        if let Some(value) = pending.filter(|p| p.issue_id == issue_id) {
            source(&handle)?.post("opened", serde_json::to_value(&value).unwrap())?;
            let mut current = state.pending.lock().unwrap();
            if current.as_ref() == Some(&value) { *current = None; let _ = std::fs::remove_file(&state.path); *state.navigating.lock().unwrap() = None; }
        }
        Ok(())
    }).await.map_err(|_| "通知の既読を保存できません".to_string())?
}
pub fn navigate_pending(handle: &AppHandle) {
    let state = handle.state::<Arc<State>>();
    let pending = state.pending.lock().unwrap().clone();
    let port = shell::own_port(handle);
    if let Some(value) = pending.filter(|_| port != 0) {
        let mut nav = state.navigating.lock().unwrap();
        if nav.as_ref() == Some(&(value.clone(), port)) { return; }
        *nav = Some((value.clone(), port));
        shell::open_main_window(handle, &format!("http://127.0.0.1:{port}/issues/{}", value.issue_id), true);
    }
}
pub fn install(handle: &AppHandle) {
    let path = handle.path().app_data_dir().unwrap().join("pending-notification.json");
    let pending = std::fs::read(&path).ok().and_then(|v| serde_json::from_slice(&v).ok());
    handle.manage(Arc::new(State { path, pending: Mutex::new(pending), navigating: Mutex::new(None) }));
    let delegate = Delegate::new(handle.clone());
    UNUserNotificationCenter::currentNotificationCenter().setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    // UNUserNotificationCenterのdelegateはweakなのでアプリ終了まで強参照を保持する。
    std::mem::forget(delegate);
    let h = handle.clone();
    std::thread::spawn(move || loop {
        if let Ok(src) = source(&h) { let _ = notification_delivery::tick(&src, &AppleOs); }
        let h2 = h.clone();
        let _ = h.run_on_main_thread(move || navigate_pending(&h2));
        std::thread::sleep(Duration::from_secs(1));
    });
}

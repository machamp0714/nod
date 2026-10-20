//! 配布物と同じ生成済みcapabilityで、可変loopback originの通知IPCを検証する。
use tauri::{test::{mock_builder, get_ipc_response, INVOKE_KEY}, webview::InvokeRequest};
#[tauri::command]
fn notification_permission() -> &'static str { "到達しました" }
fn invoke(origin: &str) -> Result<String, String> {
    let app = mock_builder().invoke_handler(tauri::generate_handler![notification_permission])
        .build(tauri::generate_context!()).unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
    get_ipc_response(&window, InvokeRequest {
        cmd: "notification_permission".into(), callback: tauri::ipc::CallbackFn(0), error: tauri::ipc::CallbackFn(1),
        url: origin.parse().unwrap(), body: tauri::ipc::InvokeBody::default(), headers: Default::default(), invoke_key: INVOKE_KEY.to_string(),
    }).map(|body| body.deserialize::<String>().unwrap()).map_err(|error| error.to_string())
}
#[test]
fn current_sidecar_origin_can_dispatch_notification_command() {
    assert_eq!(invoke("http://127.0.0.1:59123/workspaces/API/settings"), Ok("到達しました".into()));
}
#[test]
fn unrelated_remote_origin_cannot_dispatch_notification_command() {
    assert!(invoke("https://example.com/").is_err());
}

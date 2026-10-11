//! マウスの戻る/進むボタン（button 3/4）を、主ウィンドウの履歴移動に割り当てる。
//! WKWebView はこのボタンを JS に渡さないため、AppKit のイベントを直接監視する。

use std::ptr::NonNull;

use block2::RcBlock;
use objc2_app_kit::{NSEvent, NSEventMask};
use tauri::{AppHandle, Manager};

const BUTTON_BACK: isize = 3;
const BUTTON_FORWARD: isize = 4;

/// アプリ内のマウスイベントの監視を始める。メインスレッドで 1 回だけ呼ぶ。
pub fn install(handle: &AppHandle, window_label: &'static str) {
    let handle = handle.clone();
    let block = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        // SAFETY: AppKit が渡すイベントで、ブロックの実行中は有効。
        let button = unsafe { event.as_ref().buttonNumber() };
        let script = match button {
            BUTTON_BACK => "history.back()",
            BUTTON_FORWARD => "history.forward()",
            _ => return event.as_ptr(),
        };
        if let Some(w) = handle.get_webview_window(window_label) {
            let _ = w.eval(script);
        }
        // 処理したボタンはこれ以上渡さない。
        std::ptr::null_mut()
    });
    // 監視はアプリの終了まで残す（解除しない）。戻り値の保持も不要。
    let monitor = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::OtherMouseUp, &block)
    };
    std::mem::forget(monitor);
}

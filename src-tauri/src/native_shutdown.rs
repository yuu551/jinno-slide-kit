//! Route native macOS termination requests through the same unsaved-document guard.
use std::sync::{
    atomic::{AtomicBool, Ordering},
    OnceLock,
};
use tauri::AppHandle;
static APP: OnceLock<AppHandle> = OnceLock::new();
static PENDING: AtomicBool = AtomicBool::new(false);
static APPROVED: AtomicBool = AtomicBool::new(false);

pub fn approved() -> bool {
    APPROVED.load(Ordering::SeqCst)
}

pub fn reply(app: &AppHandle, allow: bool) -> bool {
    if !PENDING.swap(false, Ordering::SeqCst) {
        return false;
    }
    APPROVED.store(allow, Ordering::SeqCst);
    let _ = app.run_on_main_thread(move || {
        if let Some(mtm) = objc2::MainThreadMarker::new() {
            eprintln!("NATIVE_QUIT_REPLY pid={} allow={allow}", std::process::id());
            objc2_app_kit::NSApplication::sharedApplication(mtm)
                .replyToApplicationShouldTerminate(allow);
        }
    });
    true
}

#[cfg(target_os = "macos")]
pub fn install(app: &AppHandle) -> Result<(), String> {
    use objc2::runtime::{AnyClass, AnyObject, Sel};
    use objc2::{msg_send, sel, MainThreadMarker};
    use objc2_app_kit::NSApplication;
    use std::ffi::{c_char, c_void};
    extern "C" {
        fn class_replaceMethod(
            cls: *const AnyClass,
            name: Sel,
            imp: unsafe extern "C" fn(),
            types: *const c_char,
        ) -> *const c_void;
    }
    unsafe extern "C" fn should_terminate(
        _delegate: &AnyObject,
        _selector: Sel,
        _sender: &AnyObject,
    ) -> usize {
        use objc2_app_kit::NSApplicationTerminateReply;
        let Some(mtm) = MainThreadMarker::new() else {
            return NSApplicationTerminateReply::TerminateCancel.0;
        };
        let dirty = NSApplication::sharedApplication(mtm)
            .windows()
            .iter()
            .any(|window| window.isDocumentEdited());
        if !dirty {
            APPROVED.store(true, Ordering::SeqCst);
            eprintln!("NATIVE_QUIT pid={} reply=Now", std::process::id());
            return NSApplicationTerminateReply::TerminateNow.0;
        }
        if let Some(app) = APP.get() {
            eprintln!("NATIVE_QUIT pid={} reply=Later", std::process::id());
            if !PENDING.swap(true, Ordering::SeqCst) {
                APPROVED.store(false, Ordering::SeqCst);
                let app2 = app.clone();
                // delegate の返事を返したあとに、WebView へ保存の確認を頼む。
                std::thread::spawn(move || {
                    let handle = app2.clone();
                    let _ = app2.run_on_main_thread(move || crate::quit_app(&handle));
                });
            }
            NSApplicationTerminateReply::TerminateLater.0
        } else {
            NSApplicationTerminateReply::TerminateCancel.0
        }
    }
    let mtm = MainThreadMarker::new().ok_or("終了の処理は主スレッドで登録してください")?;
    let delegate = NSApplication::sharedApplication(mtm)
        .delegate()
        .ok_or("終了の受け口がありません")?;
    let _ = APP.set(app.clone());
    unsafe {
        let class: *const AnyClass = msg_send![&*delegate, class];
        let imp: unsafe extern "C" fn() = std::mem::transmute(
            should_terminate as unsafe extern "C" fn(&AnyObject, Sel, &AnyObject) -> usize,
        );
        class_replaceMethod(
            class,
            sel!(applicationShouldTerminate:),
            imp,
            c"Q@:@".as_ptr(),
        );
    }
    Ok(())
}

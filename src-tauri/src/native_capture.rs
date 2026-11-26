// Tauri が所有する WKWebView を撮る。画面を OS の入力で動かさず、メインスレッドで API を呼ぶ。
use tauri::WebviewWindow;

pub async fn capture(window: WebviewWindow, rect: [f64; 4], png: bool) -> Result<Vec<u8>, String> {
    if rect.iter().any(|v| !v.is_finite())
        || rect[2] <= 0.0
        || rect[3] <= 0.0
        || rect[2] > 16384.0
        || rect[3] > 16384.0
    {
        return Err("書き出す範囲が正しくありません".into());
    }
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    window.with_webview(move |view| {
        use block2::RcBlock;
        use objc2::{AnyThread, MainThreadMarker, msg_send};
        use objc2::runtime::AnyObject;
        use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
        use objc2_core_foundation::{CGPoint, CGRect, CGSize};
        use objc2_foundation::{NSData, NSDictionary, NSError, NSNumber, NSString};
        use objc2_web_kit::{WKPDFConfiguration, WKSnapshotConfiguration, WKWebView};
        let Some(mtm) = MainThreadMarker::new() else { let _ = tx.send(Err("画面の処理を開始できません".into())); return; };
        // with_webview はメインスレッド上で、生存中の WKWebView を渡す。
        let webview = unsafe { &*view.inner().cast::<WKWebView>() };
        let rect = CGRect::new(CGPoint::new(rect[0], rect[1]), CGSize::new(rect[2], rect[3]));
        if png {
            let cfg = unsafe { WKSnapshotConfiguration::new(mtm) };
            unsafe {
                cfg.setRect(rect);
                cfg.setSnapshotWidth(Some(&NSNumber::new_f64(rect.size.width * 2.0)));
                // WebKit の透明な背景を背景画像の切り出しにも引き継ぐ。
                let _: () = msg_send![webview, setValue: &*NSNumber::new_bool(false), forKey: &*NSString::from_str("drawsBackground")];
            }
            let done = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                let result = if image.is_null() {
                    Err(error_text(error, "背景の画像を作れませんでした"))
                } else {
                    // completion の間は image が生存する。bytes にしてから渡す。
                    unsafe { (*image).TIFFRepresentation() }
                        .and_then(|data| NSBitmapImageRep::initWithData(NSBitmapImageRep::alloc(), &data))
                        .and_then(|bitmap| unsafe { bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::<NSString, AnyObject>::new()) })
                        .map(|data| data.to_vec()).ok_or_else(|| "背景の画像を保存できませんでした".into())
                };
                let _ = tx.send(result);
            });
            unsafe { webview.takeSnapshotWithConfiguration_completionHandler(Some(&cfg), &done) };
        } else {
            let cfg = unsafe { WKPDFConfiguration::new(mtm) };
            unsafe { cfg.setRect(rect); }
            let done = RcBlock::new(move |data: *mut NSData, error: *mut NSError| {
                let result = if data.is_null() { Err(error_text(error, "PDF を作れませんでした")) }
                else { Ok(unsafe { (*data).to_vec() }) };
                let _ = tx.send(result);
            });
            unsafe { webview.createPDFWithConfiguration_completionHandler(Some(&cfg), &done) };
        }
    }).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(std::time::Duration::from_secs(60))
            .map_err(|_| "1ページの書き出しに時間がかかりすぎたので止めました".to_string())?
    })
    .await
    .map_err(|e| e.to_string())?
}

fn error_text(error: *mut objc2_foundation::NSError, fallback: &str) -> String {
    if error.is_null() {
        fallback.into()
    } else {
        // この関数は WebKit completion の中だけで呼ぶ。NSError はその間生存する。
        format!("{fallback}：{}", unsafe {
            (*error).localizedDescription()
        })
    }
}

pub fn merge_pdf_pages(pages: &[Vec<u8>]) -> Result<Vec<u8>, String> {
    use objc2::AnyThread;
    use objc2_foundation::NSData;
    use objc2_pdf_kit::PDFDocument;
    objc2::rc::autoreleasepool(|_| {
        let merged = unsafe { PDFDocument::new() };
        for (i, bytes) in pages.iter().enumerate() {
            let data = NSData::with_bytes(bytes);
            let doc = unsafe { PDFDocument::initWithData(PDFDocument::alloc(), &data) }
                .ok_or_else(|| format!("{}ページ目のPDFが読めません", i + 1))?;
            let page = unsafe { doc.pageAtIndex(0) }.ok_or("PDF にページがありません")?;
            unsafe { merged.insertPage_atIndex(&page, i) };
        }
        unsafe { merged.dataRepresentation() }
            .map(|data| data.to_vec())
            .ok_or_else(|| "PDF をまとめられませんでした".into())
    })
}

use std::ffi::c_void;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Mutex;

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol};
use objc2::{define_class, msg_send, sel, AnyThread, DefinedClass};
use objc2_app_kit::{
    NSPaperOrientation, NSPrintInfo, NSPrintOperation, NSPrintingPaginationMode, NSWindow,
};
use objc2_foundation::NSSize;
use objc2_web_kit::WKWebView;
use serde::Serialize;
use tauri::Emitter;

#[derive(Clone, Serialize)]
struct PrintFinished {
    ok: bool,
    error: Option<String>,
}

struct PrintDelegateIvars {
    id: u64,
    window: tauri::WebviewWindow,
    /// Extra retain of the print operation, released when the sheet closes.
    operation: *mut NSPrintOperation,
}

unsafe impl Send for PrintDelegateIvars {}
unsafe impl Sync for PrintDelegateIvars {}

define_class!(
    #[unsafe(super(NSObject))]
    #[ivars = PrintDelegateIvars]
    struct PrintDelegate;

    unsafe impl NSObjectProtocol for PrintDelegate {}

    impl PrintDelegate {
        #[unsafe(method(printOperationDidRun:success:contextInfo:))]
        fn print_operation_did_run(
            &self,
            _operation: &NSPrintOperation,
            _success: bool,
            _context: *mut c_void,
        ) {
            let _ = self.ivars().window.emit(
                "print-finished",
                PrintFinished {
                    ok: true,
                    error: None,
                },
            );
            let raw = self.ivars().operation;
            if !raw.is_null() {
                drop(unsafe { Retained::<NSPrintOperation>::from_raw(raw) });
            }
            let id = self.ivars().id;
            let finished = LIVE.lock().ok().and_then(|mut live| {
                let index = live.iter().position(|(existing, _)| *existing == id)?;
                Some(live.remove(index).1)
            });
            // The callback is still on the stack. Hold the object until the next print.
            if let Some(finished) = finished {
                if let Ok(mut previous) = PREVIOUS.lock() {
                    *previous = Some(finished);
                }
            }
        }
    }
);

impl PrintDelegate {
    fn new(window: tauri::WebviewWindow, operation: *mut NSPrintOperation) -> Retained<Self> {
        let this = Self::alloc().set_ivars(PrintDelegateIvars {
            id: NEXT.fetch_add(1, Ordering::Relaxed),
            window,
            operation,
        });
        unsafe { msg_send![super(this), init] }
    }
}

static NEXT: AtomicU64 = AtomicU64::new(1);
static LIVE: Mutex<Vec<(u64, Retained<PrintDelegate>)>> = Mutex::new(Vec::new());
static PREVIOUS: Mutex<Option<Retained<PrintDelegate>>> = Mutex::new(None);

pub fn print_board(window: &tauri::WebviewWindow, landscape: bool) -> Result<(), String> {
    let panel_window = window.clone();
    let (tx, rx) = mpsc::channel();
    window
        .with_webview(move |webview| {
            let result = unsafe { present_print_panel(&webview, landscape, panel_window) };
            let _ = tx.send(result);
        })
        .map_err(|err| format!("Could not open the print dialog: {err}"))?;
    // This returns once the sheet is on screen. Waiting here for it to close blocks the main
    // thread, and the sheet then cannot run.
    rx.recv()
        .map_err(|_| "Could not open the print dialog.".to_string())?
}

unsafe fn present_print_panel(
    webview: &tauri::webview::PlatformWebview,
    landscape: bool,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    let view_ptr = webview.inner();
    let window_ptr = webview.ns_window();
    if view_ptr.is_null() || window_ptr.is_null() {
        return Err("The window is not available for printing.".to_string());
    }

    let view: &WKWebView = &*view_ptr.cast();
    let ns_window: &NSWindow = &*window_ptr.cast();
    let info = NSPrintInfo::sharedPrintInfo();
    info.setOrientation(if landscape {
        NSPaperOrientation::Landscape
    } else {
        NSPaperOrientation::Portrait
    });
    info.setPaperSize(if landscape {
        NSSize {
            width: 11.0 * 72.0,
            height: 8.5 * 72.0,
        }
    } else {
        NSSize {
            width: 8.5 * 72.0,
            height: 11.0 * 72.0,
        }
    });
    info.setTopMargin(0.0);
    info.setBottomMargin(0.0);
    info.setLeftMargin(0.0);
    info.setRightMargin(0.0);
    info.setScalingFactor(1.0);
    info.setHorizontallyCentered(true);
    info.setVerticallyCentered(true);
    info.setHorizontalPagination(NSPrintingPaginationMode::Automatic);
    info.setVerticalPagination(NSPrintingPaginationMode::Automatic);

    let operation = view.printOperationWithPrintInfo(&info);
    operation.setShowsPrintPanel(true);
    operation.setCanSpawnSeparateThread(true);
    let delegate = PrintDelegate::new(window, Retained::into_raw(operation));
    let id = delegate.ivars().id;
    if let Ok(mut live) = LIVE.lock() {
        live.push((id, delegate.clone()));
    }
    let delegate_obj: &AnyObject = &*Retained::as_ptr(&delegate).cast();
    let operation = &*delegate.ivars().operation;
    operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
        ns_window,
        Some(delegate_obj),
        Some(sel!(printOperationDidRun:success:contextInfo:)),
        std::ptr::null_mut(),
    );
    Ok(())
}

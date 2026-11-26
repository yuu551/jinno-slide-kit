//! Persist document window bounds without restoring transient presentation windows.
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    sync::{Mutex, OnceLock},
};
use tauri::Window;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
struct Bounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale: f64,
}
static READY: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
fn ready() -> &'static Mutex<std::collections::HashSet<String>> {
    READY.get_or_init(Default::default)
}
pub fn prepare(label: &str) {
    let _ = bounds();
    if let Ok(mut set) = ready().lock() {
        set.remove(label);
    }
}
static LAST: Mutex<Option<Bounds>> = Mutex::new(None);
static BOUNDS: OnceLock<Mutex<BTreeMap<String, Bounds>>> = OnceLock::new();
fn path() -> std::path::PathBuf {
    crate::settings::support_dir().join("geometry.json")
}
fn bounds() -> &'static Mutex<BTreeMap<String, Bounds>> {
    BOUNDS.get_or_init(|| {
        Mutex::new(
            std::fs::read(path())
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                .unwrap_or_default(),
        )
    })
}
pub fn managed(label: &str) -> bool {
    label == "library" || label.starts_with("editor-")
}
fn clamp(mut b: Bounds, area: Bounds, scale: f64) -> Bounds {
    // Restore dimensions in points when switching between Retina and ordinary screens.
    let ratio = scale / b.scale.max(1.0);
    b.x = (b.x as f64 * ratio).round() as i32;
    b.y = (b.y as f64 * ratio).round() as i32;
    b.width = ((b.width as f64 * ratio).round() as u32)
        .min(area.width)
        .max(1);
    b.height = ((b.height as f64 * ratio).round() as u32)
        .min(area.height)
        .max(1);
    b.x =
        b.x.clamp(area.x, area.x.saturating_add((area.width - b.width) as i32));
    b.y = b.y.clamp(
        area.y,
        area.y.saturating_add((area.height - b.height) as i32),
    );
    b.scale = scale;
    b
}
pub fn restore(window: &Window) {
    if !managed(window.label()) {
        return;
    }
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSScreen, NSWindow};
        use objc2_foundation::{NSPoint, NSRect, NSSize};
        let Some(mtm) = objc2::MainThreadMarker::new() else {
            return;
        };
        let Ok(ptr) = window.ns_window() else { return };
        let native = unsafe { &*(ptr as *const NSWindow) };
        let saved = bounds()
            .lock()
            .ok()
            .and_then(|all| all.get(window.label()).copied());
        let screens = NSScreen::screens(mtm);
        let previous = LAST.lock().ok().and_then(|b| *b);
        let contains = |screen: &NSScreen, b: Bounds| {
            let r = screen.frame();
            let x = b.x as f64 / b.scale;
            let y = b.y as f64 / b.scale;
            x >= r.origin.x
                && x < r.origin.x + r.size.width
                && y >= r.origin.y
                && y < r.origin.y + r.size.height
        };
        let screen = saved
            .or(previous)
            .and_then(|b| screens.iter().find(|s| contains(s, b)))
            .or_else(|| native.screen())
            .or_else(|| screens.firstObject());
        let Some(screen) = screen else { return };
        let scale = screen.backingScaleFactor();
        let r = screen.visibleFrame();
        let area = Bounds {
            x: (r.origin.x * scale).round() as i32,
            y: (r.origin.y * scale).round() as i32,
            width: (r.size.width * scale).round() as u32,
            height: (r.size.height * scale).round() as u32,
            scale,
        };
        let initial = previous
            .map(|b| Bounds {
                x: b.x + (24.0 * b.scale) as i32,
                y: b.y - (24.0 * b.scale) as i32,
                ..b
            })
            .unwrap_or(Bounds {
                x: area.x + (40.0 * scale) as i32,
                y: area.y + (40.0 * scale) as i32,
                width: (1440.0 * scale) as u32,
                height: (900.0 * scale) as u32,
                scale,
            });
        let b = clamp(saved.unwrap_or(initial), area, scale);
        // Use Cocoa's frame and visibleFrame in the same coordinate space. Tauri's
        // current_monitor can refer to a different display before the saved frame is set.
        native.setFrame_display(
            NSRect::new(
                NSPoint::new(b.x as f64 / scale, b.y as f64 / scale),
                NSSize::new(b.width as f64 / scale, b.height as f64 / scale),
            ),
            true,
        );
    }
    #[cfg(not(target_os = "macos"))]
    if let Some(b) = bounds()
        .lock()
        .ok()
        .and_then(|all| all.get(window.label()).copied())
    {
        let _ = window.set_size(tauri::PhysicalSize::new(b.width, b.height));
        let _ = window.set_position(tauri::PhysicalPosition::new(b.x, b.y));
    }

    if let Ok(mut set) = ready().lock() {
        set.insert(window.label().into());
    }
    remember(window);
}
pub fn remember(window: &Window) {
    if !ready()
        .lock()
        .map(|s| s.contains(window.label()))
        .unwrap_or(false)
        || !managed(window.label())
        || window.is_fullscreen().unwrap_or(false)
        || window.is_minimized().unwrap_or(false)
    {
        return;
    }
    #[cfg(target_os = "macos")]
    let b = {
        let Ok(ptr) = window.ns_window() else { return };
        let native = unsafe { &*(ptr as *const objc2_app_kit::NSWindow) };
        let r = native.frame();
        let scale = native.backingScaleFactor();
        Bounds {
            x: (r.origin.x * scale).round() as i32,
            y: (r.origin.y * scale).round() as i32,
            width: (r.size.width * scale).round() as u32,
            height: (r.size.height * scale).round() as u32,
            scale,
        }
    };
    #[cfg(not(target_os = "macos"))]
    let b = {
        let (Ok(p), Ok(s), Ok(scale)) = (
            window.outer_position(),
            window.outer_size(),
            window.scale_factor(),
        ) else {
            return;
        };
        Bounds {
            x: p.x,
            y: p.y,
            width: s.width,
            height: s.height,
            scale,
        }
    };
    if let Ok(mut last) = LAST.lock() {
        *last = Some(b);
    }
    if let Ok(mut all) = bounds().lock() {
        all.insert(window.label().to_string(), b);
    }
}
pub fn flush() {
    let Ok(all) = bounds().lock() else { return };
    let Ok(bytes) = serde_json::to_vec(&*all) else {
        return;
    };
    if let Some(parent) = path().parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    if let Err(e) = crate::deck::atomic_write(&path(), &bytes) {
        eprintln!("ウインドウの位置を保存できません: {e}");
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn removed_display_is_clamped_to_visible_area() {
        let area = Bounds {
            x: 0,
            y: 48,
            width: 2560,
            height: 1392,
            scale: 2.0,
        };
        let b = clamp(
            Bounds {
                x: 9000,
                y: -3000,
                width: 3000,
                height: 1800,
                scale: 2.0,
            },
            area,
            2.0,
        );
        assert_eq!(
            b,
            Bounds {
                x: 0,
                y: 48,
                width: 2560,
                height: 1392,
                scale: 2.0
            }
        );
    }
    #[test]
    fn retina_change_keeps_size_in_points() {
        let area = Bounds {
            x: 0,
            y: 24,
            width: 1920,
            height: 1000,
            scale: 1.0,
        };
        let b = clamp(
            Bounds {
                x: 100,
                y: 100,
                width: 2400,
                height: 1400,
                scale: 2.0,
            },
            area,
            1.0,
        );
        assert_eq!((b.width, b.height), (1200, 700));
        assert!(b.y + b.height as i32 <= 1024);
    }
}

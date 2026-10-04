//! The one window: the page the bundle carries (the dev server's under `tauri dev`), pinned to its
//! own origin, opening no second window and holding no device permission. Closing it hides it: the
//! office keeps working in the menu bar, the dock icon goes with the window, and Open brings the
//! same page back. What the founder does with it (looks away, hides it, brings it back) goes to
//! main, which keeps when the office was last seen.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use serde_json::json;
use tauri::webview::{NewWindowResponse, PageLoadEvent, PermissionResponse};
use tauri::window::Color;
use tauri::{
    AppHandle, Manager, Runtime, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_opener::OpenerExt;

use crate::navigation::{self, ExternalOpens, Verdict};
use crate::shell;

pub const MAIN: &str = "main";

/// The page's own origin: the dev server's under `tauri dev`, else Tauri's embedded assets.
fn page_origin<R: Runtime>(app: &AppHandle<R>) -> String {
    let dev_url = app
        .config()
        .build
        .dev_url
        .clone()
        .filter(|_| tauri::is_dev());
    let url = dev_url.or_else(|| Url::parse("tauri://localhost").ok());
    url.as_ref()
        .and_then(navigation::comparable_origin)
        .unwrap_or_default()
}

fn open_externally<R: Runtime>(app: &AppHandle<R>, opens: &ExternalOpens, url: &Url) {
    if !opens.allow(Instant::now()) {
        eprintln!("[shell] refused to open {url}: another opened less than a second ago");
        return;
    }
    if let Err(error) = app.opener().open_url(url.as_str(), None::<&str>) {
        eprintln!("[shell] could not open {url} in the browser: {error}");
    }
}

fn told<R: Runtime>(app: &AppHandle<R>, state: &str) {
    shell::tell_main(app, "window", &json!({ "state": state }));
}

fn watch<R: Runtime>(window: &WebviewWindow<R>) {
    let app = window.app_handle().clone();
    let watched = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            if let Err(error) = watched.hide() {
                eprintln!("[shell] could not hide the window: {error}");
            }
            #[cfg(target_os = "macos")]
            if let Err(error) = app.set_dock_visibility(false) {
                eprintln!("[shell] could not hide the dock icon: {error}");
            }
            told(&app, "hidden");
        }
        WindowEvent::Focused(false) => told(&app, "blurred"),
        WindowEvent::Resized(_) if watched.is_minimized().unwrap_or(false) => {
            told(&app, "minimized");
        }
        _ => {}
    });
}

/// The one window, made if it is not there yet. Idempotent: a second launch's Show can make it while
/// a starting shell is about to, and the label is taken once, by whichever of the two is first.
pub fn create<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<WebviewWindow<R>> {
    if let Some(window) = app.get_webview_window(MAIN) {
        return Ok(window);
    }
    let pinned_origin = page_origin(app);
    let opens = Arc::new(ExternalOpens::new());
    let navigating = (app.clone(), Arc::clone(&opens));
    let opening = (app.clone(), opens);
    let shown = AtomicBool::new(false);
    let built = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .title("IdleBiz")
        .inner_size(1280.0, 800.0)
        .background_color(Color(0x12, 0x14, 0x1c, 0xff))
        .visible(false)
        .on_navigation(move |url| match navigation::classify(url, &pinned_origin) {
            Verdict::Allow => true,
            Verdict::OpenExternally => {
                open_externally(&navigating.0, &navigating.1, url);
                false
            }
            Verdict::Deny => false,
        })
        // `window.open` and `target="_blank"`: never a second window, a web page in the browser.
        // WebKit asks only for an open a click made, so no page opens the browser unasked
        .on_new_window(move |url, _features| {
            if navigation::is_web_url(&url) {
                open_externally(&opening.0, &opening.1, &url);
            }
            NewWindowResponse::Deny
        })
        // a game asks for nothing a device grants: no camera, microphone, location or notification
        .on_permission_request(|_, _| PermissionResponse::Deny)
        // the first load alone: a later one (a reload) must not bring back a window Close hid, nor
        // take the focus from whatever has it. Main hears it shown once it is
        .on_page_load(move |window, payload| {
            if payload.event() != PageLoadEvent::Finished || shown.swap(true, Ordering::Relaxed) {
                return;
            }
            match window.show().and_then(|()| window.set_focus()) {
                Ok(()) => told(window.app_handle(), "shown"),
                Err(error) => eprintln!("[shell] could not show the window: {error}"),
            }
        })
        .build();
    let window = match built {
        Ok(window) => window,
        Err(
            tauri::Error::WindowLabelAlreadyExists(_) | tauri::Error::WebviewLabelAlreadyExists(_),
        ) => {
            return app
                .get_webview_window(MAIN)
                .ok_or(tauri::Error::WindowNotFound);
        }
        Err(error) => return Err(error),
    };
    watch(&window);
    Ok(window)
}

/// Brings the office back: the window as it was, made now if a launch at login never made it.
pub fn show<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(target_os = "macos")]
    if let Err(error) = app.set_dock_visibility(true) {
        eprintln!("[shell] could not show the dock icon: {error}");
    }
    // a window made here is shown, and main told, by its first load
    let Some(window) = app.get_webview_window(MAIN) else {
        if let Err(error) = create(app) {
            eprintln!("[shell] could not make the window: {error}");
        }
        return;
    };
    match window
        .unminimize()
        .and_then(|()| window.show())
        .and_then(|()| window.set_focus())
    {
        Ok(()) => told(app, "shown"),
        Err(error) => eprintln!("[shell] could not show the window: {error}"),
    }
}

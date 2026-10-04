//! The one window: main's own page, served on loopback and signed in by a one-time handoff link
//! main hands the shell, as kyh/inteligir's window is its server's page. It is pinned to that
//! origin, opens no second window, holds no device permission, and reaches no command of the
//! shell's: the page calls main on its own origin. Closing it hides it: the office keeps working in
//! the menu bar, the dock icon goes with the window, and Open brings the same page back. What the
//! founder does with it (looks away, hides it, brings it back) goes to main, which keeps when the
//! office was last seen.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use serde::Deserialize;
use serde_json::{Value, json};
use tauri::webview::{NewWindowResponse, PageLoadEvent, PermissionResponse};
use tauri::window::Color;
use tauri::{
    AppHandle, Manager, Runtime, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_opener::OpenerExt;

use crate::navigation::{self, ExternalOpens, Verdict};
use crate::shell;

pub const MAIN: &str = "main";

/// What main answers `handoff` with (`apps/cli/src/server/serve.ts`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Handoff {
    origin: String,
    handoff_url: String,
}

/// The link the window opens on, and the origin it is pinned to: asked of main for each window
/// made, since a link left unused for five minutes signs nothing in. Blocks on main's answer, so
/// never on the main thread.
fn handoff<R: Runtime>(app: &AppHandle<R>) -> Result<(Url, String), String> {
    let main = shell::main(app).ok_or_else(|| "IdleBiz is still starting.".to_owned())?;
    let answer = tauri::async_runtime::block_on(main.request("handoff", &Value::Null))?;
    let handoff: Handoff = serde_json::from_value(answer)
        .map_err(|error| format!("main answered a handoff the shell cannot read: {error}"))?;
    let url = Url::parse(&handoff.handoff_url)
        .map_err(|error| format!("main's handoff is not a link: {error}"))?;
    match navigation::page_origin(&url) {
        Some(origin) if origin == handoff.origin => Ok((url, origin)),
        _ => Err(format!(
            "main's page must be on loopback, at the origin it names, not {}",
            handoff.origin
        )),
    }
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
/// Blocks on main's handoff, so never on the main thread.
pub fn create<R: Runtime>(app: &AppHandle<R>) -> Result<WebviewWindow<R>, String> {
    if let Some(window) = app.get_webview_window(MAIN) {
        return Ok(window);
    }
    let (url, pinned_origin) = handoff(app)?;
    let opens = Arc::new(ExternalOpens::new());
    let navigating = (app.clone(), Arc::clone(&opens));
    let opening = (app.clone(), opens);
    let shown = AtomicBool::new(false);
    let built = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::External(url))
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
        // take the focus from whatever has it. Main hears it shown once it is. Nothing of the URL is
        // logged: a handoff's link carries a nonce until its redirect drops it
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
                .ok_or_else(|| tauri::Error::WindowNotFound.to_string());
        }
        Err(error) => return Err(error.to_string()),
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
    // a window made here is shown, and main told, by its first load; it waits on main's handoff, so
    // off the thread that asked, which is the main thread
    let Some(window) = app.get_webview_window(MAIN) else {
        let making = app.clone();
        std::thread::spawn(move || {
            if let Err(error) = create(&making) {
                eprintln!("[shell] could not make the window: {error}");
            }
        });
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

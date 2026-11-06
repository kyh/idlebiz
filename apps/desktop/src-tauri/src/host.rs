//! What main asks of the native app and what it tells it (`apps/cli/src/server/host.ts` is main's
//! end). Every message is read into the shape `protocol.rs` gives it; a request the shell cannot
//! read is refused with the reason, never guessed at.

use std::collections::BTreeSet;
use std::sync::{Mutex, PoisonError};

use serde_json::Value;
use tauri::{AppHandle, Runtime};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

use crate::protocol::{Ask, BoxKind, OpeningKind, Tell};
use crate::{keep_awake, login_item, tray, updater};

pub fn answer<R: Runtime>(
    app: &AppHandle<R>,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    match Ask::read(method, params)? {
        Ask::MessageBox(request) => {
            let kind = match request.kind {
                BoxKind::Info => MessageDialogKind::Info,
                BoxKind::Warning => MessageDialogKind::Warning,
                BoxKind::Error => MessageDialogKind::Error,
            };
            let text = match request.detail {
                Some(detail) => format!("{}\n\n{detail}", request.message),
                None => request.message,
            };
            app.dialog()
                .message(text)
                .title("IdleBiz")
                .kind(kind)
                .blocking_show();
            Ok(Value::Null)
        }
        Ask::CopyText(request) => {
            app.clipboard()
                .write_text(request.text)
                .map_err(|error| error.to_string())?;
            Ok(Value::Null)
        }
        Ask::Open(request) => {
            let opener = app.opener();
            match request.kind {
                OpeningKind::Path => opener.open_path(request.target, None::<&str>),
                OpeningKind::Reveal => opener.reveal_item_in_dir(request.target),
                OpeningKind::Url => opener.open_url(request.target, None::<&str>),
            }
            .map_err(|error| error.to_string())?;
            Ok(Value::Null)
        }
        Ask::LoginItem(request) => {
            let status = match request.on {
                Some(on) => login_item::set(on),
                None => login_item::status(),
            };
            serde_json::to_value(status).map_err(|error| error.to_string())
        }
        Ask::CheckUpdate => {
            serde_json::to_value(updater::check(app)?).map_err(|error| error.to_string())
        }
        Ask::InstallUpdate(request) => {
            updater::install(app, &request.version)?;
            Ok(Value::Null)
        }
    }
}

/// Hears one notification of main's, in the order main sent them.
pub fn hear<R: Runtime>(app: &AppHandle<R>, method: &str, params: Value) {
    match Tell::read(method, params) {
        Ok(Tell::Tray(model)) => tray::draw(app, &model),
        Ok(Tell::KeepAwake(request)) => keep_awake::hold(app, request.on),
        Ok(Tell::Notify(note)) => {
            if let Err(error) = app
                .notification()
                .builder()
                .title(note.title)
                .body(note.body)
                .show()
            {
                log::warn!("could not post a notification: {error}");
            }
        }
        // the save is gone and main has stopped its runs: the app starts again on a new one,
        // through `RunEvent::Exit`, which stops this main before the next one starts
        Ok(Tell::Relaunch) => app.request_restart(),
        Err(reason) => unheard(app, method, &reason),
    }
}

/// The methods a development build has shown a box for.
static UNHEARD: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

/// A notification the shell cannot read is main and the shell disagreeing, and main, waiting on no
/// answer, never hears of it. A development build says so in a box, once a method: main sends its
/// tray model many times a minute.
fn unheard<R: Runtime>(app: &AppHandle<R>, method: &str, reason: &str) {
    log::error!("{reason}");
    if !tauri::is_dev() {
        return;
    }
    let first = UNHEARD
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(method.to_owned());
    if first {
        app.dialog()
            .message(format!(
                "Main sent the shell something it cannot read, so it did nothing with it.\n\n{reason}"
            ))
            .title("The shell and main disagree")
            .kind(MessageDialogKind::Warning)
            .show(|_| {});
    }
}

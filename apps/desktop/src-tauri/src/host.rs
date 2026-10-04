//! What main asks of the native app and what it tells it (`apps/desktop/src/main/host.ts` is main's
//! end). Every request's params are parsed here into the shape main sends; a request the shell
//! cannot read is refused with the reason, never guessed at.

use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Runtime};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

use crate::{keep_awake, login_item, tray};

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum BoxKind {
    Info,
    Warning,
    Error,
}

#[derive(Deserialize)]
struct MessageBox {
    kind: BoxKind,
    message: String,
    detail: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum OpeningKind {
    Path,
    Reveal,
    Url,
}

#[derive(Deserialize)]
struct Opening {
    kind: OpeningKind,
    target: String,
}

#[derive(Deserialize)]
struct CopyText {
    text: String,
}

#[derive(Deserialize)]
struct LoginItem {
    on: Option<bool>,
}

#[derive(Deserialize)]
struct KeepAwake {
    on: bool,
}

#[derive(Deserialize)]
struct Note {
    title: String,
    body: String,
}

fn parsed<T: for<'de> Deserialize<'de>>(method: &str, params: Value) -> Result<T, String> {
    serde_json::from_value(params).map_err(|error| format!("{method}: {error}"))
}

/// Answers one request of main's, on a thread of its own.
pub fn answer<R: Runtime>(
    app: &AppHandle<R>,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    match method {
        "host.messageBox" => {
            let request: MessageBox = parsed(method, params)?;
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
        "host.copyText" => {
            let request: CopyText = parsed(method, params)?;
            app.clipboard()
                .write_text(request.text)
                .map_err(|error| error.to_string())?;
            Ok(Value::Null)
        }
        "host.open" => {
            let request: Opening = parsed(method, params)?;
            let opener = app.opener();
            match request.kind {
                OpeningKind::Path => opener.open_path(request.target, None::<&str>),
                OpeningKind::Reveal => opener.reveal_item_in_dir(request.target),
                OpeningKind::Url => opener.open_url(request.target, None::<&str>),
            }
            .map_err(|error| error.to_string())?;
            Ok(Value::Null)
        }
        "host.loginItem" => {
            let request: LoginItem = parsed(method, params)?;
            let status = match request.on {
                Some(on) => login_item::set(on),
                None => login_item::status(),
            };
            Ok(Value::String(status.to_owned()))
        }
        _ => Err(format!("the shell answers no {method}")),
    }
}

/// Hears one notification of main's, in the order main sent them.
pub fn hear<R: Runtime>(app: &AppHandle<R>, method: &str, params: Value) {
    let heard = match method {
        "host.tray" => parsed(method, params).map(|model| tray::draw(app, &model)),
        "host.keepAwake" => parsed::<KeepAwake>(method, params).map(|request| {
            keep_awake::hold(app, request.on);
        }),
        "host.notify" => parsed::<Note>(method, params).map(|note| {
            if let Err(error) = app
                .notification()
                .builder()
                .title(note.title)
                .body(note.body)
                .show()
            {
                eprintln!("[shell] could not post a notification: {error}");
            }
        }),
        // the save is gone and main has stopped its runs: the app starts again on a new one,
        // through `RunEvent::Exit`, which stops this main before the next one starts
        "host.relaunch" => {
            app.request_restart();
            Ok(())
        }
        _ => Err(format!("the shell hears no {method}")),
    };
    if let Err(reason) = heard {
        eprintln!("[shell] {reason}");
    }
}

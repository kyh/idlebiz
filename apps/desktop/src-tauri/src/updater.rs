//! IdleBiz's own updates, through tauri-plugin-updater: a check of the release feed and an install,
//! each when main asks. The feed and its public key are tauri.conf.json's `plugins.updater`; a
//! build packed with no key takes no updates.
//!
//! An update replaces the server main loads as it goes and the launcher the runs call, so it is
//! installed only once main has stopped its runs: the release is downloaded and its signature
//! checked while the office keeps working, then main stops as a quit stops it, the update replaces
//! the app, and the app starts again.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::async_runtime::block_on;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::protocol::Release;
use crate::shell::{self, Shell};

/// Whether an install has begun, so a second is refused rather than run twice.
static INSTALLING: AtomicBool = AtomicBool::new(false);

fn has_key<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("pubkey"))
        .and_then(serde_json::Value::as_str)
        .is_some_and(|key| !key.is_empty())
}

/// The newest release, when it is newer than this build.
fn newest<R: Runtime>(app: &AppHandle<R>) -> Result<Option<Update>, String> {
    if !app.state::<Shell>().bundled {
        return Err("only the installed app updates itself".to_owned());
    }
    if !has_key(app) {
        return Err(
            "this build was packed without the updater's key, so it takes no updates".to_owned(),
        );
    }
    let updater = app.updater().map_err(|error| error.to_string())?;
    block_on(updater.check()).map_err(|error| error.to_string())
}

pub fn check<R: Runtime>(app: &AppHandle<R>) -> Result<Option<Release>, String> {
    Ok(newest(app)?.map(|update| Release {
        version: update.version,
    }))
}

/// `version`, downloaded with its signature checked; one the feed has moved past is refused.
fn download<R: Runtime>(app: &AppHandle<R>, version: &str) -> Result<(Update, Vec<u8>), String> {
    let update = newest(app)?.ok_or_else(|| "no newer IdleBiz is offered any more".to_owned())?;
    if update.version != version {
        return Err(format!(
            "IdleBiz {} has replaced {version} as the newest",
            update.version
        ));
    }
    let bytes = block_on(update.download(|_, _| {}, || {})).map_err(|error| error.to_string())?;
    Ok((update, bytes))
}

/// Downloads `version`, then, on a thread of its own, stops main, installs it and starts the app
/// again. Blocks for the download alone, which a failure ends with main still running.
pub fn install<R: Runtime>(app: &AppHandle<R>, version: &str) -> Result<(), String> {
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return Err("IdleBiz is already updating".to_owned());
    }
    let (update, bytes) = download(app, version).inspect_err(|_| {
        INSTALLING.store(false, Ordering::SeqCst);
    })?;
    let app = app.clone();
    std::thread::spawn(move || {
        shell::stop(&app);
        if let Err(error) = update.install(&bytes) {
            log::error!("could not install IdleBiz {}: {error}", update.version);
            app.dialog()
                .message(format!(
                    "IdleBiz {} was downloaded but would not install: {error}\n\nIdleBiz opens again on the version it has.",
                    update.version
                ))
                .title("IdleBiz couldn't update")
                .kind(MessageDialogKind::Error)
                .blocking_show();
        }
        // through `RunEvent::Exit`, which finds main already stopped
        app.request_restart();
    });
    Ok(())
}

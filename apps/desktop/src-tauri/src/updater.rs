//! IdleBiz's own updates, through tauri-plugin-updater: a check of the release feed and an install,
//! each when main asks. The feed and its public key are tauri.conf.json's `plugins.updater`; a
//! build packed with no key takes no updates.
//!
//! An update replaces the server main loads as it goes and the launcher the runs call, so it is
//! installed only once main has stopped its runs: the release is downloaded and its signature
//! checked while the office keeps working, then main stops as a quit stops it, the update replaces
//! the app, and the app starts again.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::async_runtime::block_on;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::protocol::Release;
use crate::shell::{self, Shell};

/// Whether an install has begun, so a second is refused rather than run twice.
static INSTALLING: AtomicBool = AtomicBool::new(false);

/// The `touch` the plugin runs by its bare name once it has moved the new app in
/// (tauri-plugin-updater's `install`), on the shell's own PATH. That PATH is launchd's, which any
/// process of the founder's sets for every app opened after it (`launchctl setenv`).
const MACOS_TOUCH: &str = "/usr/bin/touch";

/// The file `execvp` would run for `name` on `path`: the first one there with an execute bit.
fn first_on_path(name: &str, path: Option<&OsStr>) -> Option<PathBuf> {
    std::env::split_paths(path?)
        .map(|dir| dir.join(name))
        .find(|candidate| is_executable(candidate))
}

#[cfg(unix)]
fn is_executable(file: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(file)
        .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable(file: &Path) -> bool {
    file.is_file()
}

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
    // refused before anything is downloaded or stopped: another `touch` would run as the app
    if first_on_path("touch", std::env::var_os("PATH").as_deref()).as_deref()
        != Some(Path::new(MACOS_TOUCH))
    {
        return Err("IdleBiz won't install an update while the PATH apps start with runs a `touch` other than macOS's: something set it with `launchctl setenv PATH`. Undo it (`launchctl unsetenv PATH`) and open IdleBiz again.".to_owned());
    }
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return Err("IdleBiz is already updating".to_owned());
    }
    let (update, bytes) = download(app, version).inspect_err(|_| {
        INSTALLING.store(false, Ordering::SeqCst);
    })?;
    let app = app.clone();
    std::thread::spawn(move || {
        // main stays the shell's as it stops, so a quit meanwhile waits on this same stop
        if let Some(main) = shell::main(&app) {
            main.stop();
        }
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

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    fn write(file: &Path, mode: u32) -> std::io::Result<()> {
        std::fs::write(file, "#!/bin/sh\n")?;
        std::fs::set_permissions(file, std::fs::Permissions::from_mode(mode))
    }

    #[test]
    fn finds_the_first_executable_on_the_path() -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let [folder, unexecutable, first, second] =
            ["folder", "unexecutable", "first", "second"].map(|name| dir.path().join(name));
        for each in [&folder, &unexecutable, &first, &second] {
            std::fs::create_dir(each)?;
        }
        // execvp passes over a folder by the name and a file it may not run
        std::fs::create_dir(folder.join("touch"))?;
        write(&unexecutable.join("touch"), 0o644)?;
        write(&first.join("touch"), 0o755)?;
        write(&second.join("touch"), 0o755)?;
        let path = std::env::join_paths([&folder, &unexecutable, &first, &second])?;
        assert_eq!(
            first_on_path("touch", Some(&path)),
            Some(first.join("touch"))
        );
        let path = std::env::join_paths([&folder, &unexecutable])?;
        assert_eq!(first_on_path("touch", Some(&path)), None);
        Ok(())
    }

    #[test]
    fn finds_nothing_on_no_path() {
        assert_eq!(first_on_path("touch", None), None);
        assert_eq!(first_on_path("touch", Some(OsStr::new(""))), None);
    }

    #[test]
    fn finds_the_system_s_touch_on_the_system_s_path() {
        assert_eq!(
            first_on_path("touch", Some(OsStr::new("/usr/bin:/bin:/usr/sbin:/sbin"))),
            Some(PathBuf::from(MACOS_TOUCH))
        );
    }
}

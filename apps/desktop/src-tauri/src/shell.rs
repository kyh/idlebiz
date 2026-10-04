//! The shell's one state: main, the child that owns the save, and the moves around it. A launch
//! starts main, says hello with what only the shell knows (where the resources are, whether the
//! login item launched it, the Keychain's password), and opens the window, or keeps to the menu bar
//! when the login item launched it. A quit asks main to stop its runs before anything ends.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde_json::{Value, json};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use crate::main_log::{self, MAIN_LOG_MAX_BYTES, MainLog};
use crate::main_process::{Host, MainProcess, MainSpec};
use crate::{host, keychain, runtime, window};

pub struct Shell {
    /// Whether this is the packaged app: its own node and main, the Keychain, the login item.
    pub bundled: bool,
    main: Mutex<Option<Arc<MainProcess>>>,
}

impl Shell {
    pub const fn new(bundled: bool) -> Self {
        Self {
            bundled,
            main: Mutex::new(None),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Option<Arc<MainProcess>>> {
        self.main.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Main, once it has started and until a quit took it.
pub fn main<R: Runtime>(app: &AppHandle<R>) -> Option<Arc<MainProcess>> {
    app.try_state::<Shell>()
        .and_then(|shell| shell.lock().clone())
}

/// Tells main what happened in the window or the menu bar; before main is up there is no one to
/// tell, and nothing to keep.
pub fn tell_main<R: Runtime>(app: &AppHandle<R>, method: &str, params: &Value) {
    if let Some(main) = main(app) {
        main.notify(method, params);
    }
}

/// Whether a fatal box has been shown: a main that dies as it boots fails its hello and is lost at
/// once, on two threads, and the founder hears it once.
static FAILED: AtomicBool = AtomicBool::new(false);

/// Said once and fatal: the office has nothing to show without main.
fn fail<R: Runtime>(app: &AppHandle<R>, title: &str, reason: &str) {
    eprintln!("[shell] {title}: {reason}");
    if FAILED.swap(true, Ordering::SeqCst) {
        return;
    }
    app.dialog()
        .message(reason)
        .title(title)
        .kind(MessageDialogKind::Error)
        .blocking_show();
    app.exit(1);
}

fn logs_dir<R: Runtime>(app: &AppHandle<R>, bundled: bool) -> Result<PathBuf, String> {
    let paths = app.path();
    let home = paths.home_dir().map_err(|error| error.to_string())?;
    let data = paths.data_dir().map_err(|error| error.to_string())?;
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    let override_dir = std::env::var_os("IDLEBIZ_ROOT_DIR").map(PathBuf::from);
    let root = runtime::root_dir(&home, override_dir.as_deref(), &cwd);
    Ok(runtime::logs_dir(bundled, &home, &data, &root))
}

fn spawn_main<R: Runtime>(
    app: &AppHandle<R>,
    log_path: &Path,
) -> Result<(Arc<MainProcess>, runtime::Runtime), String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let resources = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    let resolved = runtime::resolve(&exe, &resources)?;
    let log = Arc::new(Mutex::new(MainLog::new(
        log_path.to_path_buf(),
        MAIN_LOG_MAX_BYTES,
    )));
    let spec = MainSpec {
        node: resolved.node.clone(),
        entry: resolved.main_entry.clone(),
        env: runtime::scrubbed_env(std::env::vars_os()),
        log,
    };
    let answering = app.clone();
    let hearing = app.clone();
    let failing = app.clone();
    let shown_log = log_path.display().to_string();
    let host = Host {
        answer: Box::new(move |method, params| host::answer(&answering, method, params)),
        hear: Box::new(move |method, params| host::hear(&hearing, method, params)),
        lost: Box::new(move |code| {
            let how = code.map_or_else(|| "a signal".to_owned(), |code| format!("code {code}"));
            fail(
                &failing,
                "IdleBiz stopped",
                &format!(
                    "The office stopped unexpectedly ({how}). Your company is saved; open IdleBiz again to carry on.\n\nWhat happened is in {shown_log}."
                ),
            );
        }),
    };
    let process = MainProcess::start(spec, host)?;
    Ok((process, resolved))
}

/// Starts main, boots it and shows the office. Runs off the main thread: a hello waits on main.
pub fn start<R: Runtime>(app: &AppHandle<R>, opened_at_login: bool) {
    let Some(bundled) = app.try_state::<Shell>().map(|shell| shell.bundled) else {
        return;
    };
    let log_path = match logs_dir(app, bundled) {
        Ok(dir) => main_log::main_log_path(&dir),
        Err(reason) => return fail(app, "IdleBiz couldn't start", &reason),
    };
    let (process, resolved) = match spawn_main(app, &log_path) {
        Ok(started) => started,
        Err(reason) => return fail(app, "IdleBiz couldn't start", &reason),
    };
    if let Some(shell) = app.try_state::<Shell>() {
        *shell.lock() = Some(Arc::clone(&process));
    }
    let hello = json!({
        "openedAtLogin": opened_at_login,
        "packaged": bundled,
        "resourcesDir": resolved.resources_dir,
        "safeStoragePassword": keychain::safe_storage_password(bundled),
    });
    let booted = tauri::async_runtime::block_on(process.request("hello", &hello));
    if let Err(reason) = booted {
        return fail(
            app,
            "IdleBiz couldn't start",
            &format!(
                "The office could not open your company: {reason}\n\nWhat happened is in {}.",
                log_path.display()
            ),
        );
    }
    if opened_at_login {
        // a launch at login keeps to the menu bar until the founder opens the office
        #[cfg(target_os = "macos")]
        if let Err(error) = app.set_dock_visibility(false) {
            eprintln!("[shell] could not hide the dock icon: {error}");
        }
        return;
    }
    if let Err(error) = window::create(app) {
        fail(
            app,
            "IdleBiz couldn't start",
            &format!("The window would not open: {error}"),
        );
    }
}

/// Asks main to stop its runs and waits for it, then lets it go. Blocks: a quit has no later step
/// to wait in.
pub fn stop<R: Runtime>(app: &AppHandle<R>) {
    let taken = app
        .try_state::<Shell>()
        .and_then(|shell| shell.lock().take());
    if let Some(main) = taken {
        main.stop();
    }
}

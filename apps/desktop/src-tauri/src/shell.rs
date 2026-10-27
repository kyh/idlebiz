//! The shell's one state: main, the child that owns the save, and the moves around it.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use crate::main_log::{self, MAIN_LOG_MAX_BYTES, MainLog};
use crate::main_process::{Host, MainProcess, MainSpec, RequestError, describe};
use crate::protocol::Hello;
use crate::{host, keychain, runtime, shell_log, window};

/// How long main has to boot once it is said hello to: it opens the save, the control plane and
/// the page's server, and waits on nothing of the founder's.
const HELLO_TIMEOUT: Duration = Duration::from_secs(60);

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
    app.state::<Shell>().lock().clone()
}

/// Tells main what happened in the window or the menu bar; before main is up there is no one to
/// tell, and nothing to keep.
pub fn tell_main<R: Runtime>(app: &AppHandle<R>, method: &str, params: &impl Serialize) {
    let Some(main) = main(app) else {
        return;
    };
    match serde_json::to_value(params) {
        Ok(params) => main.notify(method, &params),
        Err(error) => log::warn!("could not tell main {method}: {error}"),
    }
}

/// Whether a fatal box has been shown: a main that dies as it boots fails its hello and is lost at
/// once, on two threads, and the founder hears it once.
static FAILED: AtomicBool = AtomicBool::new(false);

/// Said once and fatal: the office has nothing to show without main.
fn fail<R: Runtime>(app: &AppHandle<R>, title: &str, reason: &str) {
    log::error!("{title}: {reason}");
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

fn spawn_main<R: Runtime>(app: &AppHandle<R>, log_path: &Path) -> Result<Arc<MainProcess>, String> {
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
    shell_log::write_to(Arc::clone(&log));
    let spec = MainSpec {
        node: resolved.node.clone(),
        entry: resolved.serve_entry(),
        args: runtime::SERVE_ARGS.map(str::to_owned).to_vec(),
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
            let how = describe(code);
            fail(
                &failing,
                "IdleBiz stopped",
                &format!(
                    "The office stopped unexpectedly ({how}). Your company is saved; open IdleBiz again to carry on.\n\nWhat happened is in {shown_log}."
                ),
            );
        }),
    };
    MainProcess::start(spec, host)
}

/// Starts main, boots it and shows the office. Runs off the main thread: a hello waits on main.
pub fn start<R: Runtime>(app: &AppHandle<R>, opened_at_login: bool) {
    let shell = app.state::<Shell>();
    let bundled = shell.bundled;
    let log_path = match logs_dir(app, bundled) {
        Ok(dir) => main_log::main_log_path(&dir),
        Err(reason) => return fail(app, "IdleBiz couldn't start", &reason),
    };
    let process = match spawn_main(app, &log_path) {
        Ok(started) => started,
        Err(reason) => return fail(app, "IdleBiz couldn't start", &reason),
    };
    *shell.lock() = Some(Arc::clone(&process));
    // under `tauri dev` main hands the page the dev server's files, so an edit reloads in place
    // while the window keeps main's origin
    let page_dev_url = app
        .config()
        .build
        .dev_url
        .as_ref()
        .filter(|_| tauri::is_dev())
        .map(ToString::to_string);
    let hello = serde_json::to_value(Hello {
        opened_at_login,
        packaged: bundled,
        page_dev_url,
        sealing_key: keychain::sealing_key(bundled),
    });
    let hello = match hello {
        Ok(hello) => hello,
        Err(error) => return fail(app, "IdleBiz couldn't start", &error.to_string()),
    };
    if let Err(failure) = process.boot(&hello, HELLO_TIMEOUT) {
        let mut held = shell.lock();
        // a quit took main as it booted, and ends the app itself
        if held.is_none() {
            return;
        }
        // a boot that ran out of time killed main: no quit is left to ask of it
        if matches!(failure, RequestError::TimedOut(_)) {
            held.take();
        }
        // the box below blocks until it is closed, and a quit meanwhile waits on this lock
        drop(held);
        let what = match failure {
            RequestError::TimedOut(within) => format!(
                "The office did not finish starting within {} seconds, so IdleBiz stopped it. Open IdleBiz again to try once more.",
                within.as_secs()
            ),
            failure => format!("The office could not open your company: {failure}"),
        };
        return fail(
            app,
            "IdleBiz couldn't start",
            &format!("{what}\n\nWhat happened is in {}.", log_path.display()),
        );
    }
    if opened_at_login {
        // a launch at login keeps to the menu bar until the founder opens the office
        #[cfg(target_os = "macos")]
        if let Err(error) = app.set_dock_visibility(false) {
            log::warn!("could not hide the dock icon: {error}");
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
    let taken = app.state::<Shell>().lock().take();
    if let Some(main) = taken {
        main.stop();
    }
}

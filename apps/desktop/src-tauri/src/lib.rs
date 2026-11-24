//! The IdleBiz desktop shell: a window over the page main serves, and main as its one child.

mod host;
mod keep_awake;
mod login_item;
mod main_log;
mod main_process;
mod navigation;
mod protocol;
mod relay;
mod runtime;
mod shell;
mod shell_log;
mod tray;
mod updater;
mod vault;
mod window;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Manager, RunEvent, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use crate::main_log::{MAIN_LOG_MAX_BYTES, MainLog};
use crate::main_process::{Host, MainProcess, MainSpec, RequestError, describe};
use crate::protocol::Hello;
use crate::runtime::Packaged;
use crate::shell::Shell;

/// How long main has to boot once it is said hello to: it opens the save, the control plane and
/// the page's server, and waits on nothing of the founder's.
const HELLO_TIMEOUT: Duration = Duration::from_secs(60);

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

/// Who the packaged app's main runs as, from the system, and the save its `--root=` names; a
/// development shell's main keeps its terminal's env (`runtime::main_env`).
fn packaged_launch(bundled: bool) -> Result<Option<Packaged>, String> {
    if !bundled {
        return Ok(None);
    }
    Ok(Some(Packaged {
        account: runtime::account()?,
        root: runtime::root_arg(std::env::args_os().skip(1)),
    }))
}

/// The packaged app's log goes in the account's home, never in one launchd's env names.
fn logs_dir<R: Runtime>(
    app: &AppHandle<R>,
    packaged: Option<&Packaged>,
) -> Result<PathBuf, String> {
    let paths = app.path();
    let data = paths.data_dir().map_err(|error| error.to_string())?;
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    let (home, override_dir) = match packaged {
        Some(packaged) => (packaged.account.home.clone(), packaged.root.clone()),
        None => (
            paths.home_dir().map_err(|error| error.to_string())?,
            std::env::var_os("IDLEBIZ_ROOT_DIR").map(PathBuf::from),
        ),
    };
    let root = runtime::root_dir(&home, override_dir.as_deref(), &cwd);
    Ok(runtime::logs_dir(packaged.is_some(), &home, &data, &root))
}

fn spawn_main<R: Runtime>(
    app: &AppHandle<R>,
    log_path: &Path,
    packaged: Option<&Packaged>,
) -> Result<Arc<MainProcess>, String> {
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
        env: runtime::main_env(std::env::vars_os(), packaged),
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
fn start<R: Runtime>(app: &AppHandle<R>, opened_at_login: bool) {
    let shell = app.state::<Shell>();
    let bundled = shell.bundled;
    // a system that cannot say who the founder is starts no main, rather than one on launchd's word
    let packaged = match packaged_launch(bundled) {
        Ok(packaged) => packaged,
        Err(reason) => return fail(app, "IdleBiz couldn't start", &reason),
    };
    let log_path = match logs_dir(app, packaged.as_ref()) {
        Ok(dir) => main_log::main_log_path(&dir),
        Err(reason) => return fail(app, "IdleBiz couldn't start", &reason),
    };
    let process = match spawn_main(app, &log_path, packaged.as_ref()) {
        Ok(started) => started,
        Err(reason) => return fail(app, "IdleBiz couldn't start", &reason),
    };
    shell.hold(Arc::clone(&process));
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
        vault: vault::open(bundled),
    });
    let hello = match hello {
        Ok(hello) => hello,
        Err(error) => return fail(app, "IdleBiz couldn't start", &error.to_string()),
    };
    if let Err(failure) = process.boot(&hello, HELLO_TIMEOUT) {
        // a boot that ran out of time killed main; the box below blocks until it is closed, and a
        // quit meanwhile waits on the shell's lock, so it is let go first
        if !shell.failed_boot(matches!(failure, RequestError::TimedOut(_))) {
            return;
        }
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
fn stop<R: Runtime>(app: &AppHandle<R>) {
    let taken = app.state::<Shell>().take();
    if let Some(main) = taken {
        main.stop();
    }
}

/// SIGTERM and SIGINT quit as Quit does, so main stops its runs first: a `kill`, launchd at
/// shutdown and Ctrl-C under `tauri dev` all wait the agents out. A handler, not a blocked mask:
/// nothing of it reaches the children the shell starts.
#[cfg(unix)]
fn quit_on_signals<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use signal_hook::consts::{SIGINT, SIGTERM};
    use signal_hook::iterator::Signals;
    match Signals::new([SIGTERM, SIGINT]) {
        Ok(mut signals) => {
            let app = app.clone();
            std::thread::spawn(move || {
                if signals.forever().next().is_some() {
                    app.exit(0);
                }
            });
        }
        Err(error) => log::warn!("a SIGTERM will not stop the runs first: {error}"),
    }
}

pub fn run() {
    shell_log::init();
    let bundled = std::env::current_exe().is_ok_and(|exe| runtime::is_bundled(&exe));

    let mut builder = tauri::Builder::default();
    // first, as the plugin asks: a second launch hands over to this one, which shows its window,
    // where the second's main would be refused the save. The packaged app alone: the plugin keys on
    // the bundle id, machine-wide, so a development shell would otherwise hand over to an installed
    // IdleBiz and quit; on that one's save, its main is refused instead (`save-claim.ts`)
    if bundled {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            window::show(app);
        }));
    }
    let built = builder
        .plugin(tauri_plugin_clipboard_manager::init())
        // shown from Rust alone, yet each puts its script in the page, as every plugin does: there
        // `alert`, `confirm` and `Notification` ask for commands no page is granted (docs/app.md)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        // checked and installed from Rust alone (host/updater.rs), when main asks
        .plugin(tauri_plugin_updater::Builder::new().build())
        // only Rust opens links (window.rs): the plugin's own script would catch a `_blank` click
        // and ask for a command no page is granted, so the link would do nothing
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .manage(Shell::new(bundled))
        .setup(|app| {
            #[cfg(unix)]
            quit_on_signals(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!());

    let app = match built {
        Ok(app) => app,
        Err(error) => {
            log::error!("IdleBiz failed to start: {error}");
            std::process::exit(1);
        }
    };
    app.run(move |app, event| match event {
        // the login item's open-application event is read as the app finishes launching, and only
        // then; main starts off the main thread, since its hello waits on it
        RunEvent::Ready => {
            let opened_at_login = bundled && login_item::launched_at_login();
            let starting = app.clone();
            std::thread::spawn(move || start(&starting, opened_at_login));
        }
        // closing the window keeps the office running in the menu bar; Quit is the way out
        RunEvent::ExitRequested {
            code: None, api, ..
        } => api.prevent_exit(),
        // Cmd+Q ends in applicationWillTerminate, with nothing after it to wait in, so main's
        // stopping of the runs is waited for here
        RunEvent::Exit => stop(app),
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => window::show(app),
        _ => {}
    });
}

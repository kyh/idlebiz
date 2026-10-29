//! The IdleBiz desktop shell: a window over the page main serves, and main as its one child.

mod host;
mod keep_awake;
mod keychain;
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
mod window;

use tauri::RunEvent;

use crate::shell::Shell;

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
        // checked and installed from Rust alone (updater.rs), when main asks
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
            std::thread::spawn(move || shell::start(&starting, opened_at_login));
        }
        // closing the window keeps the office running in the menu bar; Quit is the way out
        RunEvent::ExitRequested {
            code: None, api, ..
        } => api.prevent_exit(),
        // Cmd+Q ends in applicationWillTerminate, with nothing after it to wait in, so main's
        // stopping of the runs is waited for here
        RunEvent::Exit => shell::stop(app),
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => window::show(app),
        _ => {}
    });
}

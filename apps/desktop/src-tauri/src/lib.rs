//! The IdleBiz desktop shell: a Rust window over the office page main serves, main (the node process
//! that owns the save, the keys and the runs) as the one child it supervises, and what only a native
//! app can do for main: the menu-bar icon, message boxes, notifications, the clipboard, Finder, the
//! login item and keeping the Mac awake. The page reaches no command of the shell's.

mod host;
mod keep_awake;
mod keychain;
mod login_item;
mod main_log;
mod main_process;
mod navigation;
mod relay;
mod runtime;
mod shell;
mod tray;
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
        Err(error) => eprintln!("[shell] a SIGTERM will not stop the runs first: {error}"),
    }
}

pub fn run() {
    let bundled = std::env::current_exe().is_ok_and(|exe| runtime::is_bundled(&exe));

    let mut builder = tauri::Builder::default();
    // first, as the plugin asks: a second launch hands over to this one, since two mains would race
    // for one save. The packaged app alone: the plugin keys on the bundle id, machine-wide, so a
    // development shell would otherwise hand over to an installed IdleBiz and quit
    if bundled {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            window::show(app);
        }));
    }
    let built = builder
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
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
            eprintln!("[shell] IdleBiz failed to start: {error}");
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

//! The shell's one state: main, the child that owns the save, from the hello until a quit takes it.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

use crate::main_process::MainProcess;

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

    /// Holds main once it has started, before its hello, so a quit meanwhile can stop it.
    pub fn hold(&self, main: Arc<MainProcess>) {
        *self.lock() = Some(main);
    }

    /// Lets main go, for a quit to stop it.
    pub fn take(&self) -> Option<Arc<MainProcess>> {
        self.lock().take()
    }

    /// Whether main was still the shell's when its boot failed, or a quit had taken it, which ends
    /// the app itself. A main the boot `killed` is let go, since no quit is left to ask of it.
    pub fn failed_boot(&self, killed: bool) -> bool {
        let mut held = self.lock();
        if held.is_none() {
            return false;
        }
        if killed {
            held.take();
        }
        true
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

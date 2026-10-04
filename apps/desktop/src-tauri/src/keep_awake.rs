//! Holds the Mac out of idle sleep while main asks (a run is in flight): a user-initiated activity
//! on the process, which is what Electron's `prevent-app-suspension` held. It stops idle sleep and
//! App Nap, never the display's sleep and never past a closed lid. The activity is begun and ended
//! on the main thread, which keeps it.

use tauri::{AppHandle, Runtime};

pub fn hold<R: Runtime>(app: &AppHandle<R>, on: bool) {
    if let Err(error) = app.run_on_main_thread(move || platform::hold(on)) {
        eprintln!("[shell] could not hold the Mac awake: {error}");
    }
}

#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
mod platform {
    use std::cell::RefCell;

    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2_foundation::{NSActivityOptions, NSObjectProtocol, NSProcessInfo, NSString};

    thread_local! {
        static HELD: RefCell<Option<Retained<ProtocolObject<dyn NSObjectProtocol>>>> =
            const { RefCell::new(None) };
    }

    pub fn hold(on: bool) {
        HELD.with_borrow_mut(|held| {
            let info = NSProcessInfo::processInfo();
            if on && held.is_none() {
                *held = Some(info.beginActivityWithOptions_reason(
                    NSActivityOptions::UserInitiated,
                    &NSString::from_str("IdleBiz's team is working"),
                ));
            } else if !on && let Some(activity) = held.take() {
                // SAFETY: the token is the one `beginActivityWithOptions:reason:` answered
                unsafe { info.endActivity(&activity) };
            }
        });
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    pub const fn hold(_on: bool) {}
}

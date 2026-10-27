//! Open at login is the app's own login item, `SMAppService.mainApp`: macOS keeps the only record,
//! and what it answers is read back after every change. A launch it made is told by the
//! open-application Apple event the app starts with, read as the app finishes launching
//! (`RunEvent::Ready`).

use crate::protocol::LaunchAtLogin;

pub fn status() -> LaunchAtLogin {
    platform::status()
}

pub fn set(on: bool) -> LaunchAtLogin {
    platform::set(on);
    platform::status()
}

/// Whether this launch is the login item's. Only meaningful on the main thread, at launch.
pub fn launched_at_login() -> bool {
    platform::launched_at_login()
}

#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
mod platform {
    use objc2::rc::Retained;
    use objc2_foundation::NSAppleEventManager;
    use objc2_service_management::{SMAppService, SMAppServiceStatus};

    use crate::protocol::LaunchAtLogin;

    const OPEN_APPLICATION: u32 = u32::from_be_bytes(*b"oapp");
    const PROPERTY_DATA: u32 = u32::from_be_bytes(*b"prdt");
    const LAUNCHED_AS_LOGIN_ITEM: u32 = u32::from_be_bytes(*b"lgit");

    fn service() -> Retained<SMAppService> {
        // SAFETY: a class method that takes nothing and answers this app's own service
        unsafe { SMAppService::mainAppService() }
    }

    pub fn status() -> LaunchAtLogin {
        // SAFETY: reads the registration's status, and takes nothing
        let status = unsafe { service().status() };
        if status == SMAppServiceStatus::Enabled {
            LaunchAtLogin::On
        } else if status == SMAppServiceStatus::RequiresApproval {
            LaunchAtLogin::RequiresApproval
        } else if status == SMAppServiceStatus::NotFound {
            LaunchAtLogin::NotFound
        } else {
            LaunchAtLogin::Off
        }
    }

    pub fn set(on: bool) {
        let service = service();
        // SAFETY: registers or unregisters this app's own login item; a refusal is an NSError,
        // reported here, and the status main is answered with is read back either way
        let done = unsafe {
            if on {
                service.registerAndReturnError()
            } else {
                service.unregisterAndReturnError()
            }
        };
        if let Err(error) = done {
            log::warn!("macOS refused the login item: {error}");
        }
    }

    pub fn launched_at_login() -> bool {
        let Some(event) = NSAppleEventManager::sharedAppleEventManager().currentAppleEvent() else {
            return false;
        };
        event.eventID() == OPEN_APPLICATION
            && event
                .paramDescriptorForKeyword(PROPERTY_DATA)
                .is_some_and(|data| data.enumCodeValue() == LAUNCHED_AS_LOGIN_ITEM)
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use crate::protocol::LaunchAtLogin;

    pub const fn status() -> LaunchAtLogin {
        LaunchAtLogin::Unavailable
    }

    pub const fn set(_on: bool) {}

    pub const fn launched_at_login() -> bool {
        false
    }
}

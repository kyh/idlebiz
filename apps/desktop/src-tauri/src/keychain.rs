//! The password that seals `secrets.json`, kept in the Keychain where Electron's safeStorage kept
//! it: service "IdleBiz Safe Storage", account "IdleBiz". The signed app reads it with no prompt,
//! being the app that wrote it (the same bundle id and team), and hands it to main over main's
//! stdin. Main never reaches the Keychain. A missing item is made as Chromium made it: 16 random
//! bytes, base64. Main derives the key and seals (`apps/desktop/src/main/lib/os-crypt.ts`).

/// Chromium's mock keychain's answer, which a development build sealed with, so an isolated dev
/// save still opens.
const MOCK_PASSWORD: &str = "mock_password";

/// The password, or `None` when the Keychain would not answer: main then keeps keys as plain text
/// and says so.
pub fn safe_storage_password(bundled: bool) -> Option<String> {
    if bundled {
        platform::read_or_create()
    } else {
        Some(MOCK_PASSWORD.to_owned())
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use base64::Engine as _;
    use security_framework::passwords::{get_generic_password, set_generic_password};

    const SERVICE: &str = "IdleBiz Safe Storage";
    const ACCOUNT: &str = "IdleBiz";
    const ITEM_NOT_FOUND: i32 = -25_300;

    pub fn read_or_create() -> Option<String> {
        match get_generic_password(SERVICE, ACCOUNT) {
            Ok(bytes) => String::from_utf8(bytes).ok(),
            Err(error) if error.code() == ITEM_NOT_FOUND => {
                let mut random = [0_u8; 16];
                getrandom::fill(&mut random).ok()?;
                let password = base64::engine::general_purpose::STANDARD.encode(random);
                match set_generic_password(SERVICE, ACCOUNT, password.as_bytes()) {
                    Ok(()) => Some(password),
                    Err(error) => {
                        eprintln!("[shell] the Keychain would not keep IdleBiz's key: {error}");
                        None
                    }
                }
            }
            Err(error) => {
                eprintln!("[shell] the Keychain would not give IdleBiz its key: {error}");
                None
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    pub const fn read_or_create() -> Option<String> {
        None
    }
}

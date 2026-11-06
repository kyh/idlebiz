//! The key that seals `secrets.json`, kept in the Keychain as service "IdleBiz", account
//! "sealing-key": 32 random bytes, base64, made on the first launch that finds none. The signed app
//! reads it with no prompt, being the app that made it (the same bundle id and team), and hands it
//! to main over main's stdin; main seals with it (`apps/cli/src/server/secrets.ts`) and never
//! reaches the Keychain.

/// The key, or `None` when this is a development build, which never touches the Keychain (main
/// seals a dev save with its own key), or when the Keychain would not answer: main then keeps keys
/// as plain text and says so.
pub fn sealing_key(bundled: bool) -> Option<String> {
    if bundled {
        platform::read_or_create()
    } else {
        None
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;
    use security_framework::passwords::{get_generic_password, set_generic_password};

    const SERVICE: &str = "IdleBiz";
    const ACCOUNT: &str = "sealing-key";
    const KEY_BYTES: usize = 32;
    const ITEM_NOT_FOUND: i32 = -25_300;

    pub fn read_or_create() -> Option<String> {
        match get_generic_password(SERVICE, ACCOUNT) {
            Ok(bytes) => {
                let key = String::from_utf8(bytes).ok().filter(|key| is_key(key));
                if key.is_none() {
                    log::warn!("the Keychain's IdleBiz key is not {KEY_BYTES} bytes of base64");
                }
                key
            }
            Err(error) if error.code() == ITEM_NOT_FOUND => {
                let key = new_key()?;
                match set_generic_password(SERVICE, ACCOUNT, key.as_bytes()) {
                    Ok(()) => Some(key),
                    Err(error) => {
                        log::warn!("the Keychain would not keep IdleBiz's key: {error}");
                        None
                    }
                }
            }
            Err(error) => {
                log::warn!("the Keychain would not give IdleBiz its key: {error}");
                None
            }
        }
    }

    fn new_key() -> Option<String> {
        let mut random = [0_u8; KEY_BYTES];
        getrandom::fill(&mut random).ok()?;
        Some(STANDARD.encode(random))
    }

    fn is_key(text: &str) -> bool {
        STANDARD
            .decode(text)
            .is_ok_and(|bytes| bytes.len() == KEY_BYTES)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn a_new_key_is_one_main_takes() {
            assert!(new_key().is_some_and(|key| is_key(&key)));
            assert_ne!(new_key(), new_key());
        }

        #[test]
        fn refuses_anything_but_32_bytes_of_base64() {
            assert!(!is_key(&STANDARD.encode([0_u8; 16])));
            assert!(!is_key("not base64"));
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    pub const fn read_or_create() -> Option<String> {
        None
    }
}

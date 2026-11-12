//! The vault: IdleBiz's keys, one generic-password item each in the login keychain, service
//! "IdleBiz", account the key's name. The signed app reads and writes its own items with no prompt,
//! being the app that made them (the same bundle id and team); another program asking gets a
//! prompt, never the key. The shell reads them all at hello and hands them to main over its stdin,
//! and keeps each main sets or deletes over the relay (`host.vaultSet`, `host.vaultDelete`); main
//! never reaches the Keychain itself (`apps/cli/src/server/vault/`).

use std::collections::BTreeMap;

use serde::Serialize;

const SERVICE: &str = "IdleBiz";

/// What the vault held at hello: each key it read, and the name of each it would not give.
#[derive(Serialize)]
#[cfg_attr(test, derive(serde::Deserialize), serde(deny_unknown_fields))]
pub struct Held {
    pub keys: BTreeMap<String, String>,
    pub refused: Vec<String>,
}

/// The vault's keys, or `None` for a development build, which keeps its keys in a file under its
/// save (main's), or when the Keychain would not list them: main then holds none and says so.
pub fn open(bundled: bool) -> Option<Held> {
    if !bundled {
        return None;
    }
    let held = platform::held(SERVICE)?;
    // a count, never a name: the smokes read it to know each pack read the Keychain with no prompt
    log::info!("the Keychain gave IdleBiz {} of its keys", held.keys.len());
    Some(held)
}

/// Keeps `value` under `name`, in place of any value it had.
pub fn set(name: &str, value: &str) -> Result<(), String> {
    platform::set(SERVICE, name, value)
}

/// Forgets `name`; one the vault never held is already forgotten.
pub fn delete(name: &str) -> Result<(), String> {
    platform::delete(SERVICE, name)
}

#[cfg(target_os = "macos")]
mod platform {
    use std::collections::BTreeMap;

    use security_framework::item::{ItemClass, ItemSearchOptions, Limit};
    use security_framework::passwords::{
        delete_generic_password, get_generic_password, set_generic_password,
    };

    use super::Held;

    const ITEM_NOT_FOUND: i32 = -25_300;
    // the account attribute, as `simplify_dict` names it
    const ACCOUNT: &str = "acct";

    pub fn held(service: &str) -> Option<Held> {
        let accounts = match ItemSearchOptions::new()
            .class(ItemClass::generic_password())
            .service(service)
            .load_attributes(true)
            .limit(Limit::All)
            .search()
        {
            Ok(found) => found
                .iter()
                .filter_map(|item| item.simplify_dict()?.remove(ACCOUNT))
                .collect(),
            Err(error) if error.code() == ITEM_NOT_FOUND => Vec::new(),
            Err(error) => {
                log::warn!("the Keychain would not list IdleBiz's keys: {error}");
                return None;
            }
        };
        let mut held = Held {
            keys: BTreeMap::new(),
            refused: Vec::new(),
        };
        for account in accounts {
            match get_generic_password(service, &account)
                .map_err(|error| error.to_string())
                .and_then(|bytes| String::from_utf8(bytes).map_err(|error| error.to_string()))
            {
                Ok(value) => {
                    held.keys.insert(account, value);
                }
                Err(error) => {
                    log::warn!("the Keychain would not give IdleBiz its {account}: {error}");
                    held.refused.push(account);
                }
            }
        }
        Some(held)
    }

    pub fn set(service: &str, name: &str, value: &str) -> Result<(), String> {
        set_generic_password(service, name, value.as_bytes())
            .map_err(|error| format!("the Keychain would not keep {name}: {error}"))
    }

    pub fn delete(service: &str, name: &str) -> Result<(), String> {
        match delete_generic_password(service, name) {
            Err(error) if error.code() != ITEM_NOT_FOUND => {
                Err(format!("the Keychain would not forget {name}: {error}"))
            }
            _ => Ok(()),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// A service of the test's own, so no real IdleBiz item is touched.
        fn service() -> String {
            format!("IdleBiz test {}", std::process::id())
        }

        #[test]
        fn keeps_reads_back_replaces_and_forgets_a_key() -> Result<(), String> {
            let service = service();
            let empty = held(&service).ok_or("the Keychain lists an empty service")?;
            assert!(empty.keys.is_empty() && empty.refused.is_empty());
            set(&service, "ENV/acme/prj_1/API_KEY", "first")?;
            set(&service, "ENV/acme/prj_1/API_KEY", "second")?;
            set(&service, "VERCEL_TOKEN", "vt")?;
            let read = held(&service).ok_or("the Keychain lists the keys")?;
            delete(&service, "ENV/acme/prj_1/API_KEY")?;
            delete(&service, "VERCEL_TOKEN")?;
            // forgetting twice is no error
            delete(&service, "VERCEL_TOKEN")?;
            assert_eq!(
                read.keys,
                BTreeMap::from([
                    ("ENV/acme/prj_1/API_KEY".to_owned(), "second".to_owned()),
                    ("VERCEL_TOKEN".to_owned(), "vt".to_owned()),
                ])
            );
            assert!(held(&service).is_some_and(|after| after.keys.is_empty()));
            Ok(())
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::Held;

    pub const fn held(_service: &str) -> Option<Held> {
        None
    }

    pub fn set(_service: &str, name: &str, _value: &str) -> Result<(), String> {
        Err(format!("no Keychain keeps {name} off a Mac"))
    }

    pub fn delete(_service: &str, name: &str) -> Result<(), String> {
        Err(format!("no Keychain holds {name} off a Mac"))
    }
}

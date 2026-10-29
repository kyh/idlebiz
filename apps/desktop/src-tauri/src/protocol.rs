//! What the shell and main say over `relay.rs`'s framing, pinned to main's end
//! (`apps/cli/src/server/host.ts`) by one sample a method under `tests/fixtures/relay`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const HELLO: &str = "hello";
pub const HANDOFF: &str = "handoff";
pub const QUIT: &str = "quit";
pub const WINDOW: &str = "window";
/// A click on the menu-bar icon's autopilot item, which the shell tells main; `TRAY` is main's
/// model of the icon, which main tells the shell.
pub const TRAY_CLICK: &str = "tray";
/// A click on the menu-bar icon's update item, which the shell tells main: main installs the
/// release it offers, as Settings' button does.
pub const UPDATE_CLICK: &str = "update";
pub const MESSAGE_BOX: &str = "host.messageBox";
pub const COPY_TEXT: &str = "host.copyText";
pub const OPEN: &str = "host.open";
pub const LOGIN_ITEM: &str = "host.loginItem";
pub const NOTIFY: &str = "host.notify";
pub const TRAY: &str = "host.tray";
pub const KEEP_AWAKE: &str = "host.keepAwake";
pub const RELAUNCH: &str = "host.relaunch";
pub const CHECK_UPDATE: &str = "host.checkUpdate";
pub const INSTALL_UPDATE: &str = "host.installUpdate";

/// What only the shell knows of this launch (`launchSchema`).
#[derive(Serialize)]
#[cfg_attr(test, derive(Deserialize), serde(deny_unknown_fields))]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    /// A launch at login starts in the menu bar.
    pub opened_at_login: bool,
    pub packaged: bool,
    /// The dev server under `tauri dev`, whose files main hands the page in place of the built ones.
    pub page_dev_url: Option<String>,
    /// The key the Keychain keeps for sealing main's secrets, 32 bytes in base64; none in a
    /// development build, which never touches the Keychain, or when the Keychain would not answer.
    pub sealing_key: Option<String>,
}

/// What main answers `handoff` with: a link into its page, and the origin it is on.
#[derive(Deserialize)]
#[cfg_attr(test, derive(Serialize))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Handoff {
    pub handoff_url: String,
    pub origin: String,
}

#[derive(Serialize)]
#[cfg_attr(test, derive(Deserialize))]
#[serde(rename_all = "lowercase")]
pub enum WindowState {
    Blurred,
    Minimized,
    Hidden,
    Shown,
}

#[derive(Serialize)]
#[cfg_attr(test, derive(Deserialize), serde(deny_unknown_fields))]
pub struct WindowChange {
    pub state: WindowState,
}

/// A click on the autopilot item, with the state its label promised.
#[derive(Serialize)]
#[cfg_attr(test, derive(Deserialize), serde(deny_unknown_fields))]
pub struct TrayClick {
    pub on: bool,
}

#[derive(Deserialize)]
#[cfg_attr(test, derive(Serialize))]
#[serde(rename_all = "lowercase")]
pub enum BoxKind {
    Info,
    Warning,
    Error,
}

#[derive(Deserialize)]
#[cfg_attr(test, derive(Serialize))]
#[serde(deny_unknown_fields)]
pub struct MessageBox {
    pub kind: BoxKind,
    pub message: String,
    pub detail: Option<String>,
}

#[derive(Deserialize)]
#[cfg_attr(test, derive(Serialize))]
#[serde(rename_all = "lowercase")]
pub enum OpeningKind {
    Path,
    Reveal,
    Url,
}

#[derive(Deserialize)]
#[cfg_attr(test, derive(Serialize))]
#[serde(deny_unknown_fields)]
pub struct Opening {
    pub kind: OpeningKind,
    pub target: String,
}

#[derive(Deserialize)]
#[cfg_attr(test, derive(Serialize))]
#[serde(deny_unknown_fields)]
pub struct CopyText {
    pub text: String,
}

/// Sets the login item first, or only reads it.
#[derive(Deserialize)]
#[cfg_attr(test, derive(Serialize))]
#[serde(deny_unknown_fields)]
pub struct LoginItem {
    pub on: Option<bool>,
}

/// What the shell answers `host.loginItem` with: what macOS says of the login item, read back
/// after every change, or `Unavailable` where there is none to have.
#[derive(Serialize)]
#[cfg_attr(test, derive(Deserialize))]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(all(not(target_os = "macos"), not(test)), expect(dead_code))]
pub enum LaunchAtLogin {
    On,
    Off,
    RequiresApproval,
    NotFound,
    /// Main's own answer for a launch with no login item; of the shell's, only off a Mac.
    #[cfg_attr(all(target_os = "macos", not(test)), expect(dead_code))]
    Unavailable,
}

#[derive(Deserialize)]
#[cfg_attr(test, derive(Serialize))]
#[serde(deny_unknown_fields)]
pub struct KeepAwake {
    pub on: bool,
}

#[derive(Deserialize)]
#[cfg_attr(test, derive(Serialize))]
#[serde(deny_unknown_fields)]
pub struct Note {
    pub title: String,
    pub body: String,
}

#[derive(Deserialize)]
#[cfg_attr(test, derive(Serialize))]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum TrayItem {
    Open {
        label: String,
    },
    Status {
        label: String,
    },
    /// `on` is what a click sets: what the label said when the menu was drawn.
    Autopilot {
        label: String,
        enabled: bool,
        on: bool,
    },
    /// A struct, not a unit: serde drops a unit variant's other fields unread.
    Separator {},
    /// Has main install the release it offers.
    Update {
        label: String,
    },
    Quit {
        label: String,
    },
}

/// The menu-bar icon as main decides it: the title beside the icon, its tooltip and its menu.
#[derive(Deserialize)]
#[cfg_attr(test, derive(Serialize))]
#[serde(deny_unknown_fields)]
pub struct TrayModel {
    pub title: String,
    pub tooltip: String,
    pub items: Vec<TrayItem>,
}

/// A release newer than this build, which `host.checkUpdate` answers with; none is null.
#[derive(Serialize)]
#[cfg_attr(test, derive(Deserialize), serde(deny_unknown_fields))]
pub struct Release {
    pub version: String,
}

/// Installs the release main offered, by its version: one the feed has since moved past is refused.
#[derive(Deserialize)]
#[cfg_attr(test, derive(Serialize))]
#[serde(deny_unknown_fields)]
pub struct InstallUpdate {
    pub version: String,
}

fn parsed<T: for<'de> Deserialize<'de>>(method: &str, params: Value) -> Result<T, String> {
    serde_json::from_value(params).map_err(|error| format!("{method}: {error}"))
}

/// One of main's requests, read.
#[cfg_attr(test, derive(Serialize), serde(untagged))]
pub enum Ask {
    MessageBox(MessageBox),
    CopyText(CopyText),
    Open(Opening),
    LoginItem(LoginItem),
    CheckUpdate,
    InstallUpdate(InstallUpdate),
}

impl Ask {
    /// Every method `read` reads.
    pub const METHODS: [&str; 6] = [
        MESSAGE_BOX,
        COPY_TEXT,
        OPEN,
        LOGIN_ITEM,
        CHECK_UPDATE,
        INSTALL_UPDATE,
    ];

    /// The request main sent, or why the shell cannot answer it.
    pub fn read(method: &str, params: Value) -> Result<Self, String> {
        match method {
            MESSAGE_BOX => parsed(method, params).map(Self::MessageBox),
            COPY_TEXT => parsed(method, params).map(Self::CopyText),
            OPEN => parsed(method, params).map(Self::Open),
            LOGIN_ITEM => parsed(method, params).map(Self::LoginItem),
            CHECK_UPDATE => parsed::<()>(method, params).map(|()| Self::CheckUpdate),
            INSTALL_UPDATE => parsed(method, params).map(Self::InstallUpdate),
            _ => Err(format!(
                "the shell answers no {method}, only {}",
                Self::METHODS.join(", ")
            )),
        }
    }
}

/// One of main's notifications, read.
#[cfg_attr(test, derive(Serialize), serde(untagged))]
pub enum Tell {
    Tray(TrayModel),
    KeepAwake(KeepAwake),
    Notify(Note),
    Relaunch,
}

impl Tell {
    /// Every method `read` reads.
    pub const METHODS: [&str; 4] = [TRAY, KEEP_AWAKE, NOTIFY, RELAUNCH];

    /// The notification main sent, or why the shell cannot hear it.
    pub fn read(method: &str, params: Value) -> Result<Self, String> {
        match method {
            TRAY => parsed(method, params).map(Self::Tray),
            KEEP_AWAKE => parsed(method, params).map(Self::KeepAwake),
            NOTIFY => parsed(method, params).map(Self::Notify),
            RELAUNCH => parsed::<()>(method, params).map(|()| Self::Relaunch),
            _ => Err(format!(
                "the shell hears no {method}, only {}",
                Self::METHODS.join(", ")
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, BTreeSet};
    use std::error::Error;
    use std::path::Path;

    use serde::Deserializer;
    use serde::de::DeserializeOwned;
    use serde_json::json;

    use super::*;

    /// Every request the shell makes of main, and every notification it sends it.
    const ASKED: [&str; 3] = [HELLO, HANDOFF, QUIT];
    const TOLD: [&str; 3] = [WINDOW, TRAY_CLICK, UPDATE_CLICK];

    #[derive(PartialEq, Eq, Deserialize)]
    #[serde(rename_all = "lowercase")]
    enum Side {
        Main,
        Shell,
    }

    /// One method's sample: what its sender sends, and for a request what it is answered with.
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Sample {
        from: Side,
        params: Value,
        #[serde(default, deserialize_with = "present")]
        result: Option<Value>,
    }

    /// A `result` of null is an answer of null, not a notification's missing one.
    fn present<'de, D: Deserializer<'de>>(answer: D) -> Result<Option<Value>, D::Error> {
        Value::deserialize(answer).map(Some)
    }

    fn samples() -> Result<BTreeMap<String, Sample>, Box<dyn Error>> {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/relay");
        let mut samples = BTreeMap::new();
        for entry in std::fs::read_dir(dir)? {
            let path = entry?.path();
            let Some(method) = path.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            let sample = serde_json::from_str(&std::fs::read_to_string(&path)?)
                .map_err(|error| format!("{}: {error}", path.display()))?;
            samples.insert(method.to_owned(), sample);
        }
        Ok(samples)
    }

    fn methods<'a>(
        samples: &'a BTreeMap<String, Sample>,
        from: &Side,
        answered: bool,
    ) -> BTreeSet<&'a str> {
        samples
            .iter()
            .filter(|(_, sample)| sample.from == *from && sample.result.is_some() == answered)
            .map(|(method, _)| method.as_str())
            .collect()
    }

    /// `read` takes the sample and writes it back as it was: neither end has a field the other
    /// lacks, nor a name the other spells another way.
    fn same<T: Serialize>(method: &str, read: T, sample: &Value) -> Result<(), Box<dyn Error>> {
        assert_eq!(serde_json::to_value(read)?, *sample, "{method}");
        Ok(())
    }

    fn reads<T: Serialize + DeserializeOwned>(
        method: &str,
        sample: Option<&Value>,
    ) -> Result<(), Box<dyn Error>> {
        let sample = sample.ok_or_else(|| format!("{method} is a request, answered"))?;
        let read: T =
            serde_json::from_value(sample.clone()).map_err(|error| format!("{method}: {error}"))?;
        same(method, read, sample)
    }

    #[test]
    fn the_shell_reads_what_main_sends_and_answers_as_main_reads() -> Result<(), Box<dyn Error>> {
        let samples = samples()?;
        let asked: BTreeSet<&str> = Ask::METHODS.into_iter().collect();
        let told: BTreeSet<&str> = Tell::METHODS.into_iter().collect();
        assert_eq!(methods(&samples, &Side::Main, true), asked);
        assert_eq!(methods(&samples, &Side::Main, false), told);
        for method in Ask::METHODS {
            let sample = &samples[method];
            same(
                method,
                Ask::read(method, sample.params.clone())?,
                &sample.params,
            )?;
            match method {
                LOGIN_ITEM => reads::<LaunchAtLogin>(method, sample.result.as_ref())?,
                CHECK_UPDATE => reads::<Option<Release>>(method, sample.result.as_ref())?,
                _ => reads::<()>(method, sample.result.as_ref())?,
            }
        }
        for method in Tell::METHODS {
            let sample = &samples[method];
            same(
                method,
                Tell::read(method, sample.params.clone())?,
                &sample.params,
            )?;
        }
        Ok(())
    }

    #[test]
    fn the_shell_sends_what_main_reads_and_reads_its_answers() -> Result<(), Box<dyn Error>> {
        let samples = samples()?;
        assert_eq!(
            methods(&samples, &Side::Shell, true),
            ASKED.into_iter().collect()
        );
        assert_eq!(
            methods(&samples, &Side::Shell, false),
            TOLD.into_iter().collect()
        );
        for method in ASKED.into_iter().chain(TOLD) {
            let Sample { params, result, .. } = &samples[method];
            let result = result.as_ref();
            match method {
                HELLO => {
                    reads::<Hello>(method, Some(params))?;
                    reads::<()>(method, result)?;
                }
                HANDOFF => {
                    reads::<()>(method, Some(params))?;
                    reads::<Handoff>(method, result)?;
                }
                QUIT => {
                    reads::<()>(method, Some(params))?;
                    reads::<()>(method, result)?;
                }
                WINDOW => reads::<WindowChange>(method, Some(params))?,
                TRAY_CLICK => reads::<TrayClick>(method, Some(params))?,
                UPDATE_CLICK => reads::<()>(method, Some(params))?,
                _ => return Err(format!("the shell sends no {method}").into()),
            }
        }
        Ok(())
    }

    #[test]
    fn what_the_shell_cannot_read_is_refused_with_why() {
        assert_eq!(
            Ask::read("host.beep", Value::Null).err().as_deref(),
            Some(
                "the shell answers no host.beep, only host.messageBox, host.copyText, host.open, host.loginItem, host.checkUpdate, host.installUpdate"
            )
        );
        assert!(Ask::read(COPY_TEXT, json!({ "text": "x", "html": "<b>x</b>" })).is_err());
        assert!(Tell::read(TRAY, json!({ "title": "x" })).is_err());
        let tray = json!({
            "items": [{ "kind": "separator", "label": "-" }],
            "title": "",
            "tooltip": "IdleBiz",
        });
        assert!(Tell::read(TRAY, tray).is_err());
        let tray = json!({
            "items": [{ "kind": "open", "label": "Open", "shortcut": "O" }],
            "title": "",
            "tooltip": "IdleBiz",
        });
        assert!(Tell::read(TRAY, tray).is_err());
        assert!(Tell::read(RELAUNCH, json!({})).is_err());
        assert!(Ask::read(CHECK_UPDATE, json!({})).is_err());
        assert!(Ask::read(INSTALL_UPDATE, json!({ "version": "1.0.0", "notes": "" })).is_err());
    }
}

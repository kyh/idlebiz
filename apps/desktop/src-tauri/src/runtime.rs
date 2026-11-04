//! Where the shell finds the node that runs the server, the server itself (the `idlebiz` package,
//! `idlebiz serve`) and the folder main's log goes in, and the environment main starts with.
//!
//! A packaged app carries both: node as the sidecar beside the shell's own binary
//! (`bundle.externalBin`), the server as a resource, with its page, its skills and its
//! `node_modules` inside. A `tauri dev` shell runs the checkout's built server
//! (`apps/cli/dist`, which the dev command builds) on the developer's own node, and the server takes
//! the page from the dev server. Nothing in the environment can point the shell elsewhere: a variable
//! an `open --env` could set would run another program inside a process the OS counts as this app.
//!
//! Nor, in the packaged app, can it say who main runs as or which save main opens. That env is
//! launchd's, which `launchctl setenv` from any process of the founder's sets for every app opened
//! after it: so main takes the founder's home, shell and name from the user database, their temp
//! folder from macOS, the system's PATH, and its save from the shell's own `--root=` argument
//! alone, a door launchd cannot set.

use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::fmt::Write as _;
use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};

/// The server's own entry: its bundle, which `serve` boots.
pub const SERVE_ENTRY: &str = "dist/index.js";
/// What the shell asks of that entry.
pub const SERVE_ARGS: [&str; 1] = ["serve"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Runtime {
    /// The node binary main runs on.
    pub node: PathBuf,
    /// The `idlebiz` package: `dist/` (the bundle and the page), `resources/` and its production
    /// `node_modules`.
    pub cli_dir: PathBuf,
}

impl Runtime {
    pub fn serve_entry(&self) -> PathBuf {
        self.cli_dir.join(SERVE_ENTRY)
    }
}

/// The checkout's server, named at compile time: a development shell runs this checkout's.
fn checkout_cli_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("cli")
}

/// Inside `IdleBiz.app/Contents/MacOS` the bundle carries node and main, and a missing one is a
/// broken install rather than a reason to run something else.
pub fn is_bundled(exe: &Path) -> bool {
    exe.parent()
        .filter(|dir| dir.ends_with("Contents/MacOS"))
        .and_then(Path::parent)
        .and_then(Path::parent)
        .and_then(Path::extension)
        .is_some_and(|extension| extension == "app")
}

pub fn resolve(exe: &Path, resource_dir: &Path) -> Result<Runtime, String> {
    if !is_bundled(exe) {
        return Ok(Runtime {
            node: PathBuf::from("node"),
            cli_dir: checkout_cli_dir(),
        });
    }
    let runtime = Runtime {
        node: exe.with_file_name("node"),
        cli_dir: resource_dir.join("server"),
    };
    // main serves the page, and reads the skills as it runs, long after it booted
    let page = runtime.cli_dir.join("dist").join("page").join("index.html");
    let skills = runtime.cli_dir.join("resources").join("skills");
    for required in [&runtime.node, &runtime.serve_entry(), &page, &skills] {
        if !required.exists() {
            return Err(format!(
                "this install is incomplete: {} is missing. Reinstall IdleBiz.",
                required.display()
            ));
        }
    }
    Ok(runtime)
}

/// What node loads before main runs, so main has no say in it: `NODE_OPTIONS` could `--require` a
/// file into main or `--inspect` it on a port, and `OPENSSL_CONF` names a config node reads as it
/// starts, one that fails stopping every boot. And main reads no `NODE_ENV`, but every run inherits
/// main's env, so a terminal's or a test runner's would build the founder's products in its mode.
const NODE_LOADERS: [&str; 2] = ["NODE_", "OPENSSL_"];

/// A developer's switches, which only launchd could hand the packaged app: another save, test money
/// counted, another binary or home for a runner.
const DEVELOPER_ONLY: [&str; 6] = [
    "IDLEBIZ_ROOT_DIR",
    "IDLEBIZ_COUNT_TEST_MONEY",
    "CLAUDE_BIN",
    "CODEX_BIN",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
];

/// Where the runners' CLIs read their settings from the env. A `*_BASE_URL` among them sends a
/// runner's login to the address it names; a founder's own route is claude's settings `env` or
/// codex's config.toml, which no launch carries.
const RUNNER_PREFIXES: [&str; 5] = [
    "ANTHROPIC_",
    "CLAUDE_",
    "OPENAI_",
    "CODEX_",
    "AZURE_OPENAI_",
];

/// macOS's own PATH, as launchd sets it by default: folders SIP keeps and no run writes. Main puts
/// the founder's CLIs ahead of it from their login shell (`apps/cli/src/server/lib/shell-path.ts`).
const SYSTEM_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin";

/// Who the founder is, as the user database and macOS say.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Account {
    /// The account's short name, its `USER` and `LOGNAME`.
    pub name: String,
    pub home: PathBuf,
    /// The login shell, which main asks for the founder's PATH.
    pub shell: PathBuf,
    /// The per-user temp folder (`DARWIN_USER_TEMP_DIR`), when macOS names one.
    pub temp: Option<PathBuf>,
}

/// A packaged launch: who the founder is, and the save `--root=` names, the smoke's door.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Packaged {
    pub account: Account,
    pub root: Option<PathBuf>,
}

/// The account this app runs as, from the user database rather than the env launchd hands the app.
#[cfg(unix)]
pub fn account() -> Result<Account, String> {
    let user = nix::unistd::User::from_uid(nix::unistd::getuid())
        .map_err(|error| format!("macOS would not say who you are: {error}"))?
        .ok_or_else(|| "macOS knows no user by this app's id".to_owned())?;
    if !user.dir.is_absolute() {
        return Err(format!(
            "macOS gives your account no home folder: it says \"{}\"",
            user.dir.display()
        ));
    }
    Ok(Account {
        name: user.name,
        home: user.dir,
        shell: user.shell,
        temp: user_temp_dir(),
    })
}

#[cfg(not(unix))]
pub fn account() -> Result<Account, String> {
    Err("IdleBiz runs on macOS alone".to_owned())
}

/// macOS's per-user temp folder, as main reads its cache folder (`machine-seal.ts`): `getconf`
/// reads no env.
#[cfg(target_os = "macos")]
fn user_temp_dir() -> Option<PathBuf> {
    let output = std::process::Command::new("/usr/bin/getconf")
        .arg("DARWIN_USER_TEMP_DIR")
        .env_clear()
        .output()
        .ok()
        .filter(|output| output.status.success())?;
    let temp = PathBuf::from(String::from_utf8(output.stdout).ok()?.trim());
    temp.is_absolute().then_some(temp)
}

#[cfg(all(unix, not(target_os = "macos")))]
const fn user_temp_dir() -> Option<PathBuf> {
    None
}

/// The save the shell's arguments name, `--root=<dir>`: one token, so macOS opens no document by
/// it, and an argument, which launchd cannot set and no run can pass (`open --args` is `lsopen`,
/// which the seal denies). A restart keeps it.
pub fn root_arg<I>(args: I) -> Option<PathBuf>
where
    I: IntoIterator<Item = OsString>,
{
    args.into_iter()
        .find_map(|arg| root_of(&arg))
        .filter(|root| !root.as_os_str().is_empty())
}

#[cfg(unix)]
fn root_of(arg: &OsStr) -> Option<PathBuf> {
    use std::os::unix::ffi::OsStrExt;
    arg.as_bytes()
        .strip_prefix(b"--root=")
        .map(|root| PathBuf::from(OsStr::from_bytes(root)))
}

#[cfg(not(unix))]
fn root_of(arg: &OsStr) -> Option<PathBuf> {
    arg.to_str()?.strip_prefix("--root=").map(PathBuf::from)
}

/// What only launchd could have set in a packaged launch's env: a developer's switch, a runner's
/// model address, a CA to trust under the names tools share, or a temp folder. Each tool's own
/// trust switches and registries pass, as `docs/seal.md`'s "What stays open" lists.
fn launchd_only(name: &str) -> bool {
    DEVELOPER_ONLY.contains(&name)
        || (name.ends_with("BASE_URL")
            && RUNNER_PREFIXES
                .iter()
                .any(|prefix| name.starts_with(prefix)))
        || name.starts_with("SSL_CERT_")
        || name.contains("CA_BUNDLE")
        || name.contains("CA_CERT")
        || matches!(name, "TMPDIR" | "TMP" | "TEMP")
}

/// What main starts from: the shell's own environment less what node loads, as the dev host gives
/// it too (`apps/cli/src/dev-host/host.ts`). A development shell's is its terminal's. A packaged
/// one's is launchd's, so main takes none of what only launchd could have set there, and takes who
/// the founder is from the system: their home, shell and name, their temp folder, the system's
/// PATH, and the save `--root=` named. Every `homedir()` and `tmpdir()` of main's reads these, its
/// seal's among them, and main refuses a home or shell that is not the account's.
pub fn main_env<I>(inherited: I, packaged: Option<&Packaged>) -> BTreeMap<OsString, OsString>
where
    I: IntoIterator<Item = (OsString, OsString)>,
{
    let mut env: BTreeMap<OsString, OsString> = inherited
        .into_iter()
        .filter(|(name, _)| {
            let name = name.to_string_lossy();
            let dropped = NODE_LOADERS.iter().any(|prefix| name.starts_with(prefix))
                || (packaged.is_some() && launchd_only(&name));
            !dropped
        })
        .collect();
    let Some(Packaged { account, root }) = packaged else {
        return env;
    };
    let name = OsString::from(&account.name);
    env.insert("HOME".into(), account.home.clone().into_os_string());
    env.insert("SHELL".into(), account.shell.clone().into_os_string());
    env.insert("USER".into(), name.clone());
    env.insert("LOGNAME".into(), name);
    env.insert("PATH".into(), SYSTEM_PATH.into());
    if let Some(temp) = &account.temp {
        env.insert("TMPDIR".into(), temp.clone().into_os_string());
    }
    if let Some(root) = root {
        env.insert("IDLEBIZ_ROOT_DIR".into(), root.clone().into_os_string());
    }
    env
}

/// The save main opens, as `apps/cli/src/server/paths.ts` resolves it: `IDLEBIZ_ROOT_DIR`, or
/// `~/.idlebiz`. Main inherits the shell's working directory, so a relative override names one
/// folder for both, read as `path.resolve` reads it.
pub fn root_dir(home: &Path, override_dir: Option<&Path>, cwd: &Path) -> PathBuf {
    override_dir.map_or_else(|| home.join(".idlebiz"), |dir| resolved(&cwd.join(dir)))
}

/// `path.resolve`'s lexical reading: `.` dropped and `..` taking back the folder before it (never
/// past the root), so one save is spelled one way by the shell and by main.
fn resolved(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

/// Where main's log goes: `~/Library/Logs/IdleBiz` for the app, where Console lists a Mac app's
/// logs; a development shell keeps its own beside its data, one folder per isolated save, so
/// sessions on different roots never share a log.
pub fn logs_dir(bundled: bool, home: &Path, data_dir: &Path, root: &Path) -> PathBuf {
    if bundled {
        return if cfg!(target_os = "macos") {
            home.join("Library").join("Logs").join("IdleBiz")
        } else {
            data_dir.join("IdleBiz").join("logs")
        };
    }
    let dev = data_dir.join("IdleBiz (dev)");
    if root == home.join(".idlebiz") {
        return dev.join("logs");
    }
    let digest = Sha256::digest(root.to_string_lossy().as_bytes());
    let id = digest[..8].iter().fold(String::new(), |mut id, byte| {
        let _ = write!(id, "{byte:02x}");
        id
    });
    dev.join("roots").join(id).join("logs")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairs(names: &[&str]) -> Vec<(OsString, OsString)> {
        names
            .iter()
            .map(|name| (OsString::from(*name), OsString::from("x")))
            .collect()
    }

    fn names(env: &BTreeMap<OsString, OsString>) -> Vec<String> {
        env.keys()
            .map(|name| name.to_string_lossy().into_owned())
            .collect()
    }

    fn value<'a>(env: &'a BTreeMap<OsString, OsString>, name: &str) -> Option<&'a OsStr> {
        env.get(OsStr::new(name)).map(OsString::as_os_str)
    }

    fn kai(temp: Option<&str>, root: Option<&str>) -> Packaged {
        Packaged {
            account: Account {
                name: "kai".to_owned(),
                home: PathBuf::from("/Users/kai"),
                shell: PathBuf::from("/bin/zsh"),
                temp: temp.map(PathBuf::from),
            },
            root: root.map(PathBuf::from),
        }
    }

    // what a `launchctl setenv` could hand the packaged app, each set to "x"
    const LAUNCHD_SET: [&str; 15] = [
        "IDLEBIZ_ROOT_DIR",
        "IDLEBIZ_COUNT_TEST_MONEY",
        "CLAUDE_BIN",
        "CODEX_BIN",
        "CLAUDE_CONFIG_DIR",
        "CODEX_HOME",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_BEDROCK_BASE_URL",
        "OPENAI_BASE_URL",
        "SSL_CERT_FILE",
        "CURL_CA_BUNDLE",
        "CODEX_CA_CERTIFICATE",
        "TMPDIR",
        "TMP",
        "TEMP",
    ];

    #[test]
    fn drops_what_loads_into_node() {
        let kept = names(&main_env(
            pairs(&[
                "NODE_OPTIONS",
                "NODE_PATH",
                "NODE_ENV",
                "OPENSSL_CONF",
                "OPENSSL_MODULES",
                "HOME",
                "PATH",
                "IDLEBIZ_ROOT_DIR",
                "CLAUDE_BIN",
                "CODEX_HOME",
                "ZDOTDIR",
                "BASH_ENV",
                "SSL_CERT_FILE",
                "TMPDIR",
                "ANTHROPIC_BASE_URL",
            ]),
            None,
        ));
        // a development main keeps its terminal's env whole but for what node loads
        assert_eq!(
            kept,
            [
                "ANTHROPIC_BASE_URL",
                "BASH_ENV",
                "CLAUDE_BIN",
                "CODEX_HOME",
                "HOME",
                "IDLEBIZ_ROOT_DIR",
                "PATH",
                "SSL_CERT_FILE",
                "TMPDIR",
                "ZDOTDIR",
            ]
        );
    }

    #[test]
    fn a_packaged_main_takes_the_founder_from_the_system() {
        let inherited = [
            ("HOME", "/private/tmp/h"),
            ("SHELL", "/private/tmp/s"),
            ("USER", "eve"),
            ("LOGNAME", "eve"),
            ("PATH", "/private/tmp/p:/usr/bin"),
            ("NODE_OPTIONS", "--require /private/tmp/r.js"),
            ("OPENSSL_CONF", "/private/tmp/x.cnf"),
            ("ANTHROPIC_API_KEY", "sk"),
            ("SSH_AUTH_SOCK", "/private/tmp/agent"),
            ("HTTPS_PROXY", "http://127.0.0.1:8080"),
        ]
        .map(|(name, value)| (OsString::from(name), OsString::from(value)))
        .into_iter()
        .chain(pairs(&LAUNCHD_SET));
        let env = main_env(
            inherited,
            Some(&kai(Some("/var/folders/x/T/"), Some("/scratch/save"))),
        );
        assert_eq!(value(&env, "HOME"), Some(OsStr::new("/Users/kai")));
        assert_eq!(value(&env, "SHELL"), Some(OsStr::new("/bin/zsh")));
        assert_eq!(value(&env, "USER"), Some(OsStr::new("kai")));
        assert_eq!(value(&env, "LOGNAME"), Some(OsStr::new("kai")));
        assert_eq!(value(&env, "TMPDIR"), Some(OsStr::new("/var/folders/x/T/")));
        assert_eq!(value(&env, "PATH"), Some(OsStr::new(SYSTEM_PATH)));
        assert_eq!(
            value(&env, "IDLEBIZ_ROOT_DIR"),
            Some(OsStr::new("/scratch/save"))
        );
        // what the founder routes their runners and network through still reaches the runs
        assert_eq!(value(&env, "ANTHROPIC_API_KEY"), Some(OsStr::new("sk")));
        assert_eq!(
            value(&env, "SSH_AUTH_SOCK"),
            Some(OsStr::new("/private/tmp/agent"))
        );
        assert_eq!(
            value(&env, "HTTPS_PROXY"),
            Some(OsStr::new("http://127.0.0.1:8080"))
        );
        let reset = [
            "HOME",
            "SHELL",
            "USER",
            "LOGNAME",
            "PATH",
            "TMPDIR",
            "IDLEBIZ_ROOT_DIR",
        ];
        let kept: Vec<&str> = LAUNCHD_SET
            .into_iter()
            .chain(["NODE_OPTIONS", "OPENSSL_CONF"])
            .filter(|name| !reset.contains(name))
            .filter(|name| env.contains_key(OsStr::new(name)))
            .collect();
        assert!(kept.is_empty(), "kept what only launchd set: {kept:?}");
    }

    #[test]
    fn a_packaged_main_without_a_root_argument_opens_the_founder_s_save() {
        let env = main_env(
            pairs(&["IDLEBIZ_ROOT_DIR", "PATH"]),
            Some(&kai(Some("/var/folders/x/T/"), None)),
        );
        assert!(!env.contains_key(OsStr::new("IDLEBIZ_ROOT_DIR")));
    }

    #[test]
    fn a_packaged_main_without_a_temp_folder_keeps_no_tmpdir() {
        // node's `tmpdir()` then falls back to /tmp, which the seal already counts as scratch
        let env = main_env(
            pairs(&["TMPDIR", "TMP", "TEMP", "PATH"]),
            Some(&kai(None, None)),
        );
        assert_eq!(names(&env), ["HOME", "LOGNAME", "PATH", "SHELL", "USER"]);
    }

    #[test]
    fn reads_the_root_from_its_argument() {
        let args = |args: &[&str]| args.iter().map(OsString::from).collect::<Vec<_>>();
        assert_eq!(
            root_arg(args(&["--verbose", "--root=/x", "--root=/y"])),
            Some(PathBuf::from("/x"))
        );
        assert_eq!(root_arg(args(&["--root", "/x"])), None);
        assert_eq!(root_arg(args(&["-root=/x"])), None);
        assert_eq!(root_arg(args(&["--root="])), None);
        assert_eq!(root_arg(args(&[])), None);
    }

    #[cfg(unix)]
    #[test]
    fn reads_the_account_from_the_user_database() -> Result<(), String> {
        let account = account()?;
        assert_ne!(account.name, "");
        assert!(account.home.is_absolute());
        assert!(account.shell.is_absolute());
        if cfg!(target_os = "macos") {
            assert!(account.temp.is_some_and(|temp| temp.is_absolute()));
        }
        Ok(())
    }

    #[test]
    fn knows_a_bundled_shell_by_where_it_runs() {
        assert!(is_bundled(Path::new(
            "/Applications/IdleBiz.app/Contents/MacOS/IdleBiz"
        )));
        assert!(!is_bundled(Path::new(
            "/repo/apps/desktop/src-tauri/target/debug/idlebiz"
        )));
    }

    #[test]
    fn an_unbundled_shell_runs_the_checkout_s_built_main() -> Result<(), String> {
        let runtime = resolve(
            Path::new("/repo/target/debug/idlebiz"),
            Path::new("/nowhere"),
        )?;
        assert_eq!(runtime.node, PathBuf::from("node"));
        assert!(runtime.cli_dir.ends_with("cli"));
        assert!(runtime.serve_entry().ends_with("cli/dist/index.js"));
        Ok(())
    }

    #[test]
    fn a_bundle_missing_node_is_a_broken_install() {
        let refused = resolve(
            Path::new("/Applications/IdleBiz.app/Contents/MacOS/IdleBiz"),
            Path::new("/Applications/IdleBiz.app/Contents/Resources"),
        );
        assert!(refused.is_err_and(|reason| reason.contains("Reinstall")));
    }

    #[test]
    fn a_bundle_missing_its_page_or_skills_is_a_broken_install() -> std::io::Result<()> {
        let dir = tempfile::tempdir()?;
        let contents = dir.path().join("IdleBiz.app").join("Contents");
        let resources = contents.join("Resources");
        let server = resources.join("server");
        let shell = contents.join("MacOS").join("IdleBiz");
        std::fs::create_dir_all(contents.join("MacOS"))?;
        std::fs::write(contents.join("MacOS").join("node"), "")?;
        std::fs::create_dir_all(server.join("dist"))?;
        std::fs::write(server.join("dist").join("index.js"), "")?;
        std::fs::create_dir_all(server.join("resources").join("skills"))?;
        let refused = resolve(&shell, &resources);
        assert!(refused.is_err_and(|reason| reason.contains("page")));
        std::fs::create_dir_all(server.join("dist").join("page"))?;
        std::fs::write(server.join("dist").join("page").join("index.html"), "")?;
        std::fs::remove_dir(server.join("resources").join("skills"))?;
        let refused = resolve(&shell, &resources);
        assert!(refused.is_err_and(|reason| reason.contains("skills")));
        std::fs::create_dir_all(server.join("resources").join("skills"))?;
        assert!(resolve(&shell, &resources).is_ok());
        Ok(())
    }

    #[test]
    fn resolves_the_save_as_main_does() {
        let home = Path::new("/Users/me");
        assert_eq!(
            root_dir(home, None, Path::new("/")),
            PathBuf::from("/Users/me/.idlebiz")
        );
        assert_eq!(
            root_dir(home, Some(Path::new("fixture")), Path::new("/repo")),
            PathBuf::from("/repo/fixture")
        );
        assert_eq!(
            root_dir(home, Some(Path::new("/tmp/save")), Path::new("/repo")),
            PathBuf::from("/tmp/save")
        );
        assert_eq!(
            root_dir(home, Some(Path::new("./a/../b/./c/")), Path::new("/repo")),
            PathBuf::from("/repo/b/c")
        );
        assert_eq!(
            root_dir(home, Some(Path::new("../../../..")), Path::new("/repo")),
            PathBuf::from("/")
        );
    }

    #[test]
    fn keeps_a_dev_log_per_isolated_save() {
        let home = Path::new("/Users/me");
        let data = Path::new("/Users/me/Library/Application Support");
        let real = logs_dir(false, home, data, &home.join(".idlebiz"));
        assert!(real.ends_with("IdleBiz (dev)/logs"));
        let isolated = logs_dir(false, home, data, Path::new("/tmp/save"));
        assert!(isolated.starts_with(data.join("IdleBiz (dev)").join("roots")));
        assert_ne!(
            isolated,
            logs_dir(false, home, data, Path::new("/tmp/other"))
        );
    }
}

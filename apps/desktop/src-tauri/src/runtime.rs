//! Where the shell finds the node that runs the server, the server itself (the `idlebiz` package,
//! `idlebiz serve`) and the folder main's log goes in, and the environment main starts with.
//!
//! A packaged app carries both: node as the sidecar beside the shell's own binary
//! (`bundle.externalBin`), the server as a resource, with its page, its skills, its employee sheets
//! and its `node_modules` inside. A `tauri dev` shell runs the checkout's built server
//! (`apps/cli/dist`, which the dev command builds) on the developer's own node, and the server takes
//! the page from the dev server. Nothing in the environment can point the shell elsewhere: a variable
//! an `open --env` could set would run another program inside a process the OS counts as this app.
//! The same layout as kyh/inteligir's shell.

use std::collections::BTreeMap;
use std::ffi::OsString;
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
    // main serves the page, and reads the skills and the sheets as it hires and runs, long after it
    // booted
    let page = runtime.cli_dir.join("dist").join("page").join("index.html");
    let skills = runtime.cli_dir.join("resources").join("skills");
    let sheets = runtime.cli_dir.join("resources").join("employee-sheets");
    for required in [
        &runtime.node,
        &runtime.serve_entry(),
        &page,
        &skills,
        &sheets,
    ] {
        if !required.exists() {
            return Err(format!(
                "this install is incomplete: {} is missing. Reinstall IdleBiz.",
                required.display()
            ));
        }
    }
    Ok(runtime)
}

/// What main starts from: the shell's own environment less anything that makes node load code or
/// open a debugger. `NODE_OPTIONS` can `--require` a file or `--inspect` a port, so it and every
/// other `NODE_*` but `NODE_ENV` go: the job of the Electron fuses that turned `NODE_OPTIONS` and
/// the inspector arguments off.
pub fn scrubbed_env<I>(inherited: I) -> BTreeMap<OsString, OsString>
where
    I: IntoIterator<Item = (OsString, OsString)>,
{
    inherited
        .into_iter()
        .filter(|(name, _)| {
            let name = name.to_string_lossy();
            !name.starts_with("NODE_") || name == "NODE_ENV"
        })
        .collect()
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

/// Where main's log goes: `~/Library/Logs/IdleBiz` for the app, where a report has always found
/// it; a development shell keeps its own beside its data, one folder per isolated save, so
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

    #[test]
    fn drops_every_node_variable_but_its_mode() {
        let kept: Vec<String> = scrubbed_env(pairs(&[
            "PATH",
            "NODE_OPTIONS",
            "NODE_PATH",
            "NODE_ENV",
            "IDLEBIZ_ROOT_DIR",
            "HOME",
        ]))
        .into_keys()
        .map(|name| name.to_string_lossy().into_owned())
        .collect();
        assert_eq!(kept, ["HOME", "IDLEBIZ_ROOT_DIR", "NODE_ENV", "PATH"]);
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
        std::fs::create_dir_all(server.join("resources").join("employee-sheets"))?;
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

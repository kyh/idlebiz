//! The shell's own lines, and what Tauri and the crates under it warn of, through the `log` facade
//! they all log with: on stderr for a terminal launch, and in main's log once the shell has opened
//! it, since a Finder launch's stderr goes nowhere. Main's own lines, and the supervisor's about
//! main, reach that log through `main_process.rs`, which holds it.

use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use log::{Level, LevelFilter, Log, Metadata, Record};

use crate::main_log::MainLog;

struct ShellLog {
    file: OnceLock<Arc<Mutex<MainLog>>>,
}

static SHELL_LOG: ShellLog = ShellLog::new();

fn is_own(target: &str) -> bool {
    let crate_name = env!("CARGO_CRATE_NAME");
    target
        .strip_prefix(crate_name)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with("::"))
}

impl ShellLog {
    const fn new() -> Self {
        Self {
            file: OnceLock::new(),
        }
    }
}

impl Log for ShellLog {
    /// The shell's own records down to info; another crate's only when it warns.
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        let floor = if is_own(metadata.target()) {
            Level::Info
        } else {
            Level::Warn
        };
        metadata.level() <= floor
    }

    fn log(&self, record: &Record<'_>) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let line = if is_own(record.target()) {
            format!("[shell] {}", record.args())
        } else {
            format!("[shell] {}: {}", record.target(), record.args())
        };
        eprintln!("{line}");
        if let Some(file) = self.file.get() {
            file.lock()
                .unwrap_or_else(PoisonError::into_inner)
                .append(&line);
        }
    }

    fn flush(&self) {}
}

/// Installs the shell's logger, before anything logs.
pub fn init() {
    if log::set_logger(&SHELL_LOG).is_ok() {
        log::set_max_level(LevelFilter::Info);
    }
}

/// From now on the shell's lines go to main's log too. A launch starts one main, so one log.
pub fn write_to(file: Arc<Mutex<MainLog>>) {
    let _ = SHELL_LOG.file.set(file);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::main_log::main_log_path;

    fn record(log: &ShellLog, level: Level, target: &str, text: &str) {
        log.log(
            &Record::builder()
                .level(level)
                .target(target)
                .args(format_args!("{text}"))
                .build(),
        );
    }

    #[test]
    fn keeps_the_shell_s_lines_and_only_what_other_crates_warn_of() -> std::io::Result<()> {
        let dir = tempfile::tempdir()?;
        let path = main_log_path(dir.path());
        let log = ShellLog::new();
        record(
            &log,
            Level::Warn,
            "idlebiz_desktop::window",
            "before the log opened",
        );
        let _ = log
            .file
            .set(Arc::new(Mutex::new(MainLog::new(path.clone(), 1 << 20))));
        record(
            &log,
            Level::Info,
            "idlebiz_desktop::window",
            "window loaded",
        );
        record(&log, Level::Debug, "idlebiz_desktop::window", "too fine");
        record(&log, Level::Info, "tao::platform_impl", "chatter");
        record(&log, Level::Warn, "wry::wkwebview", "content process gone");
        record(&log, Level::Warn, "idlebiz_desktop_other", "not the shell");
        let written = std::fs::read_to_string(&path)?;
        let lines: Vec<&str> = written
            .lines()
            .filter_map(|line| line.split_once(' ').map(|(_, rest)| rest))
            .collect();
        assert_eq!(
            lines,
            [
                "[shell] window loaded",
                "[shell] wry::wkwebview: content process gone",
                "[shell] idlebiz_desktop_other: not the shell",
            ]
        );
        Ok(())
    }
}

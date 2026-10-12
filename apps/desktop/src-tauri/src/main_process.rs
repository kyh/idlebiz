//! Main is a child, and its one supervisor is this module.
//!
//! Main's stdin is its lifeline: the shell closes it only once main has answered `quit`. A thread
//! of its own writes it, so a main that stops reading holds that thread alone: never a quit's
//! wait, which then ends main the hard way.

use std::collections::{BTreeMap, HashMap};
use std::ffi::OsString;
use std::fmt;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::thread;
use std::time::Duration;

use serde_json::Value;

use crate::main_log::MainLog;
use crate::protocol;
use crate::relay::{self, Incoming};

/// How long a quit waits for main to stop its runs and answer: agents get a grace of their own
/// before main kills their groups, and this is past it.
pub const QUIT_TIMEOUT: Duration = Duration::from_secs(45);
/// How long main has to exit once its stdin closes, before SIGKILL.
const EXIT_GRACE: Duration = Duration::from_secs(5);

pub struct MainSpec {
    pub node: PathBuf,
    pub entry: PathBuf,
    /// What the entry is asked: `serve`.
    pub args: Vec<String>,
    pub env: BTreeMap<OsString, OsString>,
    pub log: Arc<Mutex<MainLog>>,
}

/// Answers one of main's requests, on a thread of its own: a message box waits on the founder.
pub type Answerer = Box<dyn Fn(&str, Value) -> Result<Value, String> + Send + Sync>;
/// Hears one of main's notifications, in the order main sent them.
pub type Listener = Box<dyn Fn(&str, Value) + Send>;
/// Told once, when main exits with no quit asked of it, with its exit code (none for a signal).
pub type Lost = Box<dyn FnOnce(Option<i32>) + Send>;

/// What the shell does with what main says, apart from answers.
pub struct Host {
    pub answer: Answerer,
    pub hear: Listener,
    pub lost: Lost,
}

#[derive(Default)]
struct ExitState {
    exited: bool,
    stopping: bool,
}

#[derive(Default)]
struct Exit {
    state: Mutex<ExitState>,
    changed: Condvar,
}

/// Where main's answer to one request goes: what it answered, or its refusal.
type Answer = mpsc::SyncSender<Result<Value, String>>;

/// Why a request to main came back with no answer.
#[derive(Debug, PartialEq, Eq)]
pub enum RequestError {
    /// Main refused it, in its own words.
    Refused(String),
    /// Main had exited, or the shell had closed its stdin, before it was asked.
    NotRunning,
    /// Main exited before it answered.
    Gone,
    /// Main did not answer within this long.
    TimedOut(Duration),
}

impl fmt::Display for RequestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Refused(reason) => f.write_str(reason),
            Self::NotRunning => f.write_str("main is not running"),
            Self::Gone => f.write_str("main is gone"),
            Self::TimedOut(within) => write!(f, "main did not answer within {within:?}"),
        }
    }
}

impl std::error::Error for RequestError {}

pub struct MainProcess {
    pid: u32,
    /// Lines for main's stdin, which the writer thread writes; none once the shell closed it.
    to_main: Mutex<Option<mpsc::Sender<String>>>,
    pending: Mutex<HashMap<u64, Answer>>,
    next_id: AtomicU64,
    exit: Exit,
    log: Arc<Mutex<MainLog>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn describe(code: Option<i32>) -> String {
    code.map_or_else(|| "a signal".to_owned(), |code| format!("code {code}"))
}

impl MainProcess {
    /// Starts main and its readers. Main boots when the shell says hello.
    pub fn start(spec: MainSpec, host: Host) -> Result<Arc<Self>, String> {
        lock(&spec.log).append("[shell] starting main");
        let mut command = Command::new(&spec.node);
        command
            .arg(&spec.entry)
            .args(&spec.args)
            .env_clear()
            .envs(&spec.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // a process group of its own: a signal to the shell's group (Ctrl-C under `tauri dev`, a
        // supervisor's killpg) reaches the shell alone, which stops main once, after its runs
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child: Child = command
            .spawn()
            .map_err(|error| format!("main could not start ({}): {error}", spec.node.display()))?;
        let (to_main, lines) = mpsc::channel::<String>();
        if let Some(mut stdin) = child.stdin.take() {
            thread::spawn(move || {
                for line in lines {
                    let written = stdin
                        .write_all(line.as_bytes())
                        .and_then(|()| stdin.write_all(b"\n"))
                        .and_then(|()| stdin.flush());
                    if written.is_err() {
                        break;
                    }
                }
                // dropping `stdin` closes main's lifeline, once every queued line is written
            });
        }
        let process = Arc::new(Self {
            pid: child.id(),
            to_main: Mutex::new(Some(to_main)),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(0),
            exit: Exit::default(),
            log: spec.log,
        });
        let Host { answer, hear, lost } = host;

        // notifications in order, off the reader: drawing the tray waits on the main thread, which
        // a quit holds while it waits for main's answer
        let (outbox, inbox) = mpsc::channel::<(String, Value)>();
        thread::spawn(move || {
            for (method, params) in inbox {
                hear(&method, params);
            }
        });

        if let Some(stdout) = child.stdout.take() {
            let reader = Arc::clone(&process);
            let answer = Arc::new(answer);
            thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    match relay::parse_line(&line) {
                        Some(Incoming::Response { id, outcome }) => reader.settle(id, outcome),
                        Some(Incoming::Request { id, method, params }) => {
                            let answering = Arc::clone(&reader);
                            let answer = Arc::clone(&answer);
                            thread::spawn(move || {
                                let outcome = answer(&method, params);
                                answering.write(&relay::response_line(id, &outcome));
                            });
                        }
                        Some(Incoming::Notification { method, params }) => {
                            let _ = outbox.send((method, params));
                        }
                        None => reader.note(&format!("[main] {line}")),
                    }
                }
            });
        }
        if let Some(stderr) = child.stderr.take() {
            pump(stderr, Arc::clone(&process.log));
        }

        let watched = Arc::clone(&process);
        thread::spawn(move || {
            let code = child.wait().ok().and_then(|status| status.code());
            watched.note(&format!("main exited ({})", describe(code)));
            let unexpected = {
                let mut state = lock(&watched.exit.state);
                state.exited = true;
                !state.stopping
            };
            watched.exit.changed.notify_all();
            // each request still waiting hears its answer will never come
            lock(&watched.pending).clear();
            if unexpected {
                lost(code);
            }
        });
        Ok(process)
    }

    fn note(&self, line: &str) {
        println!("{line}");
        lock(&self.log).append(line);
    }

    /// Queues a line for main; false once main is gone or its stdin closed. Read after a request
    /// is pending, `exited` is what keeps it from waiting on a main that can no longer answer: the
    /// watcher fails every pending request only once it has set it.
    fn write(&self, line: &str) -> bool {
        if lock(&self.exit.state).exited {
            return false;
        }
        lock(&self.to_main)
            .as_ref()
            .is_some_and(|lines| lines.send(line.to_owned()).is_ok())
    }

    fn settle(&self, id: u64, outcome: Result<Value, String>) {
        if let Some(answer) = lock(&self.pending).remove(&id) {
            // the one answer its channel holds: never blocks the reader
            let _ = answer.try_send(outcome);
        }
    }

    /// Asks main, and waits up to `within` for its answer. Blocks: off the main thread, but for a
    /// quit's.
    pub fn request(
        &self,
        method: &str,
        params: &Value,
        within: Duration,
    ) -> Result<Value, RequestError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let (answer, answered) = mpsc::sync_channel(1);
        lock(&self.pending).insert(id, answer);
        if !self.write(&relay::request_line(id, method, params)) {
            lock(&self.pending).remove(&id);
            return Err(RequestError::NotRunning);
        }
        match answered.recv_timeout(within) {
            Ok(outcome) => outcome.map_err(RequestError::Refused),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // an answer that comes later has no one to go to
                lock(&self.pending).remove(&id);
                Err(RequestError::TimedOut(within))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(RequestError::Gone),
        }
    }

    /// Says hello, which main boots on, and waits up to `within` for it to boot. A main that has
    /// not booted by then is stuck somewhere in its boot, and a quit would wait the boot out too,
    /// so it is killed with its group.
    pub fn boot(&self, hello: &Value, within: Duration) -> Result<(), RequestError> {
        let booted = self.request(protocol::HELLO, hello, within);
        if let Err(RequestError::TimedOut(_)) = booted {
            self.note(&format!(
                "[shell] main did not boot within {within:?}; killing it"
            ));
            self.kill();
        }
        booted.map(|_| ())
    }

    /// Tells main, and waits for nothing.
    pub fn notify(&self, method: &str, params: &Value) {
        self.write(&relay::notification_line(method, params));
    }

    /// Main stops its runs and answers, then its stdin closes and it exits; one that does not is
    /// killed. Blocks: a quit has no later step to wait in.
    pub fn stop(&self) {
        self.stop_within(QUIT_TIMEOUT);
    }

    fn stop_within(&self, quit_timeout: Duration) {
        {
            let mut state = lock(&self.exit.state);
            if state.exited || state.stopping {
                return;
            }
            state.stopping = true;
        }
        if self
            .request(protocol::QUIT, &Value::Null, quit_timeout)
            .is_err()
        {
            self.note("[shell] main did not answer quit in time; closing it anyway");
        }
        lock(&self.to_main).take();
        if !self.wait_exit(EXIT_GRACE) {
            self.note("[shell] main did not exit once its stdin closed; sending SIGKILL");
            kill_group(self.pid);
            self.wait_exit(EXIT_GRACE);
        }
    }

    /// Ends main at once, asking it nothing: its group is killed, and its exit waited for. Main
    /// is not lost then: whoever kills it says why.
    fn kill(&self) {
        lock(&self.exit.state).stopping = true;
        lock(&self.to_main).take();
        kill_group(self.pid);
        self.wait_exit(EXIT_GRACE);
    }

    fn wait_exit(&self, within: Duration) -> bool {
        let state = lock(&self.exit.state);
        let (state, _) = self
            .exit
            .changed
            .wait_timeout_while(state, within, |state| !state.exited)
            .unwrap_or_else(PoisonError::into_inner);
        state.exited
    }
}

fn pump<R: Read + Send + 'static>(stream: R, log: Arc<Mutex<MainLog>>) {
    thread::spawn(move || {
        for line in BufReader::new(stream).lines().map_while(Result::ok) {
            eprintln!("[main] {line}");
            lock(&log).append(&line);
        }
    });
}

#[cfg(unix)]
fn kill_group(pid: u32) {
    use nix::sys::signal::{Signal, killpg};
    use nix::unistd::Pid;
    if let Ok(pid) = i32::try_from(pid) {
        // main leads its own group: what it started and did not end goes with it
        let _ = killpg(Pid::from_raw(pid), Signal::SIGKILL);
    }
}

#[cfg(not(unix))]
fn kill_group(_pid: u32) {}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::sync::mpsc::Receiver;
    use std::time::Instant;

    use serde_json::json;

    use super::*;

    /// A main that speaks the relay and nothing else: it answers `echo` and `refuse`, asks the shell
    /// for `host.ping` when told to `ask` and says what it heard back as `pong`, stops reading its
    /// stdin when told to `wedge`, and exits when told to `die` or when its stdin closes. Its boot,
    /// on `hello`, never ends, and a quit waits it out, as main's does: from then on it answers no
    /// quit and outlives its stdin.
    const FAKE_MAIN: &str = r#"
const readline = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
let booting = false;
console.error("main is up");
process.stdout.write("not a message\n");
readline
  .createInterface({ input: process.stdin })
  .on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "echo") send({ id: message.id, result: message.params });
    else if (message.method === "refuse") send({ id: message.id, error: { code: -32000, message: "no" } });
    else if (message.method === "ask") send({ id: 900, method: "host.ping", params: message.params });
    else if (message.method === "die") process.exit(3);
    else if (message.method === "wedge") { process.stdin.pause(); setInterval(() => {}, 1000); }
    else if (message.method === "hello") { booting = true; setInterval(() => {}, 1000); }
    else if (message.method === "quit") { if (!booting) send({ id: message.id, result: null }); }
    else if (message.id === 900) send({ method: "pong", params: message.result ?? message.error });
  })
  .on("close", () => { if (!booting) process.exit(0); });
send({ method: "hi", params: { n: 1 } });
"#;

    struct Started {
        main: Arc<MainProcess>,
        heard: Receiver<(String, Value)>,
        lost: Receiver<Option<i32>>,
        log: PathBuf,
        _dir: tempfile::TempDir,
    }

    fn has_node() -> bool {
        Command::new("node").arg("--version").output().is_ok()
    }

    fn start(dir: tempfile::TempDir) -> Result<Started, String> {
        let entry = dir.path().join("main.cjs");
        std::fs::write(&entry, FAKE_MAIN).map_err(|error| error.to_string())?;
        let log = dir.path().join("logs").join("main.log");
        let (heard_by, heard) = mpsc::channel();
        let (lost_by, lost) = mpsc::channel();
        let main = MainProcess::start(
            MainSpec {
                node: PathBuf::from("node"),
                entry,
                args: Vec::new(),
                env: std::env::vars_os().collect(),
                log: Arc::new(Mutex::new(MainLog::new(log.clone(), 1 << 20))),
            },
            Host {
                answer: Box::new(|method, params| {
                    if method == "host.ping" {
                        Ok(json!({ "pinged": params }))
                    } else {
                        Err(format!("the shell answers no {method}"))
                    }
                }),
                hear: Box::new(move |method, params| {
                    let _ = heard_by.send((method.to_owned(), params));
                }),
                lost: Box::new(move |code| {
                    let _ = lost_by.send(code);
                }),
            },
        )?;
        Ok(Started {
            main,
            heard,
            lost,
            log,
            _dir: dir,
        })
    }

    fn read(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap_or_default()
    }

    const WAIT: Duration = Duration::from_secs(10);

    fn ask(main: &MainProcess, method: &str, params: &Value) -> Result<Value, RequestError> {
        main.request(method, params, WAIT)
    }

    #[test]
    fn relays_both_ways_and_stops_main_through_quit() -> Result<(), Box<dyn std::error::Error>> {
        // main runs on node; a machine without it has nothing here to run
        if !has_node() {
            return Ok(());
        }
        let started = start(tempfile::tempdir()?)?;
        let main = &started.main;
        assert_eq!(
            started.heard.recv_timeout(WAIT)?,
            ("hi".to_owned(), json!({ "n": 1 }))
        );
        assert_eq!(
            ask(main, "echo", &json!({ "a": [1, 2] })),
            Ok(json!({ "a": [1, 2] }))
        );
        assert_eq!(
            ask(main, "refuse", &Value::Null),
            Err(RequestError::Refused("no".to_owned()))
        );
        main.notify("ask", &json!("x"));
        assert_eq!(
            started.heard.recv_timeout(WAIT)?,
            ("pong".to_owned(), json!({ "pinged": "x" }))
        );

        main.stop();
        assert!(lock(&main.exit.state).exited);
        assert!(
            started
                .lost
                .recv_timeout(Duration::from_millis(200))
                .is_err()
        );
        assert_eq!(
            ask(main, "echo", &Value::Null),
            Err(RequestError::NotRunning)
        );
        let log = read(&started.log);
        assert!(log.contains(" main is up\n"), "{log}");
        assert!(log.contains(" [main] not a message\n"), "{log}");
        assert!(log.contains(" main exited (code 0)\n"), "{log}");
        Ok(())
    }

    #[test]
    fn a_main_that_stops_reading_is_stopped_all_the_same() -> Result<(), Box<dyn std::error::Error>>
    {
        if !has_node() {
            return Ok(());
        }
        let started = start(tempfile::tempdir()?)?;
        started.heard.recv_timeout(WAIT)?;
        started.main.notify("wedge", &Value::Null);
        thread::sleep(Duration::from_millis(300));
        let (stopped_by, stopped) = mpsc::channel();
        let main = Arc::clone(&started.main);
        thread::spawn(move || {
            // more than the pipe holds, for a main that no longer reads any of it
            let filler = json!("x".repeat(4096));
            for _ in 0..64 {
                main.notify("filler", &filler);
            }
            main.stop_within(Duration::from_millis(300));
            let _ = stopped_by.send(());
        });
        stopped.recv_timeout(EXIT_GRACE * 2 + WAIT)?;
        assert!(lock(&started.main.exit.state).exited);
        Ok(())
    }

    #[test]
    fn a_main_that_exits_unasked_fails_what_waits_on_it() -> Result<(), Box<dyn std::error::Error>>
    {
        if !has_node() {
            return Ok(());
        }
        let started = start(tempfile::tempdir()?)?;
        started.heard.recv_timeout(WAIT)?;
        let waiting = Arc::clone(&started.main);
        // a request main never answers, made before main goes
        let answer = thread::spawn(move || ask(&waiting, "hang", &Value::Null));
        thread::sleep(Duration::from_millis(300));
        started.main.notify("die", &Value::Null);
        assert_eq!(started.lost.recv_timeout(WAIT)?, Some(3));
        assert_eq!(
            answer.join().map_err(|_| "the request's thread panicked")?,
            Err(RequestError::Gone)
        );
        // stopping a main that is gone asks it nothing
        started.main.stop();
        Ok(())
    }

    #[test]
    fn a_main_that_never_boots_is_killed_at_the_deadline() -> Result<(), Box<dyn std::error::Error>>
    {
        if !has_node() {
            return Ok(());
        }
        let started = start(tempfile::tempdir()?)?;
        started.heard.recv_timeout(WAIT)?;
        let within = Duration::from_millis(300);
        let asked = Instant::now();
        assert_eq!(
            started.main.boot(&Value::Null, within),
            Err(RequestError::TimedOut(within))
        );
        assert!(asked.elapsed() < within + EXIT_GRACE);
        assert!(lock(&started.main.exit.state).exited);
        // the shell says why itself, so main is not lost
        assert!(
            started
                .lost
                .recv_timeout(Duration::from_millis(200))
                .is_err()
        );
        let log = read(&started.log);
        assert!(log.contains("main did not boot within 300ms"), "{log}");
        Ok(())
    }

    #[test]
    fn a_quit_during_a_boot_that_never_ends_ends_main_within_its_deadline()
    -> Result<(), Box<dyn std::error::Error>> {
        if !has_node() {
            return Ok(());
        }
        let started = start(tempfile::tempdir()?)?;
        started.heard.recv_timeout(WAIT)?;
        let booting = Arc::clone(&started.main);
        let asked = Instant::now();
        let hello = thread::spawn(move || booting.request("hello", &Value::Null, WAIT * 6));
        thread::sleep(Duration::from_millis(200));
        let quit = Duration::from_millis(300);
        started.main.stop_within(quit);
        assert!(lock(&started.main.exit.state).exited);
        assert_eq!(
            hello.join().map_err(|_| "the hello's thread panicked")?,
            Err(RequestError::Gone)
        );
        assert!(asked.elapsed() < Duration::from_millis(200) + quit + EXIT_GRACE * 2);
        Ok(())
    }
}

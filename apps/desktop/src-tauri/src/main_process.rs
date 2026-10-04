//! Main is a child, and its one supervisor is this module.
//!
//! The shell starts main on node, and from then on main's stdio is the one channel between the
//! window and the process that owns the save, the keys and the runs (`relay.rs`'s framing). The
//! window's invokes go down as requests and main's answers come back. What main asks of a native
//! app, and what it tells the window, goes to `host.rs`. Everything main prints to stderr is
//! appended to its log.
//!
//! Main's stdin is also its lifeline. The shell closes it only once main has answered `quit`, so a
//! shell that crashed or was killed ends main too, and main stops its runs on the way out. There
//! is no restart: main owns the save, and a second one under a first that has not let go would
//! race it.

use std::collections::{BTreeMap, HashMap};
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::thread;
use std::time::Duration;

use serde_json::Value;
use tokio::sync::oneshot;

use crate::main_log::MainLog;
use crate::relay::{self, Incoming};

/// How long a quit waits for main to stop its runs and answer: agents get a grace of their own
/// before main kills their groups, and this is past it.
pub const QUIT_TIMEOUT: Duration = Duration::from_secs(45);
/// How long main has to exit once its stdin closes, before SIGKILL.
const EXIT_GRACE: Duration = Duration::from_secs(5);

pub struct MainSpec {
    pub node: PathBuf,
    pub entry: PathBuf,
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

type Answer = oneshot::Sender<Result<Value, String>>;

pub struct MainProcess {
    pid: u32,
    stdin: Mutex<Option<ChildStdin>>,
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
        let process = Arc::new(Self {
            pid: child.id(),
            stdin: Mutex::new(child.stdin.take()),
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
            for (_, answer) in lock(&watched.pending).drain() {
                let _ = answer.send(Err("main is gone".to_owned()));
            }
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

    fn write(&self, line: &str) -> bool {
        let mut stdin = lock(&self.stdin);
        let Some(pipe) = stdin.as_mut() else {
            return false;
        };
        let written = pipe
            .write_all(line.as_bytes())
            .and_then(|()| pipe.write_all(b"\n"))
            .and_then(|()| pipe.flush());
        written.is_ok()
    }

    fn settle(&self, id: u64, outcome: Result<Value, String>) {
        if let Some(answer) = lock(&self.pending).remove(&id) {
            let _ = answer.send(outcome);
        }
    }

    /// Asks main, and waits for its answer: an error is main's refusal, or main being gone.
    pub async fn request(&self, method: &str, params: &Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let (answer, answered) = oneshot::channel();
        lock(&self.pending).insert(id, answer);
        if !self.write(&relay::request_line(id, method, params)) {
            lock(&self.pending).remove(&id);
            return Err("main is not running".to_owned());
        }
        answered
            .await
            .unwrap_or_else(|_| Err("main is gone".to_owned()))
    }

    /// Tells main, and waits for nothing.
    pub fn notify(&self, method: &str, params: &Value) {
        self.write(&relay::notification_line(method, params));
    }

    /// Main stops its runs and answers, then its stdin closes and it exits; one that does not is
    /// killed. Blocks: a quit has no later step to wait in.
    pub fn stop(&self) {
        {
            let mut state = lock(&self.exit.state);
            if state.exited || state.stopping {
                return;
            }
            state.stopping = true;
        }
        let answered = tauri::async_runtime::block_on(async {
            tokio::time::timeout(QUIT_TIMEOUT, self.request("quit", &Value::Null)).await
        });
        if !matches!(answered, Ok(Ok(_))) {
            self.note("[shell] main did not answer quit in time; closing it anyway");
        }
        lock(&self.stdin).take();
        if !self.wait_exit(EXIT_GRACE) {
            self.note("[shell] main did not exit once its stdin closed; sending SIGKILL");
            kill(self.pid);
            self.wait_exit(EXIT_GRACE);
        }
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
fn kill(pid: u32) {
    use nix::sys::signal::{Signal, killpg};
    use nix::unistd::Pid;
    if let Ok(pid) = i32::try_from(pid) {
        // main leads its own group: what it started and did not end goes with it
        let _ = killpg(Pid::from_raw(pid), Signal::SIGKILL);
    }
}

#[cfg(not(unix))]
fn kill(_pid: u32) {}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::sync::mpsc::Receiver;

    use serde_json::json;

    use super::*;

    /// A main that speaks the relay and nothing else: it answers `echo` and `refuse`, asks the shell
    /// for `host.ping` when told to `ask` and says what it heard back as `pong`, and exits when told
    /// to `die` or when its stdin closes.
    const FAKE_MAIN: &str = r#"
const readline = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
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
    else if (message.method === "quit") send({ id: message.id, result: null });
    else if (message.id === 900) send({ method: "pong", params: message.result ?? message.error });
  })
  .on("close", () => process.exit(0));
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

    fn ask(main: &MainProcess, method: &str, params: &Value) -> Result<Value, String> {
        tauri::async_runtime::block_on(main.request(method, params))
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
        assert_eq!(ask(main, "refuse", &Value::Null), Err("no".to_owned()));
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
            Err("main is not running".to_owned())
        );
        let log = read(&started.log);
        assert!(log.contains(" main is up\n"), "{log}");
        assert!(log.contains(" [main] not a message\n"), "{log}");
        assert!(log.contains(" main exited (code 0)\n"), "{log}");
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
            Err("main is gone".to_owned())
        );
        // stopping a main that is gone asks it nothing
        started.main.stop();
        Ok(())
    }
}

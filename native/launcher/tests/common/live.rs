//! A LIVE LAUNCHER IN A TEST: the fakes installed, a serving launcher in the test's roots, and its wire. Moved here from
//! tests/control.rs (L2-L5) so the update tests (L6, tests/updates.rs) drive the same launcher the same way.

use super::*;
use genie_launcher::install::{install_from, InstallOptions, Profile};
use genie_launcher::layout::{client_executable_name, host_executable_name, Roots, HOST_ENTRY};
use genie_launcher::local::LocalStream;
use genie_launcher::spawn::pid_alive;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Stdio};
use std::time::{Duration, Instant};

pub fn fake_bytes() -> Vec<u8> {
    std::fs::read(env!("CARGO_BIN_EXE_genie-fake-host")).expect("the fake host was built (cargo test --features test-keys)")
}

/// The host package of `build` whose program is the fake, shipping with the client of the same build.
pub fn fake_host_package(build: &str) -> Package<'_> {
    Package::new("host", build, vec![(host_executable_name().into(), fake_bytes()), (HOST_ENTRY.into(), format!("// host {build}").into_bytes())])
}

/// The client package of `build` whose program is the fake. Each build's bytes differ (a trailing note), as two real
/// client builds do.
pub fn fake_client_package(build: &str) -> Package<'_> {
    Package::new("client", build, vec![(client_executable_name().into(), fake_bytes()), ("resources/build.txt".into(), build.as_bytes().to_vec())])
}

pub fn browser_package(build: &str) -> Package<'_> {
    Package::new("browser", build, vec![("browser.json".into(), br#"{"runs":"client","args":["--genie-browser"]}"#.to_vec())])
}

/// Installs a client and a host whose programs are the fake, signed with `key`.
pub fn install_fakes(r: &Roots, key: &ed25519_dalek::SigningKey, base: &std::path::Path) {
    let from = base.join("from");
    write_package(&from, key, &fake_host_package("2026.11.25-1"));
    write_package(&from, key, &fake_client_package("2026.11.25-1"));
    write_package(&from, key, &browser_package("2026.11.25-1"));
    let options = InstallOptions { from, profile: Profile::Both, channel: "stable".into(), launcher_build: "2026.11.25-1".into() };
    install_from(r, &options, &[verifying(key)]).expect("the fakes install");
}

pub struct Launcher {
    pub child: Child,
    pub roots: Roots,
}

impl Drop for Launcher {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        // A launcher that took over from this one (a self-update), and a host a test left running, go too.
        if let Some(pid) = launcher_pid(&self.roots) {
            kill(pid);
        }
        if let Some(rec) = genie_launcher::host::read_record(&self.roots) {
            kill(rec.pid);
        }
    }
}

/// The pid `launcher.json` names now.
pub fn launcher_pid(r: &Roots) -> Option<u32> {
    let rec: Value = serde_json::from_str(&std::fs::read_to_string(r.runtime_dir().join("launcher.json")).ok()?).ok()?;
    rec["pid"].as_u64().map(|p| p as u32)
}

pub fn kill(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        let _ = std::process::Command::new(r"C:\Windows\System32\taskkill.exe").args(["/F", "/PID", &pid.to_string()]).output();
    }
}

pub fn start(r: &Roots, key: &ed25519_dalek::SigningKey) -> Launcher {
    start_with(r, key, genie_in(r, key))
}

/// A launcher started from `command` (genie_in's, with what a test adds: a feed, another program, shorter bounds).
pub fn start_with(r: &Roots, _key: &ed25519_dalek::SigningKey, mut command: std::process::Command) -> Launcher {
    // Its stderr goes to a file, so a launcher that refuses at start says why here (in 1125-060418-1c2da8 every test
    // waited 20 s and read only "launcher.json never appeared").
    let err_path = r.data.join(format!("launcher-stderr-{}-{}.log", std::process::id(), Instant::now().elapsed().as_nanos()));
    let err = std::fs::File::create(&err_path).expect("a stderr file");
    let mut child = command.arg("serve").stdin(Stdio::null()).stdout(Stdio::null()).stderr(err).spawn().expect("the launcher starts");
    let record = r.runtime_dir().join("launcher.json");
    let t = Instant::now();
    while !record.exists() {
        if let Ok(Some(status)) = child.try_wait() {
            panic!("the launcher exited ({status}) before launcher.json: {}", std::fs::read_to_string(&err_path).unwrap_or_default());
        }
        assert!(t.elapsed() < Duration::from_secs(20), "launcher.json never appeared: {}", std::fs::read_to_string(&err_path).unwrap_or_default());
        std::thread::sleep(Duration::from_millis(50));
    }
    Launcher { child, roots: r.clone() }
}

pub struct Wire {
    pub out: LocalStream,
    pub lines: BufReader<LocalStream>,
    pub next: u64,
}

impl Wire {
    pub fn open(r: &Roots) -> Wire {
        let rec: Value = serde_json::from_str(&std::fs::read_to_string(r.runtime_dir().join("launcher.json")).unwrap()).unwrap();
        let stream = LocalStream::connect(rec["endpoint"].as_str().unwrap(), Duration::from_secs(5)).expect("connects");
        Wire { out: stream.try_clone().unwrap(), lines: BufReader::new(stream), next: 1 }
    }
    pub fn send(&mut self, v: Value) {
        writeln!(self.out, "{v}").unwrap();
        self.out.flush().unwrap();
    }
    pub fn read(&mut self) -> Option<Value> {
        let mut line = String::new();
        match self.lines.read_line(&mut line) {
            Ok(0) | Err(_) => None,
            Ok(_) => Some(serde_json::from_str(&line).expect("a JSON line")),
        }
    }
    /// The hello; the welcome.
    pub fn hello_welcome(r: &Roots) -> (Wire, Value) {
        let mut w = Wire::open(r);
        let token = std::fs::read_to_string(r.runtime_dir().join("launcher.token")).unwrap();
        w.send(json!({"kind": "hello", "auth": {"kind": "token", "token": token.trim()}, "label": "test", "track": "client", "build": "2026.11.25-1", "schema": "2026.11.25", "minSchema": "2026.10.26", "capabilities": ["launcher@1"]}));
        let welcome = w.read().expect("an answer");
        assert_eq!(welcome["kind"], "welcome", "{welcome}");
        (w, welcome)
    }
    pub fn hello(r: &Roots) -> Wire {
        Wire::hello_welcome(r).0
    }
    pub fn call(&mut self, method: &str, args: Value) -> Value {
        let id = self.next;
        self.next += 1;
        self.send(json!({"kind": "call", "id": id, "method": method, "args": args}));
        loop {
            let v = self.read().expect("a result");
            if v["kind"] == "result" && v["id"] == id {
                return v;
            }
        }
    }
}

/// One launcher per user is the rule under test, so these tests run one at a time (on Windows the endpoint is the
/// user's own pipe, whatever the data root). Each test holds the guard for its whole run.
static ONE_AT_A_TIME: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn one_at_a_time() -> std::sync::MutexGuard<'static, ()> {
    ONE_AT_A_TIME.lock().unwrap_or_else(|p| p.into_inner())
}

pub fn setup(name: &str) -> (std::path::PathBuf, Roots, ed25519_dalek::SigningKey) {
    let base = temp_dir(name);
    let r = roots(&base);
    let key = throwaway_key();
    (base, r, key)
}

pub fn wait_for(what: &str, secs: u64, mut done: impl FnMut() -> bool) {
    let t = Instant::now();
    while !done() {
        assert!(t.elapsed() < Duration::from_secs(secs), "{what} (waited {secs} s)");
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// The host and one client that stays (attached to the launcher), started through the wire: (host pid, client pid).
pub fn host_and_staying_client(r: &Roots, w: &mut Wire) -> (u32, u32) {
    std::fs::write(r.data.join("fake-client-mode.txt"), "stay").unwrap();
    let h = w.call("launcher.ensureHost", json!([]));
    assert_eq!(h["ok"], true, "{h}");
    let host = h["value"]["pid"].as_u64().unwrap() as u32;
    let c = w.call("launcher.openWindow", json!([]));
    assert_eq!(c["ok"], true, "{c}");
    let client = c["value"]["pid"].as_u64().unwrap() as u32;
    wait_for("the client ran", 15, || std::fs::read_to_string(r.data.join("client-args.txt")).map(|t| t.contains("--open-window")).unwrap_or(false));
    // It has had time to attach (a real client attaches as its window comes up).
    std::thread::sleep(Duration::from_millis(1500));
    assert!(pid_alive(client), "the client stays up until it is closed");
    (host, client)
}

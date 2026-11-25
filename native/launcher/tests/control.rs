//! THE CONTROL WIRE AND THE HOST: one launcher per user, owner-only, a token and a negotiated hello; ensureHost starts
//! the current host from its verified folder (detached, its log as its only output) or adopts the one running; stopHost
//! is the graceful stop; openWindow and startBrowser start the client.
mod common;

use common::*;
use genie_launcher::install::{install_from, InstallOptions, Profile};
use genie_launcher::layout::{client_executable_name, host_executable_name, Roots, Track, HOST_ENTRY};
use genie_launcher::local::LocalStream;
use genie_launcher::spawn::pid_alive;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Stdio};
use std::time::{Duration, Instant};

fn fake_bytes() -> Vec<u8> {
    std::fs::read(env!("CARGO_BIN_EXE_genie-fake-host")).expect("the fake host was built (cargo test --features test-keys)")
}

/// Installs a client and a host whose programs are the fake, signed with `key`.
fn install_fakes(r: &Roots, key: &ed25519_dalek::SigningKey, base: &std::path::Path) {
    let from = base.join("from");
    let fake = fake_bytes();
    write_package(&from, key, &Package::new("host", "2026.11.25-1", vec![(host_executable_name().into(), fake.clone()), (HOST_ENTRY.into(), b"// host".to_vec())]));
    write_package(&from, key, &Package::new("client", "2026.11.25-1", vec![(client_executable_name().into(), fake)]));
    let options = InstallOptions { from, profile: Profile::Both, channel: "stable".into(), launcher_build: "2026.11.25-1".into() };
    install_from(r, &options, &[verifying(key)]).expect("the fakes install");
}

struct Launcher {
    child: Child,
    roots: Roots,
}

impl Drop for Launcher {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        // A host a test left running goes too.
        if let Some(rec) = genie_launcher::host::read_record(&self.roots) {
            kill(rec.pid);
        }
    }
}

fn kill(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        let _ = std::process::Command::new(r"C:\Windows\System32\taskkill.exe").args(["/F", "/PID", &pid.to_string()]).output();
    }
}

fn start(r: &Roots, key: &ed25519_dalek::SigningKey) -> Launcher {
    let child = genie_in(r, key).arg("serve").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().expect("the launcher starts");
    let record = r.runtime_dir().join("launcher.json");
    let t = Instant::now();
    while !record.exists() {
        assert!(t.elapsed() < Duration::from_secs(20), "launcher.json never appeared");
        std::thread::sleep(Duration::from_millis(50));
    }
    Launcher { child, roots: r.clone() }
}

struct Wire {
    out: LocalStream,
    lines: BufReader<LocalStream>,
    next: u64,
}

impl Wire {
    fn open(r: &Roots) -> Wire {
        let rec: Value = serde_json::from_str(&std::fs::read_to_string(r.runtime_dir().join("launcher.json")).unwrap()).unwrap();
        let stream = LocalStream::connect(rec["endpoint"].as_str().unwrap(), Duration::from_secs(5)).expect("connects");
        Wire { out: stream.try_clone().unwrap(), lines: BufReader::new(stream), next: 1 }
    }
    fn send(&mut self, v: Value) {
        writeln!(self.out, "{v}").unwrap();
        self.out.flush().unwrap();
    }
    fn read(&mut self) -> Option<Value> {
        let mut line = String::new();
        match self.lines.read_line(&mut line) {
            Ok(0) | Err(_) => None,
            Ok(_) => Some(serde_json::from_str(&line).expect("a JSON line")),
        }
    }
    fn hello(r: &Roots) -> Wire {
        let mut w = Wire::open(r);
        let token = std::fs::read_to_string(r.runtime_dir().join("launcher.token")).unwrap();
        w.send(json!({"kind": "hello", "auth": {"kind": "token", "token": token.trim()}, "label": "test", "track": "client", "build": "2026.11.25-1", "schema": "2026.11.25", "minSchema": "2026.10.26", "capabilities": ["launcher@1"]}));
        let welcome = w.read().expect("an answer");
        assert_eq!(welcome["kind"], "welcome", "{welcome}");
        w
    }
    fn call(&mut self, method: &str, args: Value) -> Value {
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

fn one_at_a_time() -> std::sync::MutexGuard<'static, ()> {
    ONE_AT_A_TIME.lock().unwrap_or_else(|p| p.into_inner())
}

fn setup(name: &str) -> (std::path::PathBuf, Roots, ed25519_dalek::SigningKey) {
    let base = temp_dir(name);
    let r = roots(&base);
    let key = throwaway_key();
    (base, r, key)
}

#[test]
fn one_launcher_per_user_and_it_says_so() {
    let _one = one_at_a_time();
    let (_b, r, key) = setup("single");
    let _l = start(&r, &key);
    let out = run(genie_in(&r, &key).arg("serve"));
    assert_eq!(out.status.code(), Some(125));
    assert!(text(&out).contains("already running"), "{}", text(&out));
}

#[test]
fn launcher_json_says_pid_endpoint_build_and_schema() {
    let _one = one_at_a_time();
    let (_b, r, key) = setup("record");
    let l = start(&r, &key);
    let rec: Value = serde_json::from_str(&std::fs::read_to_string(r.runtime_dir().join("launcher.json")).unwrap()).unwrap();
    assert_eq!(rec["pid"].as_u64(), Some(l.child.id() as u64));
    assert_eq!(rec["schema"], genie_launcher::LAUNCHER_SCHEMA);
    assert_eq!(rec["build"], genie_launcher::LAUNCHER_BUILD);
    assert!(rec["endpoint"].as_str().unwrap().len() > 4);
}

#[test]
fn the_endpoint_and_token_are_the_owners_only() {
    let _one = one_at_a_time();
    let (_b, r, key) = setup("owner-only");
    let _l = start(&r, &key);
    let rec: Value = serde_json::from_str(&std::fs::read_to_string(r.runtime_dir().join("launcher.json")).unwrap()).unwrap();
    let endpoint = rec["endpoint"].as_str().unwrap().to_string();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(endpoint, r.runtime_dir().join("launcher.sock").display().to_string());
        let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(std::path::Path::new(&endpoint)), 0o600);
        assert_eq!(mode(&r.runtime_dir().join("launcher.token")), 0o600);
    }
    #[cfg(windows)]
    {
        let sid = genie_launcher::win::current_user_sid().unwrap();
        assert_eq!(endpoint, format!(r"\\.\pipe\genie-launcher-{sid}"));
        assert_eq!(genie_launcher::win::pipe_dacl_sddl(&endpoint).unwrap(), format!("D:P(A;;FA;;;{sid})(A;;FA;;;SY)"));
    }
}

#[test]
fn a_wrong_token_is_refused_and_nothing_else_is_answered() {
    let _one = one_at_a_time();
    let (_b, r, key) = setup("token");
    let _l = start(&r, &key);
    let mut w = Wire::open(&r);
    w.send(json!({"kind": "hello", "auth": {"kind": "token", "token": "nope"}}));
    let v = w.read().expect("an answer");
    assert_eq!(v["kind"], "refused", "{v}");
    assert!(w.read().is_none(), "the connection is closed");
    let mut w = Wire::open(&r);
    w.send(json!({"kind": "call", "id": 1, "method": "launcher.status", "args": []}));
    let v = w.read().expect("an answer");
    assert_eq!(v["kind"], "refused", "a call before hello is refused: {v}");
}

#[test]
fn the_hello_is_negotiated_on_track_launcher() {
    let _one = one_at_a_time();
    let (_b, r, key) = setup("negotiate");
    let _l = start(&r, &key);
    let token = std::fs::read_to_string(r.runtime_dir().join("launcher.token")).unwrap();
    let mut w = Wire::open(&r);
    w.send(json!({"kind": "hello", "auth": {"kind": "token", "token": token.trim()}, "track": "client", "build": "2026.11.18-1", "schema": "2026.11.18", "minSchema": "2026.10.19", "capabilities": ["launcher@3", "x@1"]}));
    let v = w.read().unwrap();
    assert_eq!(v["kind"], "welcome", "{v}");
    assert_eq!(v["track"], "launcher");
    assert_eq!(v["schema"], genie_launcher::LAUNCHER_SCHEMA);
    assert_eq!(v["negotiated"]["schema"], "2026.11.18");
    assert_eq!(v["negotiated"]["capabilities"], json!(["launcher@1"]));
    // A peer older than the window: refused, with code version.
    let mut w = Wire::open(&r);
    w.send(json!({"kind": "hello", "auth": {"kind": "token", "token": token.trim()}, "track": "client", "build": "2026.09.01-1", "schema": "2026.09.01", "minSchema": "2026.08.02", "capabilities": []}));
    let v = w.read().unwrap();
    assert_eq!(v["kind"], "refused", "{v}");
    assert_eq!(v["code"], "version");
}

#[test]
fn status_answers_and_unknown_or_later_methods_say_unsupported() {
    let _one = one_at_a_time();
    let (base, r, key) = setup("methods");
    install_fakes(&r, &key, &base);
    let _l = start(&r, &key);
    let mut w = Wire::hello(&r);
    let s = w.call("launcher.status", json!([]));
    assert_eq!(s["ok"], true, "{s}");
    assert_eq!(s["value"]["tracks"]["host"]["current"], "2026.11.25-1");
    for m in ["launcher.updates", "launcher.check", "launcher.apply", "launcher.channel", "launcher.nope"] {
        let v = w.call(m, json!([]));
        assert_eq!(v["ok"], false, "{m}: {v}");
        assert_eq!(v["code"], "unsupported", "{m}: {v}");
    }
}

#[test]
fn ensure_host_starts_the_current_host_detached_then_adopts_it_and_stop_host_ends_it() {
    let _one = one_at_a_time();
    let (base, r, key) = setup("host");
    install_fakes(&r, &key, &base);
    let _l = start(&r, &key);
    let mut w = Wire::hello(&r);
    let v = w.call("launcher.ensureHost", json!([]));
    assert_eq!(v["ok"], true, "{v}");
    assert_eq!(v["value"]["how"], "started");
    assert_eq!(v["value"]["build"], "2026.11.25-1");
    let pid = v["value"]["pid"].as_u64().unwrap() as u32;
    assert!(pid_alive(pid));
    let rec = genie_launcher::host::read_record(&r).expect("host.json");
    assert_eq!(rec.pid, pid);
    // Its log is its output, and it runs in its own build folder.
    let log = std::fs::read_to_string(r.logs_dir().join("genie-host.log")).unwrap();
    assert!(log.contains("fake host up"), "{log}");
    let folder = r.build_dir(Track::Host, "2026.11.25-1").unwrap();
    assert!(log.contains(&format!("cwd {}", folder.display())), "{log}");
    assert!(log.contains(HOST_ENTRY.rsplit('/').next().unwrap()), "started with its entry: {log}");

    let again = w.call("launcher.ensureHost", json!([]));
    assert_eq!(again["value"]["how"], "adopted", "{again}");
    assert_eq!(again["value"]["pid"].as_u64(), Some(pid as u64));

    let stop = w.call("launcher.stopHost", json!([]));
    assert_eq!(stop["ok"], true, "{stop}");
    assert_eq!(stop["value"]["stopped"], true);
    assert!(!pid_alive(pid), "the host is gone once stopHost answers");
    let none = w.call("launcher.stopHost", json!([]));
    assert_eq!(none["value"]["stopped"], false, "{none}");
}

#[test]
fn the_host_outlives_the_launcher() {
    let _one = one_at_a_time();
    let (base, r, key) = setup("outlives");
    install_fakes(&r, &key, &base);
    let mut l = start(&r, &key);
    let v = Wire::hello(&r).call("launcher.ensureHost", json!([]));
    let pid = v["value"]["pid"].as_u64().unwrap() as u32;
    let _ = l.child.kill();
    let _ = l.child.wait();
    std::thread::sleep(Duration::from_millis(500));
    assert!(pid_alive(pid), "the host runs on when the launcher ends");
    // Drop ends the host.
}

#[test]
fn a_host_folder_with_no_complete_marker_is_never_started() {
    let _one = one_at_a_time();
    let (base, r, key) = setup("host-incomplete");
    install_fakes(&r, &key, &base);
    std::fs::remove_file(r.build_dir(Track::Host, "2026.11.25-1").unwrap().join(".complete")).unwrap();
    let out = run(genie_in(&r, &key).arg("ensure-host"));
    assert_eq!(out.status.code(), Some(125), "{}", text(&out));
    assert!(text(&out).contains(".complete"), "{}", text(&out));
    assert!(genie_launcher::host::read_record(&r).is_none(), "no host was started");
    assert!(!r.logs_dir().join("genie-host.log").exists());
}

#[test]
fn a_host_that_exits_at_boot_is_said_in_words_and_not_waited_for() {
    let _one = one_at_a_time();
    let (base, r, key) = setup("host-dies");
    install_fakes(&r, &key, &base);
    let t = Instant::now();
    let out = run(genie_in(&r, &key).arg("ensure-host").env("FAKE_HOST_MODE", "exit-at-boot"));
    assert_eq!(out.status.code(), Some(125), "{}", text(&out));
    assert!(text(&out).contains("exited before it answered"), "{}", text(&out));
    assert!(t.elapsed() < Duration::from_secs(30), "not the whole minute");
}

#[test]
fn open_window_and_start_browser_start_the_current_client() {
    let _one = one_at_a_time();
    let (base, r, key) = setup("client");
    install_fakes(&r, &key, &base);
    let _l = start(&r, &key);
    let mut w = Wire::hello(&r);
    let v = w.call("launcher.openWindow", json!([{"host": "h1"}]));
    assert_eq!(v["ok"], true, "{v}");
    let v = w.call("launcher.startBrowser", json!([]));
    assert_eq!(v["ok"], true, "{v}");
    let file = r.data.join("client-args.txt");
    let t = Instant::now();
    loop {
        let text = std::fs::read_to_string(&file).unwrap_or_default();
        if text.lines().count() >= 2 {
            assert!(text.lines().any(|l| l == "--host h1"), "{text}");
            assert!(text.lines().any(|l| l == "--genie-browser"), "{text}");
            break;
        }
        assert!(t.elapsed() < Duration::from_secs(15), "the client never ran: {text}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

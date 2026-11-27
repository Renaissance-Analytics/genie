//! THE CONTROL WIRE AND THE HOST: one launcher per user, owner-only, a token and a negotiated hello; ensureHost starts
//! the current host from its verified folder (detached, its log as its only output) or adopts the one running; stopHost
//! is the graceful stop; openWindow starts the client and startBrowser the browser, each from its own track.
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
    write_package(&from, key, &Package::new("client", "2026.11.25-1", vec![(client_executable_name().into(), fake.clone())]));
    let _ = fake;
    write_package(&from, key, &Package::new("browser", "2026.11.25-1", vec![("browser.json".into(), br#"{"runs":"client","args":["--genie-browser"]}"#.to_vec())]));
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
    // Its stderr goes to a file, so a launcher that refuses at start says why here (in 1125-060418-1c2da8 every test
    // waited 20 s and read only "launcher.json never appeared").
    let err_path = r.data.join(format!("launcher-stderr-{}.log", std::process::id()));
    let err = std::fs::File::create(&err_path).expect("a stderr file");
    let mut child = genie_in(r, key).arg("serve").stdin(Stdio::null()).stdout(Stdio::null()).stderr(err).spawn().expect("the launcher starts");
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
    // What the host is handed: the launcher (genie-launch.exe's modes live in it now) and its own resources folder
    // (the bundled Caddy), never the client's.
    let me = std::path::PathBuf::from(env!("CARGO_BIN_EXE_genie"));
    assert!(log.contains(&format!("launcher={}", me.display())), "the host is told where the launcher is: {log}");
    assert!(log.contains(&format!("resources={}", folder.join("resources").display())), "{log}");

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
fn open_window_starts_the_current_client_and_start_browser_the_current_browser() {
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

fn lines_of(file: &std::path::Path, n: usize) -> String {
    let t = Instant::now();
    loop {
        let text = std::fs::read_to_string(file).unwrap_or_default();
        if text.lines().count() >= n {
            return text;
        }
        assert!(t.elapsed() < Duration::from_secs(20), "{} has {} of {n} lines: {text}", file.display(), text.lines().count());
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn the_client_and_the_browser_each_run_from_their_own_track_told_the_launcher_and_the_host_build() {
    let _one = one_at_a_time();
    let (base, r, key) = setup("programs");
    install_fakes(&r, &key, &base);
    let _l = start(&r, &key);
    let mut w = Wire::hello(&r);
    assert_eq!(w.call("launcher.openWindow", json!([]))["ok"], true);
    assert_eq!(w.call("launcher.startBrowser", json!([]))["ok"], true);
    let text = lines_of(&r.data.join("client-env.txt"), 2);
    let me = std::path::PathBuf::from(env!("CARGO_BIN_EXE_genie"));
    let client = r.build_dir(Track::Client, "2026.11.25-1").unwrap().join(client_executable_name());
    // The browser is the client build its manifest names, run with --genie-browser: no second copy of the app.
    let browser = client.clone();
    let open = text.lines().find(|l| l.starts_with("--open-window |")).unwrap_or_else(|| panic!("{text}"));
    assert!(open.contains(&format!("exe={}", client.display())), "the window is the client track's program: {open}");
    assert!(open.contains(&format!("launcher={}", me.display())), "{open}");
    assert!(open.contains("hostBuild=2026.11.25-1"), "the client is told the host it links to: {open}");
    let b = text.lines().find(|l| l.starts_with("--genie-browser |")).unwrap_or_else(|| panic!("{text}"));
    assert!(b.contains(&format!("exe={}", browser.display())), "the browser runs the installed client build: {b}");
}

#[test]
fn the_registry_names_every_program_the_launcher_starts() {
    use genie_launcher::components::{component, Kind, COMPONENTS};
    let ids: Vec<&str> = COMPONENTS.iter().map(|c| c.id).collect();
    assert_eq!(ids, vec!["host", "client", "browser"], "the launcher starts the host, the client and the browser by default");
    let host = component("host").unwrap();
    assert_eq!(host.kind, Kind::Service);
    assert!(host.restarts_host, "a host update restarts the host");
    assert_eq!(host.ships_with, Some(Track::Client), "a host update always comes with its client");
    for id in ["client", "browser"] {
        let c = component(id).unwrap();
        assert!(!c.restarts_host, "{id} updates without the host restarting or stopping");
        assert_eq!(c.ships_with, None);
        assert_eq!(c.kind, Kind::Window);
    }
    assert_eq!(component("client").unwrap().track, Track::Client);
    assert_eq!(component("browser").unwrap().track, Track::Browser);
    assert_eq!(component("browser").unwrap().runs, Some(Track::Client), "the browser runs on the client its manifest names");
    assert_eq!(component("client").unwrap().runs, None);
    assert_eq!(component("browser").unwrap().args, &["--genie-browser"]);
    assert!(component("client").unwrap().args.is_empty());
    assert!(component("a-gapp").is_none(), "no GApp is registered yet; they join the registry later");
    // Every component that runs a program of its own has it in its own track's folder.
    let r = Roots { code: std::path::PathBuf::from(if cfg!(windows) { r"C:\code" } else { "/code" }), data: std::path::PathBuf::from(if cfg!(windows) { r"C:\data" } else { "/data" }) };
    for c in COMPONENTS.iter().filter(|c| c.runs.is_none()) {
        let p = r.program(c.track, "2026.11.25-1").expect("a program");
        assert!(p.path().starts_with(r.build_dir(c.track, "2026.11.25-1").unwrap()), "{}", c.id);
    }
}

#[test]
fn genie_with_no_arguments_opens_genie_and_a_second_asks_the_first() {
    let _one = one_at_a_time();
    let (base, r, key) = setup("open");
    install_fakes(&r, &key, &base);
    // As the Start menu shortcut runs it: no arguments. It starts the host (profile both), then a client window.
    let err = std::fs::File::create(r.data.join("open-stderr.log")).unwrap();
    let child = genie_in(&r, &key).stdin(Stdio::null()).stdout(Stdio::null()).stderr(err).spawn().expect("the launcher starts");
    let _l = Launcher { child, roots: r.clone() };
    let args = lines_of(&r.data.join("client-args.txt"), 1);
    assert_eq!(args.lines().next(), Some("--open-window"), "{args}");
    let rec = genie_launcher::host::read_record(&r).expect("the host was started first");
    assert!(pid_alive(rec.pid));
    // A second `genie` (a second click) asks the running launcher for a window and exits: one launcher per user.
    let out = run(&mut genie_in(&r, &key));
    assert!(out.status.success(), "{}", text(&out));
    let args = lines_of(&r.data.join("client-args.txt"), 2);
    assert_eq!(args.lines().nth(1), Some("--open-window"), "{args}");
    // Doctor mode (the Start menu's second entry) is the client's --doctor.
    let out = run(genie_in(&r, &key).arg("--doctor"));
    assert!(out.status.success(), "{}", text(&out));
    let args = lines_of(&r.data.join("client-args.txt"), 3);
    assert_eq!(args.lines().nth(2), Some("--doctor"), "{args}");
}

#[test]
fn uninstall_stops_the_host_and_the_running_launcher_then_removes_the_programs() {
    // The NSIS uninstaller runs `Genie.exe uninstall` while the launcher serves from Genie.exe: unless the launcher ends,
    // its file cannot be removed (gate 1126-222922-9e0b4e: "the launcher is still installed after the uninstall").
    let _one = one_at_a_time();
    let (base, r, key) = setup("uninstall");
    install_fakes(&r, &key, &base);
    let mut l = start(&r, &key);
    let mut w = Wire::hello(&r);
    let host = w.call("launcher.ensureHost", json!([]));
    let host_pid = host["value"]["pid"].as_u64().unwrap() as u32;
    let out = run(genie_in(&r, &key).args(["uninstall", "--yes"]));
    assert!(out.status.success(), "{}", text(&out));
    assert!(!pid_alive(host_pid), "the host stopped");
    let t = Instant::now();
    loop {
        if let Ok(Some(_)) = l.child.try_wait() {
            break;
        }
        assert!(t.elapsed() < Duration::from_secs(15), "the running launcher did not end");
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!r.code.exists(), "the programs folder is gone");
    assert!(r.data.exists(), "the data root is kept");
}

// --- L5 (Tynn #1058): quit, logon and the graceful stop -------------------------------------------------------------

fn wait_for(what: &str, secs: u64, mut done: impl FnMut() -> bool) {
    let t = Instant::now();
    while !done() {
        assert!(t.elapsed() < Duration::from_secs(secs), "{what} (waited {secs} s)");
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// The host and one client that stays (attached to the launcher), started through the wire: (host pid, client pid).
fn host_and_staying_client(r: &Roots, w: &mut Wire) -> (u32, u32) {
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

#[test]
fn just_close_the_ui_ends_the_client_process_only() {
    let _one = one_at_a_time();
    let (base, r, key) = setup("close-ui");
    install_fakes(&r, &key, &base);
    let mut l = start(&r, &key);
    let mut w = Wire::hello(&r);
    let (host, client) = host_and_staying_client(&r, &mut w);
    let v = w.call("launcher.closeUi", json!([]));
    assert_eq!(v["ok"], true, "Just close the UI is the launcher's: {v}");
    wait_for("the client process ended", 15, || !pid_alive(client));
    assert!(r.data.join(format!("client-closed-{client}.txt")).exists(), "the client closed because the launcher said so, not ended from outside");
    // Only the client: the host and the launcher keep running, the host with the same pid.
    std::thread::sleep(Duration::from_millis(500));
    assert!(pid_alive(host), "the host keeps running");
    assert_eq!(genie_launcher::host::read_record(&r).map(|rec| rec.pid), Some(host), "the same host");
    assert!(matches!(l.child.try_wait(), Ok(None)), "the launcher keeps running (the tray stays)");
    let s = Wire::hello(&r).call("launcher.status", json!([]));
    assert_eq!(s["value"]["host"]["running"], true, "{s}");
    assert_eq!(s["value"]["host"]["pid"].as_u64(), Some(host as u64), "{s}");
    // P6: the host was left running, so it comes back at logon.
    assert!(r.runtime_dir().join("left-running").exists(), "Just close the UI marks the host left running");
}

#[test]
fn shut_down_everything_stops_the_host_gracefully_then_the_launcher_exits() {
    let _one = one_at_a_time();
    let (base, r, key) = setup("shut-down");
    install_fakes(&r, &key, &base);
    std::fs::write(r.data.join("fake-host-mode.txt"), "slow-stop").unwrap();
    let mut l = start(&r, &key);
    let mut w = Wire::hello(&r);
    std::fs::write(r.runtime_dir().join("left-running"), "").unwrap();
    let (host, client) = host_and_staying_client(&r, &mut w);
    let v = w.call("launcher.shutDown", json!([]));
    assert_eq!(v["ok"], true, "Shut down everything is the launcher's: {v}");
    // The launcher exits, and only once the host has gone.
    let t = Instant::now();
    let status = loop {
        if let Ok(Some(status)) = l.child.try_wait() {
            break status;
        }
        assert!(t.elapsed() < Duration::from_secs(60), "the launcher did not exit after Shut down everything");
        std::thread::sleep(Duration::from_millis(50));
    };
    assert!(status.success(), "the launcher exits cleanly: {status}");
    assert!(!pid_alive(host), "the host had gone before the launcher exited");
    // Gracefully: the host ran its own stop to the end (its clean-exit marker), it was not ended from outside.
    assert!(r.data.join("host-clean-exit.txt").exists(), "the host's own clean exit: a graceful stop, never a crash");
    let log = std::fs::read_to_string(r.logs_dir().join("genie-host.log")).unwrap_or_default();
    assert!(log.contains("fake host shut down"), "{log}");
    assert!(!pid_alive(client), "the client windows closed too");
    assert!(r.data.join(format!("client-closed-{client}.txt")).exists(), "the client closed because the launcher said so");
    assert!(!r.runtime_dir().join("left-running").exists(), "everything shut down: the host was not left running");
}

/// Tynn #1079: "Shut down everything" killed a host 5 s in while it was still stopping 122 processes, so its next boot
/// read a crash. A stop that keeps making progress is waited for, however long it takes, and never ended.
#[test]
fn a_slow_but_clean_stop_is_waited_for_and_never_ended() {
    let (base, r, key) = setup("slow-stop");
    install_fakes(&r, &key, &base);
    std::fs::write(r.data.join("fake-host-mode.txt"), "slow-stop").unwrap();
    let started = genie_launcher::host::ensure_host(&r, &[verifying(&key)]).expect("the host starts");
    let pid = started["pid"].as_u64().unwrap() as u32;
    // A stall bound shorter than the whole stop (~2.5 s): only progress that stops moving may end a host.
    let bounds = genie_launcher::host::StopBounds { stall: Duration::from_secs(1), max: Duration::from_secs(60) };
    let answer = genie_launcher::host::stop_host_with(&r, bounds);
    let clean = r.data.join("host-clean-exit.txt").exists();
    if pid_alive(pid) {
        kill(pid);
    }
    assert!(answer.is_ok(), "a slow stop that keeps moving is not a failure: {answer:?}");
    assert_eq!(answer.unwrap()["stopped"], true);
    assert!(clean, "the host reached its own clean exit: it was not ended, so its next boot reads no crash");
}

#[test]
fn a_stop_whose_progress_stands_still_is_ended_and_said() {
    let (base, r, key) = setup("stall-stop");
    install_fakes(&r, &key, &base);
    std::fs::write(r.data.join("fake-host-mode.txt"), "stall-stop").unwrap();
    let started = genie_launcher::host::ensure_host(&r, &[verifying(&key)]).expect("the host starts");
    let pid = started["pid"].as_u64().unwrap() as u32;
    let bounds = genie_launcher::host::StopBounds { stall: Duration::from_secs(1), max: Duration::from_secs(60) };
    let t = Instant::now();
    let answer = genie_launcher::host::stop_host_with(&r, bounds);
    let gone = genie_launcher::spawn::wait_gone(pid, Duration::from_secs(5));
    if !gone {
        kill(pid);
    }
    let why = answer.expect_err("a host that stopped moving is not a clean stop");
    assert!(why.contains("made no progress"), "said in words: {why}");
    assert!(why.contains("hosting"), "the step it stood still in is named: {why}");
    assert!(gone, "it was ended");
    assert!(t.elapsed() < Duration::from_secs(20), "not held for the whole bound");
    assert!(!r.data.join("host-clean-exit.txt").exists());
}

fn write_logon_inputs(r: &Roots, setting: bool, start_minimized: bool, left_running: bool) {
    std::fs::create_dir_all(r.runtime_dir()).unwrap();
    std::fs::write(r.runtime_dir().join("logon.json"), json!({"setting": setting, "startMinimized": start_minimized}).to_string()).unwrap();
    let mark = r.runtime_dir().join("left-running");
    if left_running {
        std::fs::write(&mark, "").unwrap();
    } else {
        let _ = std::fs::remove_file(&mark);
    }
}

/// `genie --logon` as the entry runs it, its stderr kept.
fn logon_run(r: &Roots, key: &ed25519_dalek::SigningKey) -> Launcher {
    let err = std::fs::File::create(r.data.join("logon-stderr.log")).unwrap();
    let child = genie_in(r, key).arg("--logon").stdin(Stdio::null()).stdout(Stdio::null()).stderr(err).spawn().expect("the launcher starts");
    Launcher { child, roots: r.clone() }
}

#[test]
fn at_logon_shut_down_with_the_setting_off_stays_down() {
    let _one = one_at_a_time();
    let (base, r, key) = setup("logon-down");
    install_fakes(&r, &key, &base);
    write_logon_inputs(&r, false, false, false);
    let mut l = logon_run(&r, &key);
    let t = Instant::now();
    let status = loop {
        if let Ok(Some(s)) = l.child.try_wait() {
            break s;
        }
        assert!(t.elapsed() < Duration::from_secs(15), "the launcher stayed up at logon with the setting off and nothing left running");
        std::thread::sleep(Duration::from_millis(50));
    };
    assert!(status.success(), "{status}: {}", std::fs::read_to_string(r.data.join("logon-stderr.log")).unwrap_or_default());
    assert!(genie_launcher::host::read_record(&r).is_none(), "no host was started");
    assert!(!r.data.join("client-args.txt").exists(), "no window was opened");
}

#[test]
fn at_logon_with_the_setting_on_the_host_starts_and_a_window_opens() {
    let _one = one_at_a_time();
    let (base, r, key) = setup("logon-on");
    install_fakes(&r, &key, &base);
    write_logon_inputs(&r, true, false, false);
    let mut l = logon_run(&r, &key);
    wait_for("the host started at logon", 30, || genie_launcher::host::read_record(&r).map(|rec| pid_alive(rec.pid)).unwrap_or(false));
    let args = lines_of(&r.data.join("client-args.txt"), 1);
    assert_eq!(args.lines().next(), Some("--open-window"), "{args}");
    assert!(matches!(l.child.try_wait(), Ok(None)), "the launcher stays (the tray)");
}

#[test]
fn at_logon_a_host_left_running_comes_back_with_no_window() {
    let _one = one_at_a_time();
    let (base, r, key) = setup("logon-left");
    install_fakes(&r, &key, &base);
    write_logon_inputs(&r, false, false, true);
    let mut l = logon_run(&r, &key);
    wait_for("the host started at logon", 30, || genie_launcher::host::read_record(&r).map(|rec| pid_alive(rec.pid)).unwrap_or(false));
    std::thread::sleep(Duration::from_secs(2));
    assert!(!r.data.join("client-args.txt").exists(), "no window: the person had closed the UI");
    assert!(matches!(l.child.try_wait(), Ok(None)), "the launcher stays (the tray)");
}

#[test]
fn the_client_says_the_settings_and_the_launcher_writes_the_logon_entry() {
    let _one = one_at_a_time();
    let (base, r, key) = setup("logon-wire");
    install_fakes(&r, &key, &base);
    let _l = start(&r, &key);
    let mut w = Wire::hello(&r);
    let place = test_logon_place(&r);
    let v = w.call("launcher.logon", json!([{"setting": true, "startMinimized": true}]));
    assert_eq!(v["ok"], true, "{v}");
    assert_eq!(genie_launcher::logon::read_settings(&r), genie_launcher::logon::LogonSettings { setting: true, start_minimized: true });
    let entry = genie_launcher::logon::read_entry(&place).expect("the setting on: the entry is written");
    assert!(entry.contains("--logon"), "{entry}");
    assert!(entry.contains(&std::path::PathBuf::from(env!("CARGO_BIN_EXE_genie")).display().to_string()), "it runs this launcher: {entry}");
    let v = w.call("launcher.logon", json!([{"setting": false, "startMinimized": true}]));
    assert_eq!(v["ok"], true, "{v}");
    assert_eq!(genie_launcher::logon::read_entry(&place), None, "the setting off (nothing left running): removed, live");
}

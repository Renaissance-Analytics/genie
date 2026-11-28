//! A STAND-IN FOR genie-host AND genie-client in the launcher's tests (built only with the `test-keys` feature). As a
//! host it does what the launcher relies on: binds its endpoint, writes `host.token` and `host.json` (pid, endpoint,
//! protocol 4, its GENIE_HOST_BUILD), answers `hello` with the token by a `welcome`, `engine.ping`, and `engine.shutdown`
//! by exiting. As a client (any of `--host`, `--genie-browser`, `--open-window`, `--doctor`) it writes its arguments to
//! `<GENIE_HOME>/client-args.txt`, and its own path with what the launcher handed it (GENIE_LAUNCHER_EXE,
//! GENIE_LAUNCHER_HOST_BUILD) to `<GENIE_HOME>/client-env.txt`, and exits. As a host it prints the same, and its
//! GENIE_RESOURCES. FAKE_HOST_MODE=exit-at-boot makes the host exit at once.
//!
//! L5 (Tynn #1058): a mode may also be written in `<GENIE_HOME>/fake-host-mode.txt` (one test's host, not every child of
//! the test process). `slow-stop`: `engine.shutdown` takes ~2.5 s, writing its progress to `<runtime>/host-stopping.json`
//! every 250 ms as genie-host does (one process fewer each time), then a clean exit. `stall-stop`: it writes its progress
//! once and then never moves or exits. Every clean exit writes `<GENIE_HOME>/host-clean-exit.txt` last (genie-host's
//! clean-exit marker: a host ended before it is a crash at the next boot). As a client, `<GENIE_HOME>/fake-client-mode.txt`
//! = `stay` keeps it running: it attaches to the launcher (`launcher.attach`) and exits only when the launcher says
//! `launcher.closeUi`, writing `<GENIE_HOME>/client-closed-<pid>.txt` first.
//!
//! L6 (updates): every host step is a line of `<GENIE_HOME>/journal.txt` (`boot <pid> <build> current=<state.json's host
//! current> prev-alive=<the host booted before it still running>`, `drain`, `stop`, `exit`, `restore`, `shutdown`), so a
//! test reads the order across processes. A mode may be one build's (`fake-host-mode-<build>.txt`); `hang` never writes
//! host.json or answers. `engine.updates install` is genie-host's install through its UpdateHost: the drain (who comes
//! back written to `<runtime>/running-at-quit.json`), the stop, `launcher.apply {track: host, afterPid}`, then the exit.
//! At boot a host that finds `running-at-quit.json` restores from it once and spends it. A staying client writes each
//! `launcher.updateReady` it is told to `<GENIE_HOME>/client-update-ready-<pid>.txt`. `--handover <pid>` is a new launcher
//! that never takes the pipe: it writes `<GENIE_HOME>/handover-pid.txt` and waits.
//!
//! L7 (the host's tools): `engine.toolchain` as genie-host answers the launcher (src/main/launcher-toolchain.ts): `state`
//! and `check` answer the rows in `<GENIE_HOME>/fake-host-tools.json` (else one Node row, 24.10.0 → 24.11.1), and write
//! `toolchain-state` / `toolchain-check` to `<GENIE_HOME>/toolchain.txt` (not the lifecycle journal); `update [{tool, version,
//! confirmed}]` writes `toolchain-update <pid> <tool>
//! <version> confirmed=<bool>` and answers `{started}`: the install is the host's, never the launcher's.

use genie_launcher::local::LocalListener;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let home = PathBuf::from(std::env::var("GENIE_HOME").expect("GENIE_HOME"));
    println!("fake {} args {:?} cwd {}", std::process::id(), args, std::env::current_dir().unwrap().display());
    let env = |k: &str| std::env::var(k).unwrap_or_else(|_| "-".to_string());
    let exe = std::env::current_exe().unwrap().display().to_string();
    if args.iter().any(|a| a == "--handover") {
        let _ = std::fs::write(home.join("handover-pid.txt"), std::process::id().to_string());
        std::thread::sleep(std::time::Duration::from_secs(120));
        return;
    }
    if args.iter().any(|a| a == "--host" || a == "--genie-browser" || a == "--open-window" || a == "--doctor") {
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(home.join("client-args.txt")).unwrap();
        writeln!(f, "{}", args.join(" ")).unwrap();
        let mut e = std::fs::OpenOptions::new().create(true).append(true).open(home.join("client-env.txt")).unwrap();
        writeln!(e, "{} | exe={exe} launcher={} hostBuild={}", args.join(" "), env("GENIE_LAUNCHER_EXE"), env("GENIE_LAUNCHER_HOST_BUILD")).unwrap();
        drop(e);
        drop(f);
        if std::fs::read_to_string(home.join("fake-client-mode.txt")).map(|m| m.trim() == "stay").unwrap_or(false) && !args.iter().any(|a| a == "--genie-browser") {
            stay_attached(&home);
        }
        return;
    }
    println!("fake host env exe={exe} launcher={} resources={}", env("GENIE_LAUNCHER_EXE"), env("GENIE_RESOURCES"));
    let build = std::env::var("GENIE_HOST_BUILD").unwrap_or_default();
    let mode = std::env::var("FAKE_HOST_MODE")
        .ok()
        .or_else(|| std::fs::read_to_string(home.join(format!("fake-host-mode-{build}.txt"))).ok().map(|m| m.trim().to_string()))
        .or_else(|| std::fs::read_to_string(home.join("fake-host-mode.txt")).ok().map(|m| m.trim().to_string()))
        .unwrap_or_default();
    let me = std::process::id();
    let prev_alive = last_boot(&home).map(|p| p != me && genie_launcher::spawn::pid_alive(p)).unwrap_or(false);
    journal(&home, &format!("boot {me} {build} current={} prev-alive={prev_alive}", state_host_current()));
    if mode == "exit-at-boot" {
        journal(&home, &format!("exit-at-boot {me}"));
        std::process::exit(3);
    }
    if mode == "hang" {
        journal(&home, &format!("hang {me}"));
        loop {
            std::thread::sleep(std::time::Duration::from_secs(60));
        }
    }
    let runtime = home.join("runtime");
    std::fs::create_dir_all(&runtime).unwrap();
    let endpoint = if cfg!(windows) { format!(r"\\.\pipe\genie-host-fake-{}", std::process::id()) } else { runtime.join("host.sock").display().to_string() };
    let listener = LocalListener::bind(&endpoint).expect("bind");
    let token = format!("t{}", std::process::id());
    std::fs::write(runtime.join("host.token"), &token).unwrap();
    let record = json!({"pid": std::process::id(), "endpoint": endpoint, "protocol": 4, "build": build, "startedAt": 1});
    std::fs::write(runtime.join("host.json.tmp"), record.to_string()).unwrap();
    std::fs::rename(runtime.join("host.json.tmp"), runtime.join("host.json")).unwrap();
    println!("fake host up on {endpoint}");
    // The once-only restore: the record is spent only by a restore that happened.
    let roster = runtime.join("running-at-quit.json");
    if let Ok(text) = std::fs::read_to_string(&roster) {
        journal(&home, &format!("restore {me} {}", text.trim()));
        let _ = std::fs::remove_file(&roster);
    }
    loop {
        let Ok(stream) = listener.accept() else { continue };
        let token = token.clone();
        let build = build.clone();
        let runtime = runtime.clone();
        let home = home.clone();
        let mode = mode.clone();
        std::thread::spawn(move || {
            let mut out = stream.try_clone().unwrap();
            let mut welcomed = false;
            for line in BufReader::new(stream).lines() {
                let Ok(line) = line else { return };
                let Ok(frame) = serde_json::from_str::<Value>(&line) else { return };
                if !welcomed {
                    if frame["kind"] == "hello" && frame["auth"]["token"] == token.as_str() {
                        welcomed = true;
                        let _ = writeln!(out, "{}", json!({"kind": "welcome", "connectionId": "c1", "host": "fake", "isOwner": true, "workspaceId": null, "protocol": 4, "build": build, "pid": std::process::id()}));
                        continue;
                    }
                    let _ = writeln!(out, "{}", json!({"kind": "refused", "reason": "bad token"}));
                    return;
                }
                let id = frame["id"].clone();
                match frame["method"].as_str() {
                    Some("engine.updates") if frame["args"][0] == "install" => {
                        let _ = writeln!(out, "{}", json!({"kind": "result", "id": id, "ok": true, "value": {"installing": true}}));
                        let _ = out.flush();
                        let me = std::process::id();
                        journal(&home, &format!("drain {me}"));
                        let _ = std::fs::write(runtime.join("running-at-quit.json"), r#"{"agents":["Researcher","Builder","Reviewer"]}"#);
                        journal(&home, &format!("stop {me}"));
                        let asked = ask_launcher(&home, "launcher.apply", json!([{"track": "host", "afterPid": me}]));
                        journal(&home, &format!("apply-asked {me} {asked}"));
                        let _ = std::fs::remove_file(runtime.join("host.json"));
                        let _ = std::fs::write(home.join("host-clean-exit.txt"), format!("{me}"));
                        journal(&home, &format!("exit {me}"));
                        std::process::exit(0);
                    }
                    Some("engine.toolchain") => {
                        let me = std::process::id();
                        let rows = || -> Value {
                            std::fs::read_to_string(home.join("fake-host-tools.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_else(|| {
                                json!({"rows": [{"tool": "node", "label": "Node", "installed": "24.10.0", "to": "24.11.1", "tone": "update-available"}], "checkedAt": 1, "checking": false})
                            })
                        };
                        let answer = match frame["args"][0].as_str() {
                            Some("state") => {
                                tool_journal(&home, &format!("toolchain-state {me}"));
                                json!({"kind": "result", "id": id, "ok": true, "value": rows()})
                            }
                            Some("check") => {
                                tool_journal(&home, &format!("toolchain-check {me}"));
                                json!({"kind": "result", "id": id, "ok": true, "value": rows()})
                            }
                            Some("update") => {
                                let a = &frame["args"][1][0];
                                let tool = a["tool"].as_str().unwrap_or("-");
                                let version = a["version"].as_str().unwrap_or("-");
                                tool_journal(&home, &format!("toolchain-update {me} {tool} {version} confirmed={}", a["confirmed"] == true));
                                json!({"kind": "result", "id": id, "ok": true, "value": {"started": true, "tool": tool, "version": version}})
                            }
                            other => json!({"kind": "result", "id": id, "ok": false, "reason": format!("Genie’s launcher may not ask the toolchain for {}.", other.unwrap_or("-"))}),
                        };
                        let _ = writeln!(out, "{answer}");
                    }
                    // The tray's "Open Genie Browser" (tests/tray_browser.rs): `engine.browser open [address, activation]`,
                    // held as genie-host holds it for a Browser not yet linked; a line of `<GENIE_HOME>/browser.txt`.
                    Some("engine.browser") => {
                        let method = frame["args"][0].as_str().unwrap_or("-");
                        let args = frame["args"].get(1).cloned().unwrap_or(json!([]));
                        browser_journal(&home, &format!("browser-{method} {} {args}", std::process::id()));
                        let _ = writeln!(out, "{}", json!({"kind": "result", "id": id, "ok": true, "value": {"browserUp": false}}));
                    }
                    Some("engine.ping") => { let _ = writeln!(out, "{}", json!({"kind": "result", "id": id, "ok": true, "value": "pong"})); }
                    Some("engine.shutdown") => {
                        let _ = writeln!(out, "{}", json!({"kind": "result", "id": id, "ok": true, "value": true}));
                        let _ = out.flush();
                        println!("fake host shutting down ({})", if mode.is_empty() { "quick" } else { mode.as_str() });
                        let progress = |step: &str, remaining: u32| {
                            let tmp = runtime.join("host-stopping.json.tmp");
                            let _ = std::fs::write(&tmp, json!({"pid": std::process::id(), "step": step, "remaining": remaining, "at": 0}).to_string());
                            let _ = std::fs::rename(&tmp, runtime.join("host-stopping.json"));
                        };
                        if mode == "stall-stop" {
                            progress("hosting", 1);
                            loop {
                                std::thread::sleep(std::time::Duration::from_secs(60));
                            }
                        }
                        if mode == "slow-stop" {
                            for remaining in (0..10).rev() {
                                progress("processes", remaining);
                                std::thread::sleep(std::time::Duration::from_millis(250));
                            }
                        }
                        let _ = std::fs::remove_file(runtime.join("host.json"));
                        std::thread::sleep(std::time::Duration::from_millis(200));
                        let _ = std::fs::write(home.join("host-clean-exit.txt"), format!("{}", std::process::id()));
                        println!("fake host shut down");
                        journal(&home, &format!("shutdown {}", std::process::id()));
                        std::process::exit(0);
                    }
                    _ => { let _ = writeln!(out, "{}", json!({"kind": "result", "id": id, "ok": false, "reason": "unknown", "code": "unsupported"})); }
                }
            }
        });
    }
}

/// A client that stays: attached to the launcher until it says `launcher.closeUi` (then a clean exit), or two minutes.
fn stay_attached(home: &std::path::Path) {
    let me = std::process::id();
    let runtime = home.join("runtime");
    let attach = || -> Option<(genie_launcher::local::LocalStream, BufReader<genie_launcher::local::LocalStream>)> {
        let rec: Value = serde_json::from_str(&std::fs::read_to_string(runtime.join("launcher.json")).ok()?).ok()?;
        let token = std::fs::read_to_string(runtime.join("launcher.token")).ok()?;
        let stream = genie_launcher::local::LocalStream::connect(rec["endpoint"].as_str()?, std::time::Duration::from_secs(5)).ok()?;
        let mut out = stream.try_clone().ok()?;
        let mut lines = BufReader::new(stream);
        writeln!(out, "{}", json!({"kind": "hello", "auth": {"kind": "token", "token": token.trim()}, "label": "fake client", "track": "client", "build": "2026.11.25-1", "schema": "2026.11.25", "minSchema": "2026.10.26", "capabilities": ["launcher@1"]})).ok()?;
        out.flush().ok()?;
        let mut line = String::new();
        lines.read_line(&mut line).ok()?;
        writeln!(out, "{}", json!({"kind": "call", "id": 1, "method": "launcher.attach", "args": [{"pid": me}]})).ok()?;
        out.flush().ok()?;
        Some((out, lines))
    };
    let t = std::time::Instant::now();
    if let Some((_out, lines)) = attach() {
        for line in lines.lines() {
            let Ok(line) = line else { break };
            let Ok(frame) = serde_json::from_str::<Value>(&line) else { continue };
            if frame["kind"] == "event" && frame["name"] == "launcher.updateReady" {
                let mut f = std::fs::OpenOptions::new().create(true).append(true).open(home.join(format!("client-update-ready-{me}.txt"))).unwrap();
                let _ = writeln!(f, "{frame}");
                continue;
            }
            if frame["kind"] == "event" && frame["name"] == "launcher.closeUi" {
                let _ = std::fs::write(home.join(format!("client-closed-{me}.txt")), "closeUi");
                println!("fake client {me}: the launcher closed the UI");
                std::process::exit(0);
            }
        }
    }
    // Not attached, or the launcher went: it stays up anyway, so a launcher that does not close it is seen.
    while t.elapsed() < std::time::Duration::from_secs(120) {
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
}

/// One line of `<GENIE_HOME>/journal.txt`.
fn journal(home: &std::path::Path, line: &str) {
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(home.join("journal.txt")).unwrap();
    writeln!(f, "{line}").unwrap();
}

/// One line of `<GENIE_HOME>/browser.txt`: what the launcher asked of the host's browser service.
fn browser_journal(home: &std::path::Path, line: &str) {
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(home.join("browser.txt")).unwrap();
    writeln!(f, "{line}").unwrap();
}

/// One line of `<GENIE_HOME>/toolchain.txt`: what the launcher asked of the host's tools (L7). Kept apart from the
/// lifecycle journal, whose exact order the L6 tests read.
fn tool_journal(home: &std::path::Path, line: &str) {
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(home.join("toolchain.txt")).unwrap();
    writeln!(f, "{line}").unwrap();
}

/// The pid of the last host that booted, by the journal.
fn last_boot(home: &std::path::Path) -> Option<u32> {
    let text = std::fs::read_to_string(home.join("journal.txt")).ok()?;
    text.lines().rev().find_map(|l| l.strip_prefix("boot ").and_then(|r| r.split_whitespace().next()).and_then(|p| p.parse().ok()))
}

/// state.json's host `current`, as the launcher pointed it (GENIE_CODE_ROOT, inherited from the launcher).
fn state_host_current() -> String {
    let Some(code) = std::env::var_os("GENIE_CODE_ROOT") else { return "-".to_string() };
    let path = std::path::Path::new(&code).join("state.json");
    let v: Value = std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    v["tracks"]["host"]["current"].as_str().unwrap_or("-").to_string()
}

/// One call to this user's launcher, as genie-host makes it: `ok`, or why not.
fn ask_launcher(home: &std::path::Path, method: &str, args: Value) -> String {
    let runtime = home.join("runtime");
    let run = || -> Option<String> {
        let rec: Value = serde_json::from_str(&std::fs::read_to_string(runtime.join("launcher.json")).ok()?).ok()?;
        let token = std::fs::read_to_string(runtime.join("launcher.token")).ok()?;
        let stream = genie_launcher::local::LocalStream::connect(rec["endpoint"].as_str()?, std::time::Duration::from_secs(5)).ok()?;
        let mut out = stream.try_clone().ok()?;
        let mut lines = BufReader::new(stream);
        let hello = json!({"kind": "hello", "auth": {"kind": "token", "token": token.trim()}, "label": "genie host", "track": "host",
            "build": "2026.11.25-1", "schema": "2026.11.25", "minSchema": "2026.10.26", "capabilities": ["launcher@1"]});
        writeln!(out, "{hello}").ok()?;
        out.flush().ok()?;
        let mut line = String::new();
        lines.read_line(&mut line).ok()?;
        writeln!(out, "{}", json!({"kind": "call", "id": 1, "method": method, "args": args})).ok()?;
        out.flush().ok()?;
        loop {
            let mut line = String::new();
            if lines.read_line(&mut line).ok()? == 0 {
                return None;
            }
            let v: Value = serde_json::from_str(&line).ok()?;
            if v["kind"] == "result" {
                return Some(if v["ok"] == true { "ok".to_string() } else { format!("refused: {}", v["reason"]) });
            }
        }
    };
    run().unwrap_or_else(|| "no-launcher".to_string())
}

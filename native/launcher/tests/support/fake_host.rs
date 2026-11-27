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
    let mode = std::env::var("FAKE_HOST_MODE").ok().or_else(|| std::fs::read_to_string(home.join("fake-host-mode.txt")).ok().map(|m| m.trim().to_string())).unwrap_or_default();
    if mode == "exit-at-boot" {
        std::process::exit(3);
    }
    let runtime = home.join("runtime");
    std::fs::create_dir_all(&runtime).unwrap();
    let endpoint = if cfg!(windows) { format!(r"\\.\pipe\genie-host-fake-{}", std::process::id()) } else { runtime.join("host.sock").display().to_string() };
    let listener = LocalListener::bind(&endpoint).expect("bind");
    let token = format!("t{}", std::process::id());
    std::fs::write(runtime.join("host.token"), &token).unwrap();
    let build = std::env::var("GENIE_HOST_BUILD").unwrap_or_default();
    let record = json!({"pid": std::process::id(), "endpoint": endpoint, "protocol": 4, "build": build, "startedAt": 1});
    std::fs::write(runtime.join("host.json.tmp"), record.to_string()).unwrap();
    std::fs::rename(runtime.join("host.json.tmp"), runtime.join("host.json")).unwrap();
    println!("fake host up on {endpoint}");
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

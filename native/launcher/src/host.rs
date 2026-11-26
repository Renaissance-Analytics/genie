//! STARTING AND STOPPING THE HOST. `ensure_host`: adopt a live host that answers a `hello` on the engine protocol the
//! launcher speaks, else start `host.current` from its verified folder, detached, inheriting only its log, and wait for
//! it to write `host.json` and answer. `stop_host`: the graceful stop (`engine.shutdown`), then wait for its pid.

use crate::layout::Roots;
use ed25519_dalek::VerifyingKey;
use serde_json::Value;
use std::time::Duration;

/// How long a new host has to write host.json and answer a hello (the spec's rollback bound, 60 s).
pub const HOST_READY: Duration = Duration::from_secs(60);
/// How long a host has to go after `engine.shutdown` (INSTALL_WAIT_MS's order).
pub const HOST_GONE: Duration = Duration::from_secs(120);

/// `<data root>/runtime/host.json`, as genie-host writes it (`src/core/engine-protocol.ts` `HostRecord`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostRecord {
    pub pid: u32,
    pub endpoint: String,
    pub protocol: u64,
    pub build: String,
}

use crate::folder::{verify_build, HashScope};
use crate::layout::{Track, HOST_ENTRY};
use crate::local::LocalStream;
use crate::spawn::{end, pid_alive, start_detached, wait_gone};
use crate::{state, ENGINE_PROTOCOL};
use serde_json::json;
use std::io::{BufRead, BufReader, Write};
use std::sync::mpsc;
use std::time::Instant;

/// What the launcher says in its hello to a host.
pub const LINK_LABEL: &str = "genie launcher";

pub fn parse_record(text: &str) -> Option<HostRecord> {
    let v: Value = serde_json::from_str(text).ok()?;
    let pid = u32::try_from(v.get("pid")?.as_u64()?).ok()?;
    let endpoint = v.get("endpoint")?.as_str()?.to_string();
    let protocol = v.get("protocol")?.as_u64()?;
    let build = v.get("build")?.as_str()?.to_string();
    v.get("startedAt")?.as_f64()?;
    Some(HostRecord { pid, endpoint, protocol, build })
}

pub fn read_record(roots: &Roots) -> Option<HostRecord> {
    parse_record(&std::fs::read_to_string(roots.runtime_dir().join("host.json")).ok()?)
}

fn read_token(roots: &Roots) -> Result<String, String> {
    std::fs::read_to_string(roots.runtime_dir().join("host.token")).map(|t| t.trim().to_string()).map_err(|_| "the host left no token".to_string())
}

/// One conversation with the host, bounded by `timeout`: hello, then each call in turn. The welcome, then each result.
fn converse(record: &HostRecord, token: &str, calls: &[(&str, Value)], timeout: Duration) -> Result<Vec<Value>, String> {
    let endpoint = record.endpoint.clone();
    let token = token.to_string();
    let calls: Vec<(String, Value)> = calls.iter().map(|(m, a)| (m.to_string(), a.clone())).collect();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let run = || -> Result<Vec<Value>, String> {
            let stream = LocalStream::connect(&endpoint, timeout).map_err(|e| format!("the host's endpoint did not answer ({e})"))?;
            let mut out = stream.try_clone().map_err(|e| e.to_string())?;
            let mut lines = BufReader::new(stream);
            let mut read = |what: &str| -> Result<Value, String> {
                let mut line = String::new();
                match lines.read_line(&mut line) {
                    Ok(0) => Err(format!("the host closed the link before {what}")),
                    Ok(_) => serde_json::from_str(&line).map_err(|_| format!("the host's {what} is not JSON")),
                    Err(e) => Err(format!("the host's link failed before {what} ({e})")),
                }
            };
            writeln!(out, "{}", json!({"kind": "hello", "auth": {"kind": "token", "token": token}, "label": LINK_LABEL})).map_err(|e| e.to_string())?;
            out.flush().map_err(|e| e.to_string())?;
            let welcome = read("its welcome")?;
            if welcome["kind"] != "welcome" {
                return Err(format!("the host refused the launcher: {}", welcome["reason"].as_str().unwrap_or("no reason given")));
            }
            let mut answers = vec![welcome];
            for (i, (method, args)) in calls.iter().enumerate() {
                let id = i as u64 + 1;
                writeln!(out, "{}", json!({"kind": "call", "id": id, "method": method, "args": args})).map_err(|e| e.to_string())?;
                out.flush().map_err(|e| e.to_string())?;
                loop {
                    let v = read(method)?;
                    if v["kind"] == "result" && v["id"] == id {
                        answers.push(v);
                        break;
                    }
                }
            }
            Ok(answers)
        };
        let _ = tx.send(run());
    });
    rx.recv_timeout(timeout).unwrap_or_else(|_| Err(format!("the host did not answer within {} s", timeout.as_secs())))
}

/// `hello` with the host's token; its `welcome`, or why not.
pub fn hello(record: &HostRecord, token: &str, timeout: Duration) -> Result<Value, String> {
    let mut answers = converse(record, token, &[], timeout)?;
    let welcome = answers.remove(0);
    if welcome["protocol"].as_u64() != Some(ENGINE_PROTOCOL) {
        return Err(format!("the host speaks engine protocol {}, this launcher {ENGINE_PROTOCOL}", welcome["protocol"]));
    }
    Ok(welcome)
}

fn host_log(roots: &Roots) -> std::path::PathBuf {
    roots.logs_dir().join("genie-host.log")
}

/// `{how: adopted|started, pid, build}`, or the person's words.
pub fn ensure_host(roots: &Roots, keys: &[VerifyingKey]) -> Result<Value, String> {
    if let Some(rec) = read_record(roots).filter(|r| pid_alive(r.pid)) {
        let token = read_token(roots)?;
        return match hello(&rec, &token, Duration::from_secs(10)) {
            Ok(_) => Ok(json!({"how": "adopted", "pid": rec.pid, "build": rec.build})),
            Err(why) => Err(format!("A host is running (pid {}) that does not answer this launcher: {why}.", rec.pid)),
        };
    }
    let st = state::read(&roots.state_file())?;
    let build = st.track(Track::Host.as_str()).and_then(|t| t.current.clone()).ok_or("No host is installed on this computer.")?;
    verify_build(roots, Track::Host, &build, keys, HashScope::Executables)?;
    let program = roots.host_program(&build).ok_or("the host's build is not a track build")?;
    let entry = HOST_ENTRY.split('/').fold(program.folder().to_path_buf(), |p, seg| p.join(seg));
    // What the window used to hand the host it started (main.ts): its home, its build, the launcher whose Windows modes
    // it uses (genie-launch.exe's, folded into the launcher: win-launcher.ts), and its OWN resources folder, where the
    // bundled Caddy is (the host package's resources/runtime). Never anything of the client's.
    let env = [
        ("ELECTRON_RUN_AS_NODE".to_string(), "1".to_string()),
        ("GENIE_HOME".to_string(), roots.data.display().to_string()),
        ("GENIE_HOST_BUILD".to_string(), build.clone()),
        ("GENIE_LAUNCHER_EXE".to_string(), crate::control::launcher_exe()?),
        ("GENIE_RESOURCES".to_string(), program.folder().join("resources").display().to_string()),
    ];
    let log = host_log(roots);
    let pid = start_detached(&program, &[entry.display().to_string()], &env, &log)?;
    let t = Instant::now();
    while t.elapsed() < HOST_READY {
        if !pid_alive(pid) {
            return Err(format!("The new host exited before it answered. The host's log: {}", log.display()));
        }
        if let Some(rec) = read_record(roots).filter(|r| r.pid == pid) {
            if let Ok(token) = read_token(roots) {
                if hello(&rec, &token, Duration::from_secs(5)).is_ok() {
                    return Ok(json!({"how": "started", "pid": pid, "build": build}));
                }
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    end(pid);
    Err(format!("The new host did not start within a minute, so it was ended. The host's log: {}", log.display()))
}

/// `{stopped: true, pid}` once the host has gone; `{stopped: false}` when none was running.
pub fn stop_host(roots: &Roots) -> Result<Value, String> {
    let Some(rec) = read_record(roots).filter(|r| pid_alive(r.pid)) else {
        return Ok(json!({"stopped": false}));
    };
    let token = read_token(roots)?;
    let answers = converse(&rec, &token, &[("engine.shutdown", json!([]))], Duration::from_secs(30))?;
    let result = &answers[1];
    if result["ok"] != true {
        return Err(format!("The host refused to stop: {}", result["reason"].as_str().unwrap_or("no reason given")));
    }
    if !wait_gone(rec.pid, HOST_GONE) {
        return Err(format!("The host (pid {}) did not stop within {} s.", rec.pid, HOST_GONE.as_secs()));
    }
    Ok(json!({"stopped": true, "pid": rec.pid}))
}

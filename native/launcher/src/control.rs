//! THE CONTROL WIRE. JSON lines, the engine protocol's frames (`hello` -> `welcome` | `refused`, `call` -> `result`), on
//! the named pipe `genie-launcher-<user SID>` (protected DACL: the user and SYSTEM) or `<data root>/runtime/launcher.sock`
//! (0600), with the token in `<data root>/runtime/launcher.token` (0600) and `launcher.json` `{pid, endpoint, build,
//! schema}` beside `host.json`. The hello carries an offer on track `launcher` and both sides `negotiate`.
//!
//! Methods (L2): `launcher.status`, `launcher.ensureHost`, `launcher.stopHost`, `launcher.openWindow {host}`,
//! `launcher.startBrowser`. `launcher.updates`, `.check`, `.apply` and `.channel` answer `unsupported` until the
//! launcher's updates exist. Each program is a component of the registry (`components`), run from its own track: the
//! window is the client's, the browser the browser's (L3). Every one is told where the launcher is (GENIE_LAUNCHER_EXE)
//! and the host build to link to (GENIE_LAUNCHER_HOST_BUILD): `src/core/launcher-link.ts` reads them.

use crate::components::{component, Component};
use crate::folder::{verify_build, HashScope};
use crate::layout::{Roots, Track};
use crate::local::{LocalListener, LocalStream};
use crate::negotiate::{launcher_offer, negotiate, offer_of, Negotiation};
use crate::spawn::{pid_alive, start_window};
use crate::{host, keys, state, LAUNCHER_BUILD, LAUNCHER_SCHEMA};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};

pub const METHODS: [&str; 9] = [
    "launcher.status",
    "launcher.ensureHost",
    "launcher.stopHost",
    "launcher.openWindow",
    "launcher.startBrowser",
    "launcher.updates",
    "launcher.check",
    "launcher.apply",
    "launcher.channel",
];

/// The longest line read from a client: a frame of this wire is small.
const MAX_LINE: usize = 1 << 20;

pub struct Context {
    pub roots: Roots,
    pub token: String,
    /// One host or client operation at a time: two ensureHost calls never start two hosts.
    pub busy: Mutex<()>,
}

#[derive(Debug, Default)]
pub struct Connection {
    pub welcomed: bool,
    /// Set when the connection must close after these frames are sent.
    pub closing: bool,
}

fn same_token(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() || a.is_empty() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn refused(conn: &mut Connection, reason: &str, code: Option<&str>) -> Vec<Value> {
    conn.closing = true;
    let mut v = json!({"kind": "refused", "reason": reason});
    if let Some(c) = code {
        v["code"] = Value::String(c.to_string());
    }
    vec![v]
}

fn result(id: &Value, answer: Result<Value, String>) -> Value {
    match answer {
        Ok(value) => json!({"kind": "result", "id": id, "ok": true, "value": value}),
        Err(reason) => json!({"kind": "result", "id": id, "ok": false, "reason": reason}),
    }
}

fn unsupported(id: &Value, method: &str) -> Value {
    json!({"kind": "result", "id": id, "ok": false, "reason": format!("{method} is not something this launcher does"), "code": "unsupported"})
}

/// This launcher's own program, as its programs are told it (GENIE_LAUNCHER_EXE): their way to its Windows modes.
pub fn launcher_exe() -> Result<String, String> {
    std::env::current_exe().map(|p| p.display().to_string()).map_err(|e| format!("this launcher's own path could not be read: {e}"))
}

/// The host build a client links to: the running host's, else the installed current one.
fn host_build_for_clients(roots: &Roots, st: &state::State) -> Option<String> {
    match host::read_record(roots).filter(|r| pid_alive(r.pid)) {
        Some(r) => Some(r.build),
        None => st.track(Track::Host.as_str()).and_then(|t| t.current.clone()),
    }
}

/// A window component's current build, verified, started with its own arguments and then `extra`.
pub fn start_component(roots: &Roots, c: &Component, extra: Vec<String>) -> Result<Value, String> {
    let st = state::read(&roots.state_file())?;
    let name = c.track.as_str();
    let build = st.track(name).and_then(|t| t.current.clone()).ok_or_else(|| format!("No {name} is installed on this computer."))?;
    let keys = keys::trusted_keys(roots);
    let manifest = verify_build(roots, c.track, &build, &keys, HashScope::Executables)?;
    let program = match c.runs {
        None => roots.program(c.track, &build).ok_or_else(|| format!("the {name}'s build is not a track build"))?,
        // It runs another track's program at the build its own manifest names (the browser on the client).
        Some(on) => {
            let at = manifest.with_client.clone().ok_or_else(|| format!("the {name} {build} names no {} build to run on", on.as_str()))?;
            verify_build(roots, on, &at, &keys, HashScope::Executables).map_err(|why| format!("the {name} runs on {} {at}, which is not here to run: {why}", on.as_str()))?;
            roots.program(on, &at).ok_or_else(|| format!("{} {at} is not a track build", on.as_str()))?
        }
    };
    let mut args: Vec<String> = c.args.iter().map(|a| a.to_string()).collect();
    args.extend(extra);
    let mut env = vec![
        ("GENIE_HOME".to_string(), roots.data.display().to_string()),
        ("GENIE_LAUNCHER_EXE".to_string(), launcher_exe()?),
    ];
    if let Some(h) = host_build_for_clients(roots, &st) {
        env.push(("GENIE_LAUNCHER_HOST_BUILD".to_string(), h));
    }
    let pid = start_window(&program, &args, &env, &roots.logs_dir().join(format!("genie-{}.log", c.id)))?;
    Ok(json!({"pid": pid, "build": build, "component": c.id}))
}

fn start_client(roots: &Roots, args: Vec<String>) -> Result<Value, String> {
    start_component(roots, component("client").ok_or("no client component")?, args)
}

/// The frames that answer one line.
pub fn handle_line(ctx: &Context, conn: &mut Connection, line: &str) -> Vec<Value> {
    let Ok(frame) = serde_json::from_str::<Value>(line) else {
        return if conn.welcomed { Vec::new() } else { refused(conn, "not JSON", None) };
    };
    if !conn.welcomed {
        if frame["kind"] != "hello" {
            return refused(conn, "say hello first", None);
        }
        let token = frame["auth"]["token"].as_str().unwrap_or("");
        if frame["auth"]["kind"] != "token" || !same_token(token, &ctx.token) {
            return refused(conn, "this launcher answers only its own user's programs (wrong token)", None);
        }
        let mine = launcher_offer();
        return match negotiate(&mine, &offer_of(&frame)) {
            Negotiation::Refused { reason, .. } => refused(conn, &reason, Some("version")),
            Negotiation::Agreed { schema, capabilities } => {
                conn.welcomed = true;
                vec![json!({
                    "kind": "welcome",
                    "connectionId": format!("launcher-{}", std::process::id()),
                    "host": "local",
                    "isOwner": true,
                    "track": "launcher",
                    "build": LAUNCHER_BUILD,
                    "schema": LAUNCHER_SCHEMA,
                    "minSchema": mine.min_schema,
                    "capabilities": mine.capabilities,
                    "pid": std::process::id(),
                    "negotiated": {"schema": schema, "capabilities": capabilities},
                })]
            }
        };
    }
    if frame["kind"] != "call" || !frame["id"].is_number() {
        return Vec::new();
    }
    let id = frame["id"].clone();
    let method = frame["method"].as_str().unwrap_or("");
    let args = frame["args"].as_array().cloned().unwrap_or_default();
    let roots = &ctx.roots;
    let busy = move || ctx.busy.lock().unwrap_or_else(|p| p.into_inner());
    let answer = match method {
        "launcher.status" => Ok(status(roots)),
        "launcher.ensureHost" => {
            let _g = busy();
            host::ensure_host(roots, &keys::trusted_keys(roots))
        }
        "launcher.stopHost" => {
            let _g = busy();
            host::stop_host(roots)
        }
        "launcher.openWindow" => {
            let _g = busy();
            let wanted = args.first().and_then(|a| a["host"].as_str()).map(str::to_string);
            start_client(roots, match wanted {
                Some(h) => vec!["--host".to_string(), h],
                None => vec!["--open-window".to_string()],
            })
        }
        "launcher.startBrowser" => {
            let _g = busy();
            component("browser").ok_or_else(|| "no browser component".to_string()).and_then(|c| start_component(roots, c, Vec::new()))
        }
        other => return vec![unsupported(&id, other)],
    };
    vec![result(&id, answer)]
}

/// This user's endpoint.
pub fn endpoint(roots: &Roots) -> Result<String, String> {
    #[cfg(windows)]
    {
        let _ = roots;
        Ok(format!(r"\\.\pipe\genie-launcher-{}", crate::win::current_user_sid()?))
    }
    #[cfg(unix)]
    {
        Ok(roots.runtime_dir().join("launcher.sock").display().to_string())
    }
}

fn private_dir(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("{} could not be made: {e}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Written whole (a temporary file renamed over it) and, on Linux, 0600 from its first byte.
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let written = options.open(&tmp).and_then(|mut f| f.write_all(bytes)).and_then(|_| std::fs::rename(&tmp, path));
    written.map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("{} could not be written: {e}", path.display())
    })
}

fn already_running(roots: &Roots) -> String {
    let pid = std::fs::read_to_string(roots.runtime_dir().join("launcher.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v["pid"].as_u64());
    match pid {
        Some(p) => format!("Genie's launcher is already running for this user (pid {p})."),
        None => "Genie's launcher is already running for this user.".to_string(),
    }
}

/// One per user on Linux: an exclusive lock on `<runtime>/launcher.lock`, held while the process lives.
#[cfg(unix)]
fn single_instance(roots: &Roots) -> Result<std::fs::File, String> {
    use std::os::unix::fs::OpenOptionsExt;
    use std::os::unix::io::AsRawFd;
    let path = roots.runtime_dir().join("launcher.lock");
    let f = std::fs::OpenOptions::new().write(true).create(true).truncate(false).mode(0o600).open(&path).map_err(|e| format!("{} could not be opened: {e}", path.display()))?;
    if unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(already_running(roots));
    }
    Ok(f)
}

fn new_token() -> Result<String, String> {
    let mut b = [0u8; 32];
    getrandom::getrandom(&mut b).map_err(|e| format!("no random bytes for the token: {e}"))?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

fn serve_connection(ctx: &Context, stream: LocalStream) {
    let Ok(mut out) = stream.try_clone() else { return };
    let mut reader = BufReader::new(stream);
    let mut conn = Connection::default();
    loop {
        let mut line = String::new();
        match (&mut reader).take(MAX_LINE as u64).read_line(&mut line) {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        if !line.ends_with('\n') && line.len() >= MAX_LINE {
            return; // a line longer than any frame: not a client of this wire
        }
        if line.trim().is_empty() {
            continue;
        }
        for frame in handle_line(ctx, &mut conn, line.trim_end()) {
            if writeln!(out, "{frame}").is_err() {
                return;
            }
        }
        let _ = out.flush();
        if conn.closing {
            return;
        }
    }
}

/// Run the launcher: one per user (a second answers that one is running), the token and `launcher.json` written,
/// connections served until the process ends.
pub fn serve(roots: Roots) -> Result<(), String> {
    serve_then(roots, |_| {})
}

/// The same, with `ready` run on its own thread once the wire answers (what `genie` alone does: open Genie).
pub fn serve_then(roots: Roots, ready: impl FnOnce(&Roots) + Send + 'static) -> Result<(), String> {
    let runtime = roots.runtime_dir();
    private_dir(&runtime)?;
    #[cfg(unix)]
    let _lock = single_instance(&roots)?;
    crate::folder::sweep(&roots);
    let endpoint = endpoint(&roots)?;
    let listener = LocalListener::bind(&endpoint).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists { already_running(&roots) } else { format!("the launcher's endpoint {endpoint} could not be made: {e}") }
    })?;
    let token = new_token()?;
    write_private(&runtime.join("launcher.token"), token.as_bytes())?;
    let record = json!({"pid": std::process::id(), "endpoint": endpoint, "build": LAUNCHER_BUILD, "schema": LAUNCHER_SCHEMA});
    write_private(&runtime.join("launcher.json"), record.to_string().as_bytes())?;
    let ctx = Arc::new(Context { roots, token, busy: Mutex::new(()) });
    {
        let ctx = Arc::clone(&ctx);
        std::thread::spawn(move || {
            let _g = ctx.busy.lock().unwrap_or_else(|p| p.into_inner());
            ready(&ctx.roots);
        });
    }
    loop {
        match listener.accept() {
            Ok(stream) => {
                let ctx = Arc::clone(&ctx);
                std::thread::spawn(move || serve_connection(&ctx, stream));
            }
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(50)),
        }
    }
}

/// What is installed and running (`genie status --json`, `launcher.status`): the build, the roots, the profile, each
/// track's pointers and whether its current folder verifies, the host and the launcher.
pub fn status(roots: &Roots) -> Value {
    let keys = keys::trusted_keys(roots);
    let st = state::read(&roots.state_file());
    let mut tracks = serde_json::Map::new();
    let mut profile = Value::Null;
    match &st {
        Ok(s) => {
            profile = s.profile.clone().map(Value::String).unwrap_or(Value::Null);
            for track in Track::ALL {
                let Some(t) = s.track(track.as_str()) else { continue };
                let check = t.current.as_deref().map(|b| verify_build(roots, track, b, &keys, HashScope::Executables));
                let mut v = json!({"current": t.current, "previous": t.previous, "channel": t.channel, "verified": matches!(check, Some(Ok(_)))});
                if let Some(Err(why)) = check {
                    v["why"] = Value::String(why);
                }
                tracks.insert(track.as_str().to_string(), v);
            }
        }
        Err(why) => {
            tracks.insert("error".to_string(), Value::String(why.clone()));
        }
    }
    let host = match host::read_record(roots) {
        Some(r) if pid_alive(r.pid) => json!({"running": true, "pid": r.pid, "build": r.build}),
        _ => json!({"running": false}),
    };
    let launcher = std::fs::read_to_string(roots.runtime_dir().join("launcher.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v["pid"].as_u64())
        .map(|pid| json!({"running": pid_alive(pid as u32), "pid": pid}))
        .unwrap_or_else(|| json!({"running": false}));
    json!({
        "build": LAUNCHER_BUILD,
        "schema": LAUNCHER_SCHEMA,
        "codeRoot": roots.code.display().to_string(),
        "dataRoot": roots.data.display().to_string(),
        "profile": profile,
        "tracks": tracks,
        "host": host,
        "launcher": launcher,
    })
}

/// One call to the launcher already running for this user (a second `genie`, a shortcut clicked again): its answer, or
/// why there is none. `Ok(None)` when no launcher is running.
pub fn call_running(roots: &Roots, method: &str, args: Value) -> Result<Option<Value>, String> {
    let runtime = roots.runtime_dir();
    let Some(record) = std::fs::read_to_string(runtime.join("launcher.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else {
        return Ok(None);
    };
    match record["pid"].as_u64() {
        Some(pid) if pid_alive(pid as u32) && pid as u32 != std::process::id() => {}
        _ => return Ok(None),
    }
    let endpoint = record["endpoint"].as_str().ok_or("launcher.json names no endpoint")?.to_string();
    let token = std::fs::read_to_string(runtime.join("launcher.token")).map_err(|_| "the running launcher left no token".to_string())?;
    let stream = match LocalStream::connect(&endpoint, std::time::Duration::from_secs(5)) {
        Ok(s) => s,
        Err(_) => return Ok(None),
    };
    let mut out = stream.try_clone().map_err(|e| e.to_string())?;
    let mut lines = BufReader::new(stream);
    let mine = launcher_offer();
    let hello = json!({"kind": "hello", "auth": {"kind": "token", "token": token.trim()}, "label": "genie", "track": "launcher",
        "build": LAUNCHER_BUILD, "schema": LAUNCHER_SCHEMA, "minSchema": mine.min_schema, "capabilities": mine.capabilities});
    let mut read = || -> Result<Value, String> {
        let mut line = String::new();
        match lines.read_line(&mut line) {
            Ok(0) | Err(_) => Err("the running launcher closed the link".to_string()),
            Ok(_) => serde_json::from_str(&line).map_err(|_| "the running launcher's answer is not JSON".to_string()),
        }
    };
    writeln!(out, "{hello}").and_then(|_| out.flush()).map_err(|e| e.to_string())?;
    let welcome = read()?;
    if welcome["kind"] != "welcome" {
        return Err(format!("the running launcher refused: {}", welcome["reason"].as_str().unwrap_or("no reason given")));
    }
    writeln!(out, "{}", json!({"kind": "call", "id": 1, "method": method, "args": args})).and_then(|_| out.flush()).map_err(|e| e.to_string())?;
    loop {
        let v = read()?;
        if v["kind"] == "result" && v["id"] == 1 {
            return if v["ok"] == true { Ok(Some(v["value"].clone())) } else { Err(v["reason"].as_str().unwrap_or("it failed").to_string()) };
        }
    }
}

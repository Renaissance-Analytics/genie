//! THE CONTROL WIRE. JSON lines, the engine protocol's frames (`hello` -> `welcome` | `refused`, `call` -> `result`), on
//! the named pipe `genie-launcher-<user SID>` (protected DACL: the user and SYSTEM) or `<data root>/runtime/launcher.sock`
//! (0600), with the token in `<data root>/runtime/launcher.token` (0600) and `launcher.json` `{pid, endpoint, build,
//! schema}` beside `host.json`. The hello carries an offer on track `launcher` and both sides `negotiate`.
//!
//! Methods (L2): `launcher.status`, `launcher.ensureHost`, `launcher.stopHost`, `launcher.openWindow {host}`,
//! `launcher.startBrowser`. L5 (the tray, logon and quit): `launcher.attach {pid}` (a client holds its link open and is
//! told `{kind: event, name: launcher.closeUi}` on it), `launcher.closeUi` ("Just close the UI": every client closes, the
//! host and the launcher keep running, the host is marked left running), `launcher.shutDown` ("Shut down everything":
//! answered at once, then the clients closed, the host's graceful stop waited for on its own progress, and the launcher
//! exits), `launcher.logon {setting, startMinimized}` (the client's two settings; the launcher writes the entry). L6 (updates,
//! `updates`): `launcher.check` (the feed read, every newer build made ready), `launcher.updates` (what is ready, the host
//! update in flight), `launcher.apply {track}` (a client or browser pointed at, open windows told `launcher.updateReady`;
//! the host asked to install through its own drain, and `{track: host, afterPid}` from the host that drained; the launcher
//! itself handed over, `self_update`), `launcher.channel {channel}`. Each program is a component of the registry (`components`), run from its own track: the
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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub const METHODS: [&str; 14] = [
    "launcher.status",
    "launcher.restart",
    "launcher.attach",
    "launcher.closeUi",
    "launcher.shutDown",
    "launcher.logon",
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
    /// The clients holding their link open (`launcher.attach`): told when their UI is to close.
    pub clients: Mutex<Vec<Attached>>,
    /// L6: what the launcher knows of its updates.
    pub updates: Arc<crate::updates::Shared>,
    /// This user's endpoint, as bound.
    pub endpoint: String,
    /// The one-per-user lock (Linux), let go when a new launcher takes over.
    pub lock: Mutex<Option<std::fs::File>>,
    /// Set while this launcher hands its endpoint to a new one: the accept loop lets go of the listener.
    pub handing_over: AtomicBool,
    /// The accept loop is running (it clears this as it lets go).
    pub accepting: AtomicBool,
}

impl Context {
    pub fn new(roots: Roots, token: String) -> Context {
        Context {
            roots,
            token,
            busy: Mutex::new(()),
            clients: Mutex::new(Vec::new()),
            updates: Arc::new(crate::updates::Shared::default()),
            endpoint: String::new(),
            lock: Mutex::new(None),
            handing_over: AtomicBool::new(false),
            accepting: AtomicBool::new(false),
        }
    }
}

/// A client's open link: its pid and the write half of its connection.
pub struct Attached {
    pub pid: u32,
    pub out: LocalStream,
}

#[derive(Debug, Default)]
pub struct Connection {
    pub welcomed: bool,
    /// Set when the connection must close after these frames are sent.
    pub closing: bool,
    /// `launcher.attach`: this connection is now that client's, kept for the launcher's events.
    pub attach: Option<u32>,
    /// `launcher.shutDown` was answered: once the answer is sent, everything shuts down.
    pub shut_down: bool,
    /// `launcher.restart` was answered: once the answer is sent, Genie restarts.
    pub restart: bool,
    /// `launcher.trayAct` (the VM rows' probe): the tray's item, run once the answer is sent.
    pub tray_act: Option<crate::tray::Action>,
    /// L6: what every attached client is told once the answer is sent (an update ready).
    pub tell_clients: Option<Value>,
    /// L6: the host that drained said it is going (`launcher.apply {track: host, afterPid}`): the swap, once answered.
    pub host_swap: Option<u32>,
    /// L6: the launcher's own update, once answered: the build to hand over to.
    pub self_update: Option<String>,
}

/// The event every attached client closes its UI on.
pub const CLOSE_UI_EVENT: &str = "launcher.closeUi";
/// How long the clients have to close after they are told, before the launcher ends them.
pub const CLIENTS_CLOSE: std::time::Duration = std::time::Duration::from_secs(15);

/// The attached clients still running.
pub fn attached_pids(ctx: &Context) -> Vec<u32> {
    let mut clients = ctx.clients.lock().unwrap_or_else(|p| p.into_inner());
    clients.retain(|c| pid_alive(c.pid));
    clients.iter().map(|c| c.pid).collect()
}

/// Every attached client told to close its UI, and waited for; one that has not gone after CLIENTS_CLOSE is ended.
/// The pids that were told.
pub fn close_clients(ctx: &Context) -> Vec<u32> {
    let mut told = Vec::new();
    {
        let mut clients = ctx.clients.lock().unwrap_or_else(|p| p.into_inner());
        for c in clients.iter_mut() {
            if pid_alive(c.pid) && writeln!(c.out, "{}", json!({"kind": "event", "name": CLOSE_UI_EVENT})).and_then(|_| c.out.flush()).is_ok() {
                told.push(c.pid);
            }
        }
        clients.clear();
    }
    for &pid in &told {
        if !crate::spawn::wait_gone(pid, CLIENTS_CLOSE) {
            eprintln!("genie: a client window (pid {pid}) did not close within {} s, so it was ended", CLIENTS_CLOSE.as_secs());
            crate::spawn::end(pid);
        }
    }
    told
}

/// "Just close the UI": the host, when it runs, is marked left running (it comes back at logon), and every client closes.
pub fn close_ui(ctx: &Context) -> Result<Value, String> {
    let host_running = host::read_record(&ctx.roots).map(|r| pid_alive(r.pid)).unwrap_or(false);
    if host_running {
        crate::logon::set_left_running(&ctx.roots, true)?;
        crate::logon::apply_here(&ctx.roots);
    }
    let closed = close_clients(ctx);
    Ok(json!({"closed": closed, "hostRunning": host_running}))
}

/// "Shut down everything": nothing left running (the mark cleared, the entry as the setting says), every client closed,
/// the host's graceful stop waited for on its own progress (Tynn #1079), then this launcher exits. Never returns.
pub fn shut_down(ctx: &Context) -> ! {
    let _g = ctx.busy.lock().unwrap_or_else(|p| p.into_inner());
    if let Err(why) = crate::logon::set_left_running(&ctx.roots, false) {
        eprintln!("genie: {why}");
    }
    crate::logon::apply_here(&ctx.roots);
    close_clients(ctx);
    match host::stop_host(&ctx.roots) {
        Ok(v) => eprintln!("genie: shut down everything: the host stopped ({v})"),
        Err(why) => eprintln!("genie: shut down everything: {why}"),
    }
    exit_launcher(&ctx.roots, 0)
}

/// RESTART (the client's Restart, a site panel's): every client closed, the host's graceful stop, the host started again
/// and a window opened. The launcher and its tray stay.
pub fn restart(ctx: &Context) {
    let _g = ctx.busy.lock().unwrap_or_else(|p| p.into_inner());
    close_clients(ctx);
    if let Err(why) = host::stop_host(&ctx.roots) {
        eprintln!("genie: restart: {why}");
    }
    if let Err(why) = host::ensure_host(&ctx.roots, &keys::trusted_keys(&ctx.roots)) {
        eprintln!("genie: restart: {why}");
    }
    opened(&ctx.roots);
    if let Err(why) = start_client(&ctx.roots, vec!["--open-window".to_string()]) {
        eprintln!("genie: restart: {why}");
    }
}

/// This launcher ends: its record removed (only its own), its tray taken away, then the process.
pub fn exit_launcher(roots: &Roots, code: i32) -> ! {
    let file = roots.runtime_dir().join("launcher.json");
    let mine = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v["pid"].as_u64()) == Some(std::process::id() as u64);
    if mine {
        let _ = std::fs::remove_file(&file);
        let _ = std::fs::remove_file(roots.runtime_dir().join("launcher.token"));
    }
    crate::tray::remove();
    std::process::exit(code)
}

/// The person opened Genie: the host is no longer "left running" with the UI closed (P6).
pub fn opened(roots: &Roots) {
    if crate::logon::left_running(roots) {
        if let Err(why) = crate::logon::set_left_running(roots, false) {
            eprintln!("genie: {why}");
        }
        crate::logon::apply_here(roots);
    }
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
    let mut program_build = build.clone();
    let program = match c.runs {
        None => roots.program(c.track, &build).ok_or_else(|| format!("the {name}'s build is not a track build"))?,
        // It runs another track's program at the build its own manifest names (the browser on the client).
        Some(on) => {
            let at = manifest.with_client.clone().ok_or_else(|| format!("the {name} {build} names no {} build to run on", on.as_str()))?;
            verify_build(roots, on, &at, &keys, HashScope::Executables).map_err(|why| format!("the {name} runs on {} {at}, which is not here to run: {why}", on.as_str()))?;
            program_build = at.clone();
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
    Ok(json!({"pid": pid, "build": build, "component": c.id, "program": program_build}))
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
        "launcher.status" => {
            let mut v = status(roots);
            v["clients"] = json!(attached_pids(ctx));
            Ok(v)
        }
        "launcher.attach" => {
            let Some(pid) = args.first().and_then(|a| a["pid"].as_u64()).and_then(|p| u32::try_from(p).ok()) else {
                return vec![result(&id, Err("launcher.attach needs {pid}".to_string()))];
            };
            conn.attach = Some(pid);
            ctx.updates.attaches.fetch_add(1, Ordering::SeqCst);
            Ok(json!({"attached": true, "pid": pid}))
        }
        "launcher.closeUi" => close_ui(ctx),
        // What the tray offers now, as words, and (GENIE_LAUNCHER_TRAY_PROBE=1, a VM row's screenshot) the menu shown as a
        // click on the icon shows it. Never in a person's launcher: the probe's variable is the row's.
        "launcher.trayAct" if crate::tray::probe_enabled() => match args.first().and_then(|a| a["action"].as_str()).and_then(crate::tray::Action::parse) {
            Some(action) => {
                conn.tray_act = Some(action);
                Ok(json!({"acting": format!("{action:?}")}))
            }
            None => Err("launcher.trayAct needs {action}".to_string()),
        },
        "launcher.trayMenu" if crate::tray::probe_enabled() => {
            let v = crate::tray::view(ctx);
            Ok(json!({"items": crate::tray::menu_text(&crate::tray::menu(&v)), "tooltip": crate::tray::tooltip(&v), "shown": crate::tray::show_menu()}))
        }
        "launcher.shutDown" => {
            conn.shut_down = true;
            Ok(json!({"accepted": true}))
        }
        "launcher.restart" => {
            conn.restart = true;
            Ok(json!({"accepted": true}))
        }
        "launcher.logon" => {
            let a = args.first().cloned().unwrap_or(Value::Null);
            match (a["setting"].as_bool(), a["startMinimized"].as_bool()) {
                (Some(setting), Some(start_minimized)) => crate::logon::write_settings(roots, crate::logon::LogonSettings { setting, start_minimized })
                    .and_then(|_| crate::logon::entry_exe())
                    .and_then(|exe| crate::logon::apply(roots, &crate::logon::place(), &exe))
                    .map(|said| json!({"said": said})),
                _ => Err("launcher.logon needs {setting, startMinimized}".to_string()),
            }
        }
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
            opened(roots);
            let wanted = args.first().and_then(|a| a["host"].as_str()).map(str::to_string);
            let started = start_client(roots, match wanted {
                Some(h) => vec!["--host".to_string(), h],
                None => vec!["--open-window".to_string()],
            });
            if let Ok(v) = &started {
                started_window(ctx, v);
            }
            started
        }
        "launcher.startBrowser" => {
            let _g = busy();
            let started = component("browser").ok_or_else(|| "no browser component".to_string()).and_then(|c| start_component(roots, c, Vec::new()));
            if let Ok(v) = &started {
                started_window(ctx, v);
            }
            started
        }
        "launcher.updates" => Ok(crate::updates::view(&ctx.updates, roots)),
        // A client window's "Updates (N)" (L6): the launcher's Updates window, opened once this answer is sent.
        "launcher.openUpdates" => {
            conn.tray_act = Some(crate::tray::Action::Updates);
            Ok(json!({"opening": true}))
        }
        "launcher.check" => crate::updates::check_now(&ctx.updates, roots),
        "launcher.channel" => crate::updates::set_channel(roots, args.first().unwrap_or(&Value::Null)),
        "launcher.apply" => apply(ctx, conn, args.first().cloned().unwrap_or(Value::Null)),
        other => return vec![unsupported(&id, other)],
    };
    vec![result(&id, answer)]
}

/// A window component this launcher started: kept for retention, and a client on trial watched as it comes up.
fn started_window(ctx: &Context, v: &Value) {
    let (Some(pid), Some(build)) = (v["pid"].as_u64().and_then(|p| u32::try_from(p).ok()), v["program"].as_str()) else { return };
    ctx.updates.started(pid, Track::Client, build);
    let on_trial = state::read(&ctx.roots.state_file())
        .ok()
        .and_then(|st| st.track(Track::Client.as_str()).map(|t| t.trial && t.current.as_deref() == Some(build)))
        .unwrap_or(false);
    if on_trial {
        let shared = Arc::clone(&ctx.updates);
        let roots = ctx.roots.clone();
        let build = build.to_string();
        std::thread::spawn(move || crate::updates::watch_client(shared, roots, pid, build));
    }
}

/// `launcher.apply {track}`: what is ready on that track, applied as its kind is (`updates`).
fn apply(ctx: &Context, conn: &mut Connection, a: Value) -> Result<Value, String> {
    let roots = &ctx.roots;
    let track = match a["track"].as_str() {
        None => return Err("launcher.apply needs {track}".to_string()),
        Some(t) => Track::parse(t).ok_or_else(|| format!("there is no track '{t}'"))?,
    };
    match track {
        Track::Client | Track::Browser => {
            let _g = ctx.busy.lock().unwrap_or_else(|p| p.into_inner());
            let (build, told) = crate::updates::apply_window(&ctx.updates, roots, track)?;
            conn.tell_clients = Some(told);
            Ok(json!({"track": track.as_str(), "build": build, "windowsKept": attached_pids(ctx)}))
        }
        Track::Host => match a["afterPid"].as_u64().and_then(|p| u32::try_from(p).ok()) {
            // The host that drained, going: the swap runs once this answer is sent.
            Some(pid) => {
                // An install a window asked of the host itself: its windows are still attached as the host goes.
                ctx.updates.windows_at_update.fetch_max(attached_pids(ctx).len(), Ordering::SeqCst);
                conn.host_swap = Some(pid);
                Ok(json!({"accepted": true}))
            }
            None => {
                let windows = attached_pids(ctx).len();
                let _g = ctx.busy.lock().unwrap_or_else(|p| p.into_inner());
                crate::updates::ask_host(&ctx.updates, roots, windows)
            }
        },
        Track::Launcher => {
            let keys = keys::trusted_keys(roots);
            let st = state::read(&roots.state_file())?;
            let current = st.track(Track::Launcher.as_str()).and_then(|t| t.current.clone());
            let (build, _) = crate::updates::ready_build(roots, &keys, Track::Launcher, current.as_deref()).ok_or("There is no launcher update ready to apply.")?;
            conn.self_update = Some(build.clone());
            Ok(json!({"handingOver": true, "build": build}))
        }
    }
}

/// An update applied from the launcher's own windows (the Updates window, the tray): as `launcher.apply` does it, with
/// no connection to answer first. The launcher's own update hands over here, and returns only when it was kept.
pub fn apply_track(ctx: &Arc<Context>, track: Track) -> Result<Value, String> {
    let mut conn = Connection::default();
    let answer = apply(ctx, &mut conn, json!({"track": track.as_str()}))?;
    if let Some(event) = conn.tell_clients.take() {
        tell_clients(ctx, &event);
    }
    if let Some(build) = conn.self_update.take() {
        self_update(ctx, &build);
    }
    Ok(answer)
}

/// Genie opened in a new window (`launcher.openWindow` with no host named): the Updates window's Open Genie.
pub fn open_window(ctx: &Context) -> Result<Value, String> {
    let _g = ctx.busy.lock().unwrap_or_else(|p| p.into_inner());
    opened(&ctx.roots);
    let v = start_client(&ctx.roots, vec!["--open-window".to_string()])?;
    started_window(ctx, &v);
    Ok(v)
}

/// Every attached client told `event` (their links are kept).
pub fn tell_clients(ctx: &Context, event: &Value) {
    let mut clients = ctx.clients.lock().unwrap_or_else(|p| p.into_inner());
    clients.retain(|c| pid_alive(c.pid));
    for c in clients.iter_mut() {
        let _ = writeln!(c.out, "{event}").and_then(|_| c.out.flush());
    }
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

fn serve_connection(ctx: &Arc<Context>, stream: LocalStream) {
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
        if conn.shut_down {
            shut_down(ctx);
        }
        if conn.restart {
            conn.restart = false;
            restart(ctx);
        }
        if let Some(action) = conn.tray_act.take() {
            crate::tray::act(Arc::clone(ctx), action);
        }
        if let Some(event) = conn.tell_clients.take() {
            tell_clients(ctx, &event);
        }
        if let Some(pid) = conn.host_swap.take() {
            let ctx = Arc::clone(ctx);
            std::thread::spawn(move || {
                let told = {
                    let _g = ctx.busy.lock().unwrap_or_else(|p| p.into_inner());
                    crate::updates::swap_host(&ctx.updates, &ctx.roots, pid)
                };
                if let Some(event) = told {
                    tell_clients(&ctx, &event);
                }
                // "Drain and swap the host, then refresh the UI" (the owner): the windows left when the host installed, so
                // Genie is opened again, on the client the host came with (or the one it went back to).
                if ctx.updates.windows_at_update.swap(0, Ordering::SeqCst) > 0 && attached_pids(&ctx).is_empty() {
                    match open_window(&ctx) {
                        Ok(v) => eprintln!("genie: Genie opened again after the host's update ({v})"),
                        Err(why) => eprintln!("genie: Genie could not be opened again after the host's update: {why}"),
                    }
                }
            });
        }
        if let Some(build) = conn.self_update.take() {
            self_update(ctx, &build);
        }
        // An attached client's link is kept for the launcher's events and no longer read: on Windows a pipe handle opened
        // for synchronous I/O serializes its reads and writes, so a read waiting here would hold every event back.
        if let Some(pid) = conn.attach.take() {
            ctx.clients.lock().unwrap_or_else(|p| p.into_inner()).push(Attached { pid, out });
            return;
        }
        if conn.closing {
            return;
        }
    }
}

/// Run the launcher: one per user (a second answers that one is running), the token and `launcher.json` written,
/// connections served until the process ends.
pub fn serve(roots: Roots) -> Result<(), String> {
    serve_then(roots, None, |_| {})
}

/// How long a new launcher has to take the endpoint (the spec: 30 s; GENIE_LAUNCHER_HANDOVER_MS for a test).
pub fn handover_bound() -> std::time::Duration {
    std::env::var("GENIE_LAUNCHER_HANDOVER_MS").ok().and_then(|v| v.parse::<u64>().ok()).filter(|ms| *ms > 0).map(std::time::Duration::from_millis).unwrap_or(std::time::Duration::from_secs(30))
}

/// Retried until it answers or `bound` has passed.
fn retry<T>(bound: std::time::Duration, mut f: impl FnMut() -> Result<T, String>) -> Result<T, String> {
    let t = std::time::Instant::now();
    loop {
        match f() {
            Ok(v) => return Ok(v),
            Err(why) if t.elapsed() >= bound => return Err(why),
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(100)),
        }
    }
}

/// The same, with `ready` run on its own thread once the wire answers (what `genie` alone does: open Genie). With
/// `handover` (`serve --handover <pid>`, L6) this launcher takes the endpoint and the lock the old launcher `pid` is
/// letting go of, waiting for them as long as the handover is allowed to take.
pub fn serve_then(roots: Roots, handover: Option<u32>, ready: impl FnOnce(&Roots) + Send + 'static) -> Result<(), String> {
    let runtime = roots.runtime_dir();
    private_dir(&runtime)?;
    let bound = handover_bound();
    #[cfg(unix)]
    let lock = match handover {
        Some(_) => retry(bound, || single_instance(&roots))?,
        None => single_instance(&roots)?,
    };
    crate::folder::sweep(&roots);
    let endpoint = endpoint(&roots)?;
    let listener = match handover {
        Some(_) => retry(bound, || LocalListener::bind_handed_over(&endpoint).map_err(|e| format!("the launcher's endpoint {endpoint} was not let go: {e}")))?,
        None => LocalListener::bind(&endpoint).map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists { already_running(&roots) } else { format!("the launcher's endpoint {endpoint} could not be made: {e}") }
        })?,
    };
    let token = new_token()?;
    let mut context = Context::new(roots, token);
    context.endpoint = endpoint;
    #[cfg(unix)]
    {
        context.lock = Mutex::new(Some(lock));
    }
    let ctx = Arc::new(context);
    publish(&ctx)?;
    if let Some(old) = handover {
        eprintln!("genie: took over from the launcher {old}");
        clear_old_program(old);
    }
    // The logon entry follows this launcher (it may have moved or been updated), as the inputs on disk say.
    crate::logon::apply_here(&ctx.roots);
    if tray_wanted() {
        crate::tray::start(Arc::clone(&ctx));
    }
    {
        let ctx = Arc::clone(&ctx);
        std::thread::spawn(move || {
            let _g = ctx.busy.lock().unwrap_or_else(|p| p.into_inner());
            ready(&ctx.roots);
        });
    }
    auto_check(&ctx);
    serve_listener(Arc::clone(&ctx), listener);
    // THE MAIN THREAD IS THE LAUNCHER'S WINDOWS' (L5): its questions (ui::ask) are asked in a loop that lives as long as
    // the launcher, so the wire is served on its own thread. The process ends by `exit_launcher`, never by returning.
    #[cfg(feature = "ui")]
    if tray_wanted() {
        let data = ctx.roots.data.join("launcher").join("webview");
        if let Err(why) = crate::ui::run_resident(data) {
            eprintln!("genie: the launcher cannot show its questions here ({why}): the tray will open Genie instead of asking");
        }
    }
    loop {
        std::thread::park();
    }
}

/// The token and `launcher.json` written for this launcher.
fn publish(ctx: &Context) -> Result<(), String> {
    let runtime = ctx.roots.runtime_dir();
    write_private(&runtime.join("launcher.token"), ctx.token.as_bytes())?;
    let record = json!({"pid": std::process::id(), "endpoint": ctx.endpoint, "build": LAUNCHER_BUILD, "schema": LAUNCHER_SCHEMA});
    write_private(&runtime.join("launcher.json"), record.to_string().as_bytes())
}

/// The accept loop on its own thread, until this launcher hands its endpoint over: then the listener is let go.
fn serve_listener(ctx: Arc<Context>, listener: LocalListener) {
    ctx.accepting.store(true, Ordering::SeqCst);
    std::thread::spawn(move || {
        loop {
            match listener.accept() {
                Ok(stream) => {
                    if ctx.handing_over.load(Ordering::SeqCst) {
                        break;
                    }
                    let ctx = Arc::clone(&ctx);
                    std::thread::spawn(move || serve_connection(&ctx, stream));
                }
                Err(_) => {
                    if ctx.handing_over.load(Ordering::SeqCst) {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
            }
        }
        drop(listener);
        ctx.accepting.store(false, Ordering::SeqCst);
    });
}

/// On Windows the old launcher's program was renamed `Genie.exe.old` by its self-update: deleted once that process has gone.
fn clear_old_program(old: u32) {
    #[cfg(windows)]
    if let Ok(me) = std::env::current_exe() {
        let stale = me.with_file_name("Genie.exe.old");
        std::thread::spawn(move || {
            crate::spawn::wait_gone(old, std::time::Duration::from_secs(120));
            for _ in 0..50 {
                if !stale.exists() || std::fs::remove_file(&stale).is_ok() {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
        });
    }
    #[cfg(unix)]
    let _ = old;
}

/// The launcher's own checks (the spec: every 4 hours, and when asked; GENIE_LAUNCHER_AUTO_CHECK=0 turns them off for a
/// test). By the default timing (the owner, 2026-11-25): what a check finds for the client and the browser is applied at
/// once (open windows stay; the next window runs it), the launcher updates itself silently, and a host update waits for a
/// person's Install.
fn auto_check(ctx: &Arc<Context>) {
    if std::env::var("GENIE_LAUNCHER_AUTO_CHECK").as_deref() == Ok("0") {
        return;
    }
    let ctx = Arc::clone(ctx);
    std::thread::spawn(move || {
        std::thread::sleep(crate::updates::AUTO_CHECK_FIRST);
        loop {
            match crate::updates::check_now(&ctx.updates, &ctx.roots) {
                Ok(v) => {
                    for track in [Track::Client, Track::Browser] {
                        let ready = v["tracks"].as_array().map_or(false, |rows| rows.iter().any(|r| r["track"] == track.as_str() && r["state"] == "ready"));
                        if ready {
                            let applied = {
                                let _g = ctx.busy.lock().unwrap_or_else(|p| p.into_inner());
                                crate::updates::apply_window(&ctx.updates, &ctx.roots, track)
                            };
                            match applied {
                                Ok((_, told)) => tell_clients(&ctx, &told),
                                Err(why) => eprintln!("genie: the {} update was not applied: {why}", track.as_str()),
                            }
                        }
                    }
                    let launcher_ready = v["tracks"].as_array().and_then(|rows| rows.iter().find(|r| r["track"] == "launcher" && r["state"] == "ready")).and_then(|r| r["offer"]["build"].as_str().map(str::to_string));
                    if let Some(build) = launcher_ready {
                        self_update(&ctx, &build);
                    }
                }
                Err(why) => eprintln!("genie: the updates check failed: {why}"),
            }
            std::thread::sleep(crate::updates::AUTO_CHECK_EVERY);
        }
    });
}

/// Whether the launcher `pid` answers this user's endpoint now, as named in `launcher.json`.
fn answers_as(roots: &Roots, pid: u32) -> bool {
    let runtime = roots.runtime_dir();
    let Some(record) = std::fs::read_to_string(runtime.join("launcher.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else { return false };
    if record["pid"].as_u64() != Some(pid as u64) {
        return false;
    }
    let (Some(endpoint), Ok(token)) = (record["endpoint"].as_str(), std::fs::read_to_string(runtime.join("launcher.token"))) else { return false };
    let Ok(stream) = LocalStream::connect(endpoint, std::time::Duration::from_secs(2)) else { return false };
    let Ok(mut out) = stream.try_clone() else { return false };
    let mut lines = BufReader::new(stream);
    let mine = launcher_offer();
    let hello = json!({"kind": "hello", "auth": {"kind": "token", "token": token.trim()}, "label": "genie launcher handover", "track": "launcher",
        "build": LAUNCHER_BUILD, "schema": LAUNCHER_SCHEMA, "minSchema": mine.min_schema, "capabilities": mine.capabilities});
    if writeln!(out, "{hello}").and_then(|_| out.flush()).is_err() {
        return false;
    }
    let mut line = String::new();
    if lines.read_line(&mut line).unwrap_or(0) == 0 {
        return false;
    }
    serde_json::from_str::<Value>(&line).map_or(false, |v| v["kind"] == "welcome" && v["pid"].as_u64() == Some(pid as u64))
}

/// THE LAUNCHER'S OWN UPDATE (the spec): the new build put where the launcher runs from (Windows: the running Genie.exe
/// renamed `Genie.exe.old`, which Windows allows, and the new one moved in; Linux: `~/.local/bin/genie` pointed at the
/// new build's folder), `current` pointed, this launcher's endpoint, lock and tray let go, and the new launcher started
/// with `--handover <this pid>`. Once it answers the endpoint this launcher exits. One that does not take it within 30 s
/// is ended, everything is put back as it was (the program, the link, `previous`), and this launcher serves again. The
/// client and the host are not touched either way.
pub fn self_update(ctx: &Arc<Context>, build: &str) {
    let roots = &ctx.roots;
    let guard = ctx.busy.lock().unwrap_or_else(|p| p.into_inner());
    let before = state::read(&roots.state_file()).ok().and_then(|st| st.track(Track::Launcher.as_str()).cloned());
    let undo_why = |why: String| {
        eprintln!("genie: the launcher's update to {build} did not happen: {why}");
        ctx.updates.set_launcher_why(Some(why));
    };
    // The new program, put in place.
    #[cfg(windows)]
    let (program, exe, stale) = {
        let Ok(exe) = std::env::current_exe() else { return undo_why("this launcher's own path could not be read".to_string()) };
        let stale = exe.with_file_name("Genie.exe.old");
        let Some(new) = roots.program(Track::Launcher, build) else { return undo_why(format!("{build} is not a launcher build")) };
        let _ = std::fs::remove_file(&stale);
        if let Err(e) = std::fs::rename(&exe, &stale) {
            return undo_why(format!("{} could not be set aside: {e}", exe.display()));
        }
        if let Err(e) = std::fs::copy(new.path(), &exe) {
            let _ = std::fs::rename(&stale, &exe);
            return undo_why(format!("the new launcher could not be put at {}: {e}", exe.display()));
        }
        let Some(program) = crate::layout::launcher_at(&exe) else { return undo_why(format!("{} is not the launcher's program", exe.display())) };
        (program, exe, stale)
    };
    #[cfg(unix)]
    let program = {
        let Some(program) = roots.program(Track::Launcher, build) else { return undo_why(format!("{build} is not a launcher build")) };
        if let Err(why) = crate::desktop::write_entries(roots, build) {
            return undo_why(why);
        }
        program
    };
    let put_back = |st_before: &Option<state::TrackState>| {
        // The old program back over the new one (a rename replaces it). Windows may hold the image of a process it has just
        // ended for a moment after it has gone, so the rename is tried again for up to 10 s, and a failure is said.
        #[cfg(windows)]
        {
            let t = std::time::Instant::now();
            loop {
                match std::fs::rename(&stale, &exe) {
                    Ok(()) => break,
                    Err(e) if t.elapsed() >= std::time::Duration::from_secs(10) => {
                        eprintln!("genie: the old launcher could not be put back at {}: {e}", exe.display());
                        break;
                    }
                    Err(_) => std::thread::sleep(std::time::Duration::from_millis(200)),
                }
            }
        }
        #[cfg(unix)]
        if let Some(prev) = st_before.as_ref().and_then(|t| t.current.clone()) {
            let _ = crate::desktop::write_entries(roots, &prev);
        }
        if let Ok(mut st) = state::read(&roots.state_file()) {
            match st_before {
                Some(t) => {
                    st.tracks.insert(Track::Launcher.as_str().to_string(), t.clone());
                }
                None => {
                    st.tracks.remove(Track::Launcher.as_str());
                }
            }
            let _ = state::write_atomic(&roots.state_file(), &st);
        }
    };
    if let Ok(mut st) = state::read(&roots.state_file()) {
        let channel = before.as_ref().map(|t| t.channel.clone()).unwrap_or_else(|| "stable".to_string());
        st.point(Track::Launcher.as_str(), build, &channel);
        let _ = state::write_atomic(&roots.state_file(), &st);
    }
    // Let go: the accept loop (woken by one connection of our own), the lock, the tray, the attached clients' links.
    ctx.handing_over.store(true, Ordering::SeqCst);
    let _ = LocalStream::connect(&ctx.endpoint, std::time::Duration::from_secs(2));
    let t = std::time::Instant::now();
    while ctx.accepting.load(Ordering::SeqCst) && t.elapsed() < std::time::Duration::from_secs(5) {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    ctx.lock.lock().unwrap_or_else(|p| p.into_inner()).take();
    crate::tray::remove();
    tell_clients(ctx, &json!({"kind": "event", "name": "launcher.reattach"}));
    ctx.clients.lock().unwrap_or_else(|p| p.into_inner()).clear();
    let env = vec![("GENIE_HOME".to_string(), roots.data.display().to_string())];
    let args = vec!["serve".to_string(), "--handover".to_string(), std::process::id().to_string()];
    let started = crate::spawn::start_detached(&program, &args, &env, &roots.logs_dir().join("genie-launcher.log"));
    let bound = handover_bound();
    let taken = match &started {
        Ok(pid) => {
            let t = std::time::Instant::now();
            let mut taken = false;
            while t.elapsed() < bound && pid_alive(*pid) {
                if answers_as(roots, *pid) {
                    taken = true;
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            taken
        }
        Err(_) => false,
    };
    if taken {
        eprintln!("genie: the launcher {build} took over; this one exits");
        drop(guard);
        exit_launcher(roots, 0);
    }
    // KEPT: the new one ended, everything put back, and this launcher serves again.
    if let Ok(pid) = &started {
        crate::spawn::end(*pid);
        crate::spawn::wait_gone(*pid, std::time::Duration::from_secs(10));
    }
    put_back(&before);
    let why = match &started {
        Ok(_) => format!("The new launcher {build} did not take over within {} s, so it was ended and this one kept.", bound.as_secs()),
        Err(e) => format!("The new launcher {build} could not be started ({e}), so this one was kept."),
    };
    #[cfg(unix)]
    match retry(std::time::Duration::from_secs(5), || single_instance(roots)) {
        Ok(lock) => *ctx.lock.lock().unwrap_or_else(|p| p.into_inner()) = Some(lock),
        Err(e) => eprintln!("genie: the launcher's lock could not be taken back: {e}"),
    }
    match retry(std::time::Duration::from_secs(5), || LocalListener::bind_handed_over(&ctx.endpoint).map_err(|e| e.to_string())) {
        Ok(listener) => {
            ctx.handing_over.store(false, Ordering::SeqCst);
            if let Err(e) = publish(ctx) {
                eprintln!("genie: {e}");
            }
            serve_listener(Arc::clone(ctx), listener);
        }
        Err(e) => {
            eprintln!("genie: the launcher's endpoint could not be taken back ({e}); this launcher exits");
            undo_why(why);
            drop(guard);
            exit_launcher(roots, 1);
        }
    }
    if tray_wanted() {
        crate::tray::start(Arc::clone(ctx));
    }
    undo_why(why);
}

/// A tray (and the windows its questions need), unless GENIE_LAUNCHER_NO_TRAY=1 (the launcher's own tests make dozens).
pub fn tray_wanted() -> bool {
    std::env::var("GENIE_LAUNCHER_NO_TRAY").as_deref() != Ok("1")
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

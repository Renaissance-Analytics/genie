//! UPDATES FROM THE LAUNCHER (Tynn #1058 L6; the spec's "The update flow, per component", and the owner's 2026-11-26
//! rules: each item updates on its own; a host update always comes with its client; the client, the browser and later
//! GApps update with no host upgrade or shutdown).
//!
//! - **Check** (`launcher.check`, and every 4 hours): the feed's list (`feed`, with its ETag); per installed track the
//!   newest build on its channel, newer than `current`. Each is downloaded and verified into `<build>.partial`, then its
//!   folder with `.complete` last (`install::stage_from`): READY, never applied by a check. A host's client (`withClient`)
//!   is made ready with it. A refusal is said in words ("This update's signature is not Genie's. Nothing was installed.").
//! - **Client, browser** (`launcher.apply {track}`): `current` is pointed at the ready build. Windows already open stay on
//!   their build and are told (`launcher.updateReady`); the next window runs the new one. The host is never touched. A new
//!   client build that exits within 20 s of its start three times running (never coming up) sends the track back to
//!   `previous`, said to the next window.
//! - **Host**: applied only by a person (the Updates list, the tray, `host.update`). The launcher asks the running host to
//!   install (`engine.updates install`): its own UpdateHost drains (the notice, the roster, Force), writes who comes back,
//!   stops what it hosts and calls `launcher.apply {track: host, afterPid}` before it exits. The launcher then waits for
//!   that pid, points the host and its client, starts the new host, and the new host restores each agent once. A new host
//!   that has not answered within a minute, or that exits first, is ended; both tracks go back, the old host starts and
//!   restores the agents from the same record (spent only by a restore that happened), and the person is told why.
//! - **The launcher itself**: see `control::self_update` (the pipe handed over, or the old launcher kept).
//! - **Retention**: per track `current` and `previous` are kept, and whatever a running program runs from; anything older
//!   is deleted once nothing runs from it.
//! - **The host's tools** (L7, #716): `launcher.updates` carries `tools` beside `tracks`, read from the running host
//!   (`engine.toolchain state`); a person's check asks the host to check them (`check`); `launcher.apply {tool}` is the
//!   host's own installer (`update`). With no host they say "Start the host to check its tools." The launcher installs no
//!   tool itself.

use crate::components::of_track;
use crate::feed::{self, Offer};
use crate::folder::{verify_build, HashScope};
use crate::layout::{Roots, Track};
use crate::manifest::{check, this_arch, this_platform, Manifest, Wanted};
use crate::spawn::{end, pid_alive, wait_gone};
use crate::version::compare_track_builds;
use crate::{host, install, keys, state, LAUNCHER_BUILD};
use ed25519_dalek::VerifyingKey;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// The tracks an Updates pass lists, in the list's order (the mockup's: host, client, browser, then the launcher).
pub const ORDER: [Track; 4] = [Track::Host, Track::Client, Track::Browser, Track::Launcher];

/// How often the launcher checks by itself (the spec: every 4 hours, and when asked).
pub const AUTO_CHECK_EVERY: Duration = Duration::from_secs(4 * 60 * 60);
/// The first check after the launcher starts.
pub const AUTO_CHECK_FIRST: Duration = Duration::from_secs(90);

/// A client build that exits sooner than this after its start, without ever coming up, did not start.
pub const CLIENT_UP: Duration = Duration::from_secs(20);
/// How many such starts in a row send the client back to `previous`.
pub const CLIENT_TRIES: u32 = 3;

/// What the launcher knows of its updates while it runs (in `control::Context`).
#[derive(Default)]
pub struct Shared {
    /// The last check's rows, by track.
    rows: Mutex<Vec<Value>>,
    checked_at: Mutex<Option<u64>>,
    /// One check at a time.
    checking: Mutex<()>,
    /// The host update in flight or last done: `{phase, from, to, said, agents, at}`.
    host_update: Mutex<Value>,
    /// What the next window is told (a client that went back).
    said: Mutex<Option<String>>,
    /// Why the launcher's own last update did not happen.
    launcher_why: Mutex<Option<String>>,
    /// Clients that attached: a started client that attached came up.
    pub attaches: AtomicU64,
    /// Programs started by this launcher, with the track and build they run from (retention keeps those folders).
    started: Mutex<Vec<(u32, Track, String)>>,
    /// How many client windows were open when the host update in flight was asked for: they leave when the host installs
    /// (src/core/quit.ts installQuit), and Genie is opened again after the swap when there were any.
    pub windows_at_update: std::sync::atomic::AtomicUsize,
    /// L7: the host's tools as last read, and when (the Updates window redraws every second; the host is asked at most
    /// every TOOLS_FRESH).
    tools: Mutex<Option<(Instant, Value)>>,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

impl Shared {
    pub fn host_update(&self) -> Value {
        self.host_update.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
    fn set_host_update(&self, v: Value) {
        *self.host_update.lock().unwrap_or_else(|p| p.into_inner()) = v;
    }
    fn host_phase(&self, phase: &str, from: Option<&str>, to: &str, said: Option<String>) {
        let mut h = self.host_update.lock().unwrap_or_else(|p| p.into_inner());
        let agents = h.get("agents").cloned().unwrap_or(Value::Null);
        // Every step of this update, in order: a step can last less than a second (a new host that exits at once), so what
        // was passed through is kept, not only where it is now.
        let mut steps: Vec<Value> = h.get("steps").and_then(Value::as_array).cloned().unwrap_or_default();
        if steps.last().and_then(Value::as_str) != Some(phase) {
            steps.push(json!(phase));
        }
        *h = json!({"phase": phase, "from": from, "to": to, "said": said, "agents": agents, "steps": steps, "at": now()});
    }
    pub fn set_launcher_why(&self, why: Option<String>) {
        *self.launcher_why.lock().unwrap_or_else(|p| p.into_inner()) = why;
    }
    pub fn say(&self, words: String) {
        *self.said.lock().unwrap_or_else(|p| p.into_inner()) = Some(words);
    }
    /// A program this launcher started, and what it runs from.
    pub fn started(&self, pid: u32, track: Track, build: &str) {
        let mut s = self.started.lock().unwrap_or_else(|p| p.into_inner());
        s.retain(|(p, _, _)| pid_alive(*p));
        s.push((pid, track, build.to_string()));
    }
    fn running_builds(&self, track: Track) -> Vec<String> {
        let mut s = self.started.lock().unwrap_or_else(|p| p.into_inner());
        s.retain(|(p, _, _)| pid_alive(*p));
        s.iter().filter(|(_, t, _)| *t == track).map(|(_, _, b)| b.clone()).collect()
    }
    /// How many updates are ready to apply (the tray's count).
    pub fn ready_count(&self) -> usize {
        self.rows.lock().unwrap_or_else(|p| p.into_inner()).iter().filter(|r| r["state"] == "ready").count()
    }
    /// The host update's row when one is ready (the tray's offer).
    pub fn ready_host(&self) -> Option<String> {
        let rows = self.rows.lock().unwrap_or_else(|p| p.into_inner());
        rows.iter().find(|r| r["track"] == "host" && r["state"] == "ready").and_then(|r| r["offer"]["build"].as_str().map(str::to_string))
    }
}

/// The channel a track reads: its own in state.json, else `stable`.
fn channel_of(st: &state::State, track: Track) -> String {
    st.track(track.as_str()).map(|t| t.channel.clone()).filter(|c| c == "dev" || c == "stable").unwrap_or_else(|| "stable".to_string())
}

/// The installed build of a track; for the launcher on Windows (installed by NSIS, not a track folder) its own build.
/// Under an adoption (L9) the host's is the build installed beside the adopted one: what an update must be newer than,
/// and what a failed update goes back to.
fn current_of(st: &state::State, track: Track) -> Option<String> {
    let c = st.installed(track.as_str());
    if c.is_none() && track == Track::Launcher && crate::version::parse_track_build(LAUNCHER_BUILD).is_some() {
        return Some(LAUNCHER_BUILD.to_string());
    }
    c
}

/// Whether the launcher lists a track: installed, or the launcher itself.
fn listed(st: &state::State, track: Track) -> bool {
    track == Track::Launcher || st.track(track.as_str()).and_then(|t| t.current.as_ref()).is_some()
}

/// The newest complete build of `track` newer than `current` that verifies: an update made ready by a check.
pub fn ready_build(roots: &Roots, keys: &[VerifyingKey], track: Track, current: Option<&str>) -> Option<(String, Manifest)> {
    let mut builds: Vec<String> = std::fs::read_dir(roots.track_dir(track))
        .ok()?
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|b| roots.build_dir(track, b).is_some())
        .filter(|b| current.map_or(true, |c| compare_track_builds(b, c) == std::cmp::Ordering::Greater))
        .collect();
    builds.sort_by(|a, b| compare_track_builds(b, a));
    builds.into_iter().find_map(|b| verify_build(roots, track, &b, keys, HashScope::Executables).ok().map(|m| (b, m)))
}

/// An offer downloaded and verified into its build folder (or found there already). Its manifest, or the words.
fn stage(roots: &Roots, keys: &[VerifyingKey], offer: &Offer, channel: &str, current: Option<&str>) -> Result<Manifest, String> {
    let name = format!("{} {}", offer.track.as_str(), offer.build);
    if let Ok(m) = verify_build(roots, offer.track, &offer.build, keys, HashScope::Executables) {
        return Ok(m);
    }
    let manifest = feed::fetch_small(&offer.manifest_url).map_err(|e| format!("{name}: {e}"))?;
    let sig = feed::fetch_small(&offer.signature_url).map_err(|e| format!("{name}: {e}"))?;
    // The signature and what the manifest names are checked before the package is downloaded at all.
    let wanted = Wanted { track: offer.track.as_str(), platform: this_platform(), arch: this_arch(), channel, current, launcher: Some(LAUNCHER_BUILD) };
    check(&manifest, &sig, keys, &wanted).map_err(|r| format!("{name}: {r}"))?;
    let dir = roots.code.join("downloads").join(offer.stem());
    let _ = std::fs::remove_dir_all(&dir);
    let result = (|| {
        std::fs::create_dir_all(&dir).map_err(|e| format!("{} could not be made: {e}", dir.display()))?;
        std::fs::write(dir.join(format!("{}.manifest.json", offer.stem())), &manifest).map_err(|e| e.to_string())?;
        std::fs::write(dir.join(format!("{}.manifest.json.sig", offer.stem())), &sig).map_err(|e| e.to_string())?;
        feed::download(&offer.archive_url, &dir.join(&offer.archive_name)).map_err(|e| format!("{name}: {e}"))?;
        install::stage_from(roots, &dir, offer.track, channel, LAUNCHER_BUILD, keys).map_err(|e| format!("{name}: {e}"))
    })();
    let _ = std::fs::remove_dir_all(&dir);
    result
}

/// `launcher.check`: the feed read, every newer build made ready, the rows. Nothing is applied.
pub fn check_now(shared: &Shared, roots: &Roots) -> Result<Value, String> {
    let _one = shared.checking.lock().unwrap_or_else(|p| p.into_inner());
    let keys = keys::trusted_keys(roots);
    let list = feed::fetch_list(roots)?;
    let st = state::read(&roots.state_file())?;
    let mut rows = Vec::new();
    for track in ORDER {
        if !listed(&st, track) {
            continue;
        }
        let channel = channel_of(&st, track);
        let current = current_of(&st, track);
        let mut row = json!({"track": track.as_str(), "current": current, "channel": channel, "offer": null, "state": "up-to-date",
            "restartsHost": of_track(track).map(|c| c.restarts_host).unwrap_or(false)});
        if let Some(offer) = feed::newest(&list, track, &channel, current.as_deref()) {
            row["offer"] = json!({"build": offer.build, "notes": offer.notes, "prerelease": offer.prerelease});
            let staged = (|| -> Result<Manifest, String> {
                // A host comes with its client: that client is made ready first, from the same feed.
                if track == Track::Host {
                    let manifest = feed::fetch_small(&offer.manifest_url)?;
                    let sig = feed::fetch_small(&offer.signature_url)?;
                    let wanted = Wanted { track: "host", platform: this_platform(), arch: this_arch(), channel: &channel, current: current.as_deref(), launcher: Some(LAUNCHER_BUILD) };
                    let m = check(&manifest, &sig, &keys, &wanted).map_err(|r| format!("host {}: {r}", offer.build))?;
                    let client = m.with_client.clone().ok_or_else(|| format!("The host {} names no client build. Nothing was installed.", offer.build))?;
                    let client_current = current_of(&st, Track::Client);
                    if client_current.as_deref() != Some(client.as_str()) {
                        let c = feed::exact(&list, Track::Client, &channel, &client).ok_or_else(|| format!("The host {} ships with client {client}, which the feed does not offer. Nothing was installed.", offer.build))?;
                        stage(roots, &keys, &c, &channel, client_current.as_deref())?;
                    }
                }
                stage(roots, &keys, &offer, &channel, current.as_deref())
            })();
            match staged {
                Ok(m) => {
                    row["state"] = json!("ready");
                    if let Some(c) = m.with_client {
                        row["withClient"] = json!(c);
                    }
                }
                Err(why) => {
                    row["state"] = json!(if why.contains("Nothing was installed") { "refused" } else { "failed" });
                    row["why"] = json!(why);
                }
            }
        }
        rows.push(row);
    }
    *shared.rows.lock().unwrap_or_else(|p| p.into_inner()) = rows;
    *shared.checked_at.lock().unwrap_or_else(|p| p.into_inner()) = Some(now());
    Ok(view_tracks(shared, roots))
}

// --- L7 (Tynn #716): the host's tools ----------------------------------------------------------------------------------

/// What the tool rows say when no host is running to tell them.
pub const NO_HOST_TOOLS: &str = "Start the host to check its tools.";
/// How long a read of the host's tools may take (`launcher.updates` is read whenever the Updates window draws).
pub const TOOLS_READ: Duration = Duration::from_secs(5);
/// How long the host's own check of its tools may take (it asks each tool's source for its newest version).
pub const TOOLS_CHECK: Duration = Duration::from_secs(180);
/// How long the host has to say an update has started (it is answered at its start, not at its end).
pub const TOOLS_UPDATE: Duration = Duration::from_secs(30);

fn host_running(roots: &Roots) -> bool {
    host::read_record(roots).filter(|r| pid_alive(r.pid)).is_some()
}

/// THE HOST'S TOOLS, beside the tracks: `{host, rows, checkedAt, checking}` from the running host (`engine.toolchain
/// state`, or `check` for its own forced check), or `{host: false, rows: [], why}`. The launcher reads them and asks; it
/// never installs a tool itself.
pub fn tools(roots: &Roots, how: &str, bound: Duration) -> Value {
    if !host_running(roots) {
        return json!({"host": false, "rows": [], "why": NO_HOST_TOOLS});
    }
    match host::call(roots, "engine.toolchain", json!([how, []]), bound) {
        Ok(v) => json!({"host": true, "rows": v["rows"].as_array().cloned().unwrap_or_default(), "checkedAt": v["checkedAt"], "checking": v["checking"] == true}),
        Err(why) => json!({"host": true, "rows": [], "why": format!("The host did not say what its tools are: {why}.")}),
    }
}

/// `launcher.apply {tool, version?, confirmed?}`: the host's own installer asked to update that tool. With no host running,
/// nothing is started for it and the person is told why.
pub fn apply_tool(roots: &Roots, a: &Value) -> Result<Value, String> {
    let tool = a["tool"].as_str().filter(|t| !t.is_empty()).ok_or("launcher.apply needs {track} or {tool}")?;
    if !host_running(roots) {
        return Err(NO_HOST_TOOLS.to_string());
    }
    let mut ask = json!({"tool": tool});
    if let Some(v) = a["version"].as_str().filter(|v| !v.is_empty()) {
        ask["version"] = json!(v);
    }
    if a["confirmed"] == true {
        ask["confirmed"] = json!(true);
    }
    host::call(roots, "engine.toolchain", json!(["update", [ask]]), TOOLS_UPDATE)
}

/// Whether a caller of `launcher.updates` / `launcher.check` wants the host's tools: every caller but one that says
/// `{tools: false}` (the host's own updater, which must not be asked about its tools while it asks about its build).
pub fn wants_tools(args: &[Value]) -> bool {
    args.first().map_or(true, |a| a["tools"] != false)
}

/// `launcher.check` for a person: the tracks checked, then the host asked to check its tools; the rows with both. A
/// failed feed is still said, once the tools were checked.
pub fn check_with_tools(shared: &Shared, roots: &Roots) -> Result<Value, String> {
    let tracks = check_now(shared, roots);
    let tools = tools(roots, "check", TOOLS_CHECK);
    *shared.tools.lock().unwrap_or_else(|p| p.into_inner()) = Some((Instant::now(), tools.clone()));
    let mut v = tracks?;
    v["tools"] = tools;
    Ok(v)
}

/// How long a read of the host's tools is shown before the host is asked again.
pub const TOOLS_FRESH: Duration = Duration::from_secs(3);

/// `launcher.updates` with the host's tools (read, never checked; at most every TOOLS_FRESH).
pub fn view(shared: &Shared, roots: &Roots) -> Value {
    let mut v = view_tracks(shared, roots);
    let fresh = shared.tools.lock().unwrap_or_else(|p| p.into_inner()).as_ref().filter(|(at, _)| at.elapsed() < TOOLS_FRESH).map(|(_, t)| t.clone());
    v["tools"] = fresh.unwrap_or_else(|| {
        let t = tools(roots, "state", TOOLS_READ);
        *shared.tools.lock().unwrap_or_else(|p| p.into_inner()) = Some((Instant::now(), t.clone()));
        t
    });
    v
}

/// What was read of the host's tools is old once one is asked to update (its step is read at the next draw).
pub fn tools_changed(shared: &Shared) {
    *shared.tools.lock().unwrap_or_else(|p| p.into_inner()) = None;
}

/// `launcher.updates`: the last check's rows (with what is ready now, and why the launcher's own did not happen), the host
/// update in flight or last done, and what the next window is told. No network.
pub fn view_tracks(shared: &Shared, roots: &Roots) -> Value {
    let keys = keys::trusted_keys(roots);
    let st = state::read(&roots.state_file()).unwrap_or_default();
    let last = shared.rows.lock().unwrap_or_else(|p| p.into_inner()).clone();
    let mut rows = Vec::new();
    for track in ORDER {
        if !listed(&st, track) {
            continue;
        }
        let current = current_of(&st, track);
        let mut row = last.iter().find(|r| r["track"] == track.as_str()).cloned().unwrap_or_else(|| {
            json!({"track": track.as_str(), "offer": null, "state": "unchecked", "restartsHost": of_track(track).map(|c| c.restarts_host).unwrap_or(false)})
        });
        row["current"] = json!(current);
        row["channel"] = json!(channel_of(&st, track));
        // What was applied since the check is no longer on offer.
        if row["state"] == "ready" && ready_build(roots, &keys, track, current.as_deref()).is_none() {
            row["state"] = json!("up-to-date");
            row["offer"] = Value::Null;
        }
        if track == Track::Launcher {
            if let Some(why) = shared.launcher_why.lock().unwrap_or_else(|p| p.into_inner()).clone() {
                row["why"] = json!(why);
            }
        }
        rows.push(row);
    }
    json!({
        "tracks": rows,
        "checkedAt": *shared.checked_at.lock().unwrap_or_else(|p| p.into_inner()),
        "hostUpdate": shared.host_update(),
        "said": shared.said.lock().unwrap_or_else(|p| p.into_inner()).clone(),
        "ready": shared.ready_count(),
    })
}

/// `launcher.channel {channel}` (every track) or `{track, channel}`.
pub fn set_channel(roots: &Roots, args: &Value) -> Result<Value, String> {
    let channel = args["channel"].as_str().filter(|c| *c == "stable" || *c == "dev").ok_or("launcher.channel needs {channel: stable|dev}")?;
    let mut st = state::read(&roots.state_file())?;
    let only = args["track"].as_str().map(|t| Track::parse(t).ok_or_else(|| format!("there is no track '{t}'"))).transpose()?;
    for track in Track::ALL {
        if only.map_or(true, |o| o == track) {
            if let Some(t) = st.tracks.get_mut(track.as_str()) {
                t.channel = channel.to_string();
            } else if track == Track::Launcher {
                st.tracks.insert(track.as_str().to_string(), state::TrackState { channel: channel.to_string(), ..Default::default() });
            }
        }
    }
    state::write_atomic(&roots.state_file(), &st).map_err(|e| format!("state.json could not be written: {e}"))?;
    Ok(json!({"channel": channel}))
}

/// RETENTION: every build folder of `track` but `current`, `previous` and what a running program runs from is deleted.
pub fn retain(shared: &Shared, roots: &Roots, track: Track) -> Vec<String> {
    let Ok(st) = state::read(&roots.state_file()) else { return Vec::new() };
    let mut keep: Vec<String> = st.track(track.as_str()).map(|t| [t.current.clone(), t.previous.clone()].into_iter().flatten().collect()).unwrap_or_default();
    keep.extend(shared.running_builds(track));
    match track {
        Track::Host => keep.extend(host::read_record(roots).filter(|r| pid_alive(r.pid)).map(|r| r.build)),
        // The browser runs on the client build its manifest names.
        Track::Client => {
            let keys = keys::trusted_keys(roots);
            for b in st.track(Track::Browser.as_str()).map(|t| [t.current.clone(), t.previous.clone()]).into_iter().flatten().flatten() {
                if let Ok(m) = verify_build(roots, Track::Browser, &b, &keys, HashScope::Executables) {
                    keep.extend(m.with_client);
                }
            }
        }
        Track::Launcher => keep.extend(std::env::current_exe().ok().and_then(|p| p.parent().and_then(|d| d.file_name()).map(|n| n.to_string_lossy().into_owned()))),
        Track::Browser => {}
    }
    let mut gone = Vec::new();
    let Ok(entries) = std::fs::read_dir(roots.track_dir(track)) else { return gone };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if roots.build_dir(track, &name).is_none() || keep.contains(&name) || !e.path().is_dir() {
            continue;
        }
        if std::fs::remove_dir_all(e.path()).is_ok() {
            gone.push(name);
        }
    }
    gone
}

/// The client or the browser: `current` pointed at its ready build; nothing running is touched. `(build, told)`, where
/// `told` is run with what every open window is told.
pub fn apply_window(shared: &Shared, roots: &Roots, track: Track) -> Result<(String, Value), String> {
    let keys = keys::trusted_keys(roots);
    let mut st = state::read(&roots.state_file())?;
    let current = current_of(&st, track);
    let (build, m) = ready_build(roots, &keys, track, current.as_deref()).ok_or_else(|| format!("There is no {} update ready to apply.", track.as_str()))?;
    if track == Track::Browser {
        let client = current_of(&st, Track::Client);
        let wanted = m.with_client.clone().unwrap_or_default();
        if client.as_deref() != Some(wanted.as_str()) {
            return Err(format!("The browser {build} runs on client {wanted}; update the client first."));
        }
    }
    let channel = channel_of(&st, track);
    st.point(track.as_str(), &build, &channel);
    if track == Track::Client {
        if let Some(t) = st.tracks.get_mut(track.as_str()) {
            t.trial = true;
            t.quick_exits = 0;
        }
    }
    state::write_atomic(&roots.state_file(), &st).map_err(|e| format!("state.json could not be written: {e}"))?;
    retain(shared, roots, track);
    // The browser runs on a client build: once it has moved, a client build only its old previous needed can go.
    if track == Track::Browser {
        retain(shared, roots, Track::Client);
    }
    Ok((build.clone(), json!({"kind": "event", "name": "launcher.updateReady", "track": track.as_str(), "build": build})))
}

/// A client this launcher started, watched for its first 20 s while its build is on trial (just applied): one that exits
/// first without ever attaching did not come up; three in a row send the client back to `previous`.
pub fn watch_client(shared: std::sync::Arc<Shared>, roots: Roots, pid: u32, build: String) {
    let attaches = shared.attaches.load(Ordering::SeqCst);
    let t = Instant::now();
    while t.elapsed() < CLIENT_UP && pid_alive(pid) {
        std::thread::sleep(Duration::from_millis(200));
    }
    let came_up = pid_alive(pid) || shared.attaches.load(Ordering::SeqCst) != attaches;
    let Ok(mut st) = state::read(&roots.state_file()) else { return };
    let Some(t) = st.tracks.get_mut(Track::Client.as_str()) else { return };
    if !t.trial || t.current.as_deref() != Some(build.as_str()) {
        return;
    }
    if came_up {
        t.trial = false;
        t.quick_exits = 0;
    } else {
        t.quick_exits += 1;
        if t.quick_exits >= CLIENT_TRIES {
            if let Some(prev) = t.previous.clone() {
                t.previous = Some(build.clone());
                t.current = Some(prev.clone());
                t.trial = false;
                t.quick_exits = 0;
                shared.say(format!("Genie client {build} closed as it started {CLIENT_TRIES} times running, so Genie went back to {prev}."));
            }
        }
    }
    let _ = state::write_atomic(&roots.state_file(), &st);
}

/// A host update asked for by a person (no host pid yet): a running host is asked to install, through its own drain; with
/// no host running the pointers move and the next start runs it.
pub fn ask_host(shared: &Shared, roots: &Roots, windows_open: usize) -> Result<Value, String> {
    shared.windows_at_update.store(windows_open, Ordering::SeqCst);
    let keys = keys::trusted_keys(roots);
    let st = state::read(&roots.state_file())?;
    let from = current_of(&st, Track::Host);
    let (to, m) = ready_build(roots, &keys, Track::Host, from.as_deref()).ok_or("There is no host update ready to apply.")?;
    let client = m.with_client.clone().ok_or_else(|| format!("The host {to} names no client build."))?;
    if current_of(&st, Track::Client).as_deref() != Some(client.as_str()) && verify_build(roots, Track::Client, &client, &keys, HashScope::Executables).is_err() {
        return Err(format!("The host {to} ships with client {client}, which is not ready here. Check for updates again."));
    }
    let mut running = host::read_record(roots).filter(|r| pid_alive(r.pid));
    let adopted = st.track(Track::Host.as_str()).and_then(|t| t.current.as_deref()) == Some(state::ADOPTED);
    if adopted && running.is_some() {
        // THE ADOPTED HOST (L9) is the single-app install's: asked to install, it would run its own electron-updater
        // helper against the old feed. It is given the graceful stop instead (`engine.shutdown`, as any host), then the
        // new host is pointed at and started. Only the unchanged-host bridge leaves a host to adopt; the changed-host
        // bridge has drained and stopped it before the installer ran.
        shared.set_host_update(json!({"phase": "stopping", "from": from, "to": to, "said": null, "agents": null, "steps": ["stopping"], "at": now()}));
        host::stop_host(roots).map_err(|why| format!("The host Genie ran before its launcher did not stop: {why}"))?;
        host::remove_single_app_copy(roots);
        running = None;
    }
    if running.is_none() {
        point_host(roots, &to, Some(&client))?;
        if adopted {
            host::ensure_host(roots, &keys).map_err(|why| format!("The new host {to} did not start: {why}"))?;
        }
        shared.host_phase("done", from.as_deref(), &to, None);
        retain(shared, roots, Track::Host);
        retain(shared, roots, Track::Client);
        return Ok(json!({"applied": true, "build": to, "hostRunning": false}));
    }
    // Who the drain will pause, for the Updates window's "keeping agents" screen.
    let agents = host::activity(roots).map(|a| json!({"count": a["agents"], "names": a["agentNames"]})).unwrap_or(Value::Null);
    shared.set_host_update(json!({"phase": "draining", "from": from, "to": to, "said": null, "agents": agents, "steps": ["draining"], "at": now()}));
    match host::call(roots, "engine.updates", json!(["install", [{"from": "launcher", "build": to}]]), Duration::from_secs(30)) {
        Ok(v) => Ok(json!({"asked": true, "build": to, "host": v})),
        Err(why) => {
            shared.host_phase("failed", from.as_deref(), &to, Some(format!("The host did not take the update: {why}. Nothing was stopped.")));
            Err(format!("The host did not take the update: {why}"))
        }
    }
}

fn point_host(roots: &Roots, host_build: &str, client: Option<&str>) -> Result<(), String> {
    let mut st = state::read(&roots.state_file())?;
    let channel = channel_of(&st, Track::Host);
    st.point(Track::Host.as_str(), host_build, &channel);
    if let Some(c) = client {
        let channel = channel_of(&st, Track::Client);
        st.point(Track::Client.as_str(), c, &channel);
    }
    state::write_atomic(&roots.state_file(), &st).map_err(|e| format!("state.json could not be written: {e}"))
}

/// THE SWAP, once the host that drained has said it is going (`launcher.apply {track: host, afterPid}`): wait for its pid,
/// point the host and its client, start the new host; a new host that does not answer in time is ended and the old one
/// started again. What every open window is told, when the client moved.
pub fn swap_host(shared: &Shared, roots: &Roots, after_pid: u32) -> Option<Value> {
    let keys = keys::trusted_keys(roots);
    let Ok(st) = state::read(&roots.state_file()) else { return None };
    let from = current_of(&st, Track::Host);
    let prev_client = current_of(&st, Track::Client);
    let Some((to, m)) = ready_build(roots, &keys, Track::Host, from.as_deref()) else {
        shared.host_phase("failed", from.as_deref(), "", Some("The host stopped for an update, but no host update is ready here.".to_string()));
        let _ = host::ensure_host(roots, &keys);
        return None;
    };
    shared.host_phase("stopping", from.as_deref(), &to, None);
    if !wait_gone(after_pid, host::HOST_GONE) {
        end(after_pid);
        wait_gone(after_pid, Duration::from_secs(10));
    }
    shared.host_phase("swapping", from.as_deref(), &to, None);
    if let Err(why) = point_host(roots, &to, m.with_client.as_deref()) {
        shared.host_phase("failed", from.as_deref(), &to, Some(why));
        let _ = host::ensure_host(roots, &keys);
        return None;
    }
    shared.host_phase("starting", from.as_deref(), &to, None);
    match host::ensure_host_within(roots, &keys, host::ready_bound()) {
        Ok(_) => {
            shared.host_phase("done", from.as_deref(), &to, None);
            retain(shared, roots, Track::Host);
            retain(shared, roots, Track::Client);
            m.with_client.filter(|c| prev_client.as_deref() != Some(c.as_str())).map(|c| json!({"kind": "event", "name": "launcher.updateReady", "track": "client", "build": c}))
        }
        Err(why) => {
            eprintln!("genie: the new host {to} did not come up ({why}); going back");
            let log = host::host_log(roots);
            let Some(back) = from.clone() else {
                shared.host_phase("failed", None, &to, Some(format!("The new host did not start ({why}), and there is no earlier host to go back to. The host's log: {}", log.display())));
                return None;
            };
            shared.host_phase("rolling-back", Some(&back), &to, None);
            if let Err(e) = point_host(roots, &back, prev_client.as_deref()) {
                shared.host_phase("failed", Some(&back), &to, Some(e));
                return None;
            }
            match host::ensure_host_within(roots, &keys, host::HOST_READY) {
                Ok(_) => shared.host_phase(
                    "rolled-back",
                    Some(&back),
                    &to,
                    Some(format!("The new host did not start within a minute, so Genie went back to {back}. Your agents are back. The host's log: {}", log.display())),
                ),
                Err(again) => shared.host_phase(
                    "failed",
                    Some(&back),
                    &to,
                    Some(format!("The new host did not start within a minute, and {back} did not start again either ({again}). The host's log: {}", log.display())),
                ),
            }
            None
        }
    }
}

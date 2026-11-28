//! THE TRAY PANEL AND THE LAUNCH PAD (Tynn #1058, tasks #1514 and #1515): what the two windows of the owner's direction C,
//! "Wish Orb", say and do (sandbox/launcher-design/shots/direction-c-tray.png and direction-c-pad.png; the markup is
//! ui/panel.html and ui/pad.html, drawn in the platform webview by src/ui.rs).
//!
//! The PANEL is what a click on the tray icon opens: a frameless dark panel anchored to the tray, closing when it loses
//! focus. Its items are the tray menu's own actions (`tray::Action`, run by `tray::act`: Stop host still asks first), and
//! three of its own: the header opens the launch pad, "Start when I sign in" is the logon setting (`launcher.logon`'s),
//! and a paired host's row opens a window on that host (`launcher.openWindow {host}`).
//!
//! The PAD is the launcher's own window: the greeting, this computer's host with its agents and uptime, Genie, the Genie
//! Browser, the Genie Apps still to come, Updates and Settings.
//!
//! Everything here is pure (the facts in, the words out), so the tests read it from a launcher's state they make up.

use crate::control::Context;
use crate::tray::{self, Action, HostView, View};
use serde_json::{json, Value};

/// What the panel and the pad are drawn from.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Facts {
    /// The tray's own view: the local host and its agents, the windows open, the Browser, what waits, the updates.
    pub view: View,
    /// The hosts this computer paired with (`<runtime>/device-hosts.json`: addresses, never a token).
    pub paired: Vec<String>,
    /// "Start when I sign in" (the logon setting).
    pub at_logon: bool,
    /// When the local host started (`host.json` startedAt, ms since the epoch).
    pub host_started_ms: Option<u64>,
    pub now_ms: u64,
}

/// A screen's work area, in the same units as the anchor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

/// What a click on an item (or the header) does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Pick {
    /// The tray menu's own action, run by `tray::act`.
    Act(Action),
    /// "Start when I sign in", turned over.
    Logon,
    /// The header: the launch pad.
    Pad,
    /// A paired host's row: a Genie window on that host.
    Host(String),
}

fn plural(n: u64, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// The host's uptime as a person says it.
pub fn uptime(ms: u64) -> String {
    let min = ms / 60_000;
    let (hours, days) = (min / 60, min / (60 * 24));
    if min < 1 {
        "up less than a minute".to_string()
    } else if hours < 1 {
        format!("up {min} min")
    } else if days < 1 {
        format!("up {}", plural(hours, "hour", "hours"))
    } else {
        format!("up {}", plural(days, "day", "days"))
    }
}

/// A paired host's name: its address's host part (the launcher knows no other name for it).
pub fn host_name(url: &str) -> String {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    let authority = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = if authority.starts_with('[') { authority.split(']').next().map(|h| format!("{h}]")).unwrap_or_default() } else { authority.split(':').next().unwrap_or("").to_string() };
    host
}

/// The hosts this computer paired with: `<runtime>/device-hosts.json` (`{"hosts": [url, …]}`, src/main/device-tokens.ts).
pub fn read_paired(runtime: &std::path::Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(runtime.join("device-hosts.json")) else { return Vec::new() };
    let Ok(v) = serde_json::from_str::<Value>(&text) else { return Vec::new() };
    v["hosts"].as_array().map(|a| a.iter().filter_map(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string).collect()).unwrap_or_default()
}

/// When the local host started: `host.json`'s startedAt (ms), as genie-host writes it.
pub fn host_started_ms(roots: &crate::layout::Roots) -> Option<u64> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(roots.runtime_dir().join("host.json")).ok()?).ok()?;
    v["startedAt"].as_f64().filter(|t| *t > 0.0).map(|t| t as u64)
}

/// The facts now, from the launcher's own sources: the tray's view, the paired hosts, the logon setting, host.json.
pub fn facts(ctx: &Context) -> Facts {
    let view = tray::view(ctx);
    let started = if matches!(view.host, HostView::Running { .. }) { host_started_ms(&ctx.roots) } else { None };
    let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    Facts { view, paired: read_paired(&ctx.roots.runtime_dir()), at_logon: crate::logon::read_settings(&ctx.roots).setting, host_started_ms: started, now_ms }
}

fn item(id: &str, label: &str, icon: Option<&str>) -> Value {
    json!({"kind": "item", "id": id, "label": label, "icon": icon, "enabled": true})
}

/// The panel, top to bottom: the header, then the items (`kind`: item, toggle, host, label, sep).
pub fn panel(f: &Facts) -> Value {
    let v = &f.view;
    let state = match v.host {
        HostView::NotHere => "none",
        HostView::Stopped => "stopped",
        HostView::Running { .. } => "running",
    };
    let mut items = Vec::new();
    // What waits on the person (the icon has its dot): Genie opened on the Dashboard, where the Deck is.
    if v.needs_you > 0 {
        let mut i = item("openDeck", "Needs you", Some("i-seal"));
        i["badge"] = json!(v.needs_you);
        i["alert"] = json!(true);
        items.push(i);
    }
    let mut open = item("openGenie", "Open Genie", Some("i-window"));
    open["strong"] = json!(true);
    items.push(open);
    if v.browser {
        items.push(item("openBrowser", "Open Genie Browser", Some("i-globe")));
    }
    // HOSTS: this computer's, then the paired ones.
    let mut hosts = Vec::new();
    match v.host {
        HostView::Running { agents } => {
            let right = agents.map(|n| plural(n, "agent", "agents")).unwrap_or_else(|| "running".to_string());
            hosts.push(json!({"kind": "host", "id": "host:local", "label": "This computer", "dot": "ok", "right": right, "enabled": true}));
        }
        HostView::Stopped => hosts.push(json!({"kind": "host", "id": "host:local", "label": "This computer", "dot": "off", "right": "stopped", "enabled": true})),
        HostView::NotHere => {}
    }
    for url in &f.paired {
        // The launcher holds no token for a paired host, so it cannot ask how many agents it runs: it says "paired".
        hosts.push(json!({"kind": "host", "id": format!("host:{url}"), "label": host_name(url), "title": url, "dot": "off", "right": "paired", "enabled": true}));
    }
    if !hosts.is_empty() {
        items.push(json!({"kind": "sep"}));
        items.push(json!({"kind": "label", "label": "Hosts"}));
        items.extend(hosts);
    }
    items.push(json!({"kind": "sep"}));
    match v.host {
        HostView::Running { .. } => items.push(item("stopHost", "Stop this computer’s host", Some("i-host"))),
        HostView::Stopped => items.push(item("startHost", "Start this computer’s host", Some("i-host"))),
        HostView::NotHere => {}
    }
    let mut updates = item("updates", "Updates", Some("i-rocket"));
    if v.updates > 0 {
        updates["badge"] = json!(v.updates);
    }
    items.push(updates);
    if v.host_update.is_some() && v.host != HostView::NotHere {
        items.push(item("installHostUpdate", "Update host", Some("i-host")));
    }
    items.push(json!({"kind": "toggle", "id": "logon", "label": "Start when I sign in", "on": f.at_logon, "enabled": true}));
    items.push(json!({"kind": "sep"}));
    let keep = matches!(v.host, HostView::Running { .. }) && v.windows > 0;
    let mut close = json!({"kind": "item", "id": "closeUi", "label": "Close Genie", "icon": null, "enabled": v.windows > 0});
    if keep {
        close["right"] = json!("agents keep running");
    }
    items.push(close);
    items.push(json!({"kind": "item", "id": "shutDown", "label": "Shut down everything", "icon": null, "enabled": true, "danger": true}));
    json!({"head": {"title": "Genie", "line": tray::host_line(v), "state": state}, "items": items})
}

/// The panel as words, one item a line (the tests, `launcher.trayPanel`, the launcher's log).
pub fn panel_text(p: &Value) -> Vec<String> {
    let mut out = Vec::new();
    for i in p["items"].as_array().into_iter().flatten() {
        let label = i["label"].as_str().unwrap_or("");
        let line = match i["kind"].as_str() {
            Some("sep") => "---".to_string(),
            Some("label") => format!("# {label}"),
            Some("host") => format!("• {label} — {}", i["right"].as_str().unwrap_or("")),
            Some("toggle") => format!("[{}] {label}", if i["on"] == true { "x" } else { " " }),
            _ => {
                let mut s = label.to_string();
                if let Some(n) = i["badge"].as_u64() {
                    s.push_str(&format!(" ({n})"));
                }
                if let Some(r) = i["right"].as_str() {
                    s.push_str(&format!(" — {r}"));
                }
                if i["enabled"] == false {
                    s.push_str(" (unavailable)");
                }
                s
            }
        };
        out.push(line);
    }
    out
}

/// The launch pad.
pub fn pad(f: &Facts) -> Value {
    let v = &f.view;
    let uptime_of = || f.host_started_ms.filter(|s| *s <= f.now_ms).map(|s| uptime(f.now_ms - s));
    let (sub, host) = match v.host {
        HostView::Running { agents } => {
            let mut parts = Vec::new();
            if let Some(n) = agents {
                parts.push(if n == 0 { "No agents working".to_string() } else { format!("{} working", plural(n, "agent", "agents")) });
            }
            if let Some(u) = uptime_of() {
                parts.push(u);
            }
            let detail = if parts.is_empty() { "Running".to_string() } else { parts.join(" · ") };
            ("Everything is running.", json!({"title": "This computer’s host", "pill": "Running", "ok": true, "detail": detail, "button": {"id": "stopHost", "label": "Stop"}}))
        }
        HostView::Stopped => ("Your host is stopped.", json!({"title": "This computer’s host", "pill": "Stopped", "ok": false, "detail": "Your agents wait until it starts", "button": {"id": "startHost", "label": "Start"}})),
        HostView::NotHere => ("Genie is ready.", json!({"title": "No host on this computer", "pill": null, "ok": false, "detail": "Genie opens on the hosts you pair with", "button": null})),
    };
    let label = match v.updates {
        0 => "Updates",
        1 => "Update ready",
        _ => "Updates ready",
    };
    json!({
        "sub": sub,
        "host": host,
        "genie": {"id": "openGenie", "enabled": true},
        "browser": {"id": "openBrowser", "enabled": v.browser},
        "updates": {"id": "updates", "count": v.updates, "label": label},
        "settings": {"id": "openSettings"},
    })
}

/// What a click on `id` (an item's, the header's, a pad button's) does; `None` for anything the windows never send.
pub fn pick(id: &str) -> Option<Pick> {
    match id {
        "logon" => Some(Pick::Logon),
        "pad" => Some(Pick::Pad),
        "host:local" => Some(Pick::Act(Action::OpenGenie)),
        _ => {
            if let Some(url) = id.strip_prefix("host:") {
                return if url.is_empty() { None } else { Some(Pick::Host(url.to_string())) };
            }
            Action::parse(id).map(Pick::Act)
        }
    }
}

/// Where the panel goes, `size` wide and high, for a click at `anchor` on a screen whose work area (the screen less its
/// taskbar or bar) is `work`: against the bar the click came from, over the click, never off the work area.
pub fn place(anchor: (i32, i32), work: Rect, size: (i32, i32), margin: i32) -> (i32, i32) {
    let (w, h) = size;
    let (ax, ay) = anchor;
    let clamp = |v: i32, lo: i32, hi: i32| if hi < lo { lo } else { v.max(lo).min(hi) };
    let x_lo = work.left + margin;
    let x_hi = work.right - w - margin;
    let y_lo = work.top + margin;
    let y_hi = work.bottom - h - margin;
    if ax < work.left {
        // A taskbar on the left: beside it, the panel's foot at the click.
        return (x_lo, clamp(ay - h + margin, y_lo, y_hi));
    }
    if ax >= work.right {
        return (x_hi, clamp(ay - h + margin, y_lo, y_hi));
    }
    let x = clamp(ax - w / 2, x_lo, x_hi);
    let y = if ay >= work.bottom { y_hi } else if ay < work.top { y_lo } else if ay > (work.top + work.bottom) / 2 { clamp(ay - h - margin, y_lo, y_hi) } else { clamp(ay + margin, y_lo, y_hi) };
    (x, y)
}

/// "Start when I sign in", turned over as `launcher.logon` turns it (the setting, then the entry), start-minimised kept.
pub fn toggle_logon(roots: &crate::layout::Roots) -> Result<String, String> {
    let now = crate::logon::read_settings(roots);
    let next = crate::logon::LogonSettings { setting: !now.setting, start_minimized: now.start_minimized };
    crate::logon::write_settings(roots, next)?;
    let exe = crate::logon::entry_exe()?;
    crate::logon::apply(roots, &crate::logon::place(), &exe)
}

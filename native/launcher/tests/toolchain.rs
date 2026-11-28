//! THE HOST'S TOOLS IN THE LAUNCHER'S UPDATES (Tynn #1058, slice L7; #716). `launcher.updates` lists the host's toolchain
//! rows beside the tracks (`tools`), read from the running host (`engine.toolchain state`); with no host they say why
//! ("Start the host to check its tools."). `launcher.check` asks the host to check them too. Applying one
//! (`launcher.apply {tool}`) is the host's own installer (`engine.toolchain update`): the launcher installs nothing, and
//! with no host it starts nothing.
mod common;

use common::feed::Feed;
use common::live::*;
use common::*;
use genie_launcher::layout::Roots;
use genie_launcher::spawn::pid_alive;
use serde_json::{json, Value};
use std::process::Command;

const NO_HOST: &str = "Start the host to check its tools.";

fn launcher_reading(r: &Roots, key: &ed25519_dalek::SigningKey, feed: &Feed) -> Command {
    let mut c = genie_in(r, key);
    c.env("GENIE_LAUNCHER_FEED", feed.url()).env("GENIE_LAUNCHER_AUTO_CHECK", "0");
    c
}

fn ok(v: &Value) -> &Value {
    assert_eq!(v["ok"], true, "{v}");
    &v["value"]
}

/// The fake host's journal lines.
fn journal(r: &Roots) -> Vec<String> {
    std::fs::read_to_string(r.data.join("journal.txt")).unwrap_or_default().lines().map(str::to_string).collect()
}

/// What the launcher asked of the host's tools (the fake host's `toolchain.txt`).
fn asks(r: &Roots) -> Vec<String> {
    std::fs::read_to_string(r.data.join("toolchain.txt")).unwrap_or_default().lines().map(str::to_string).collect()
}

fn host_pid(r: &Roots) -> Option<u32> {
    genie_launcher::host::read_record(r).filter(|h| pid_alive(h.pid)).map(|h| h.pid)
}

#[test]
fn with_a_host_its_tools_are_listed_beside_the_tracks() {
    let _one = one_at_a_time();
    let (base, r, key) = setup("t-tools");
    install_fakes(&r, &key, &base);
    let feed = Feed::start(&base.join("feed"));
    let _l = start_with(&r, &key, launcher_reading(&r, &key, &feed));
    let mut w = Wire::hello(&r);
    let pid = ok(&w.call("launcher.ensureHost", json!([])))["pid"].as_u64().unwrap() as u32;
    std::fs::write(
        r.data.join("fake-host-tools.json"),
        json!({"rows": [
            {"tool": "node", "label": "Node", "installed": "24.10.0", "to": "24.11.1", "tone": "update-available"},
            {"tool": "claude-code", "label": "Claude Code", "installed": "2.1.3", "to": "2.1.5", "tone": "security-update", "advisory": "CVE-2026-0001"}
        ], "checkedAt": 1700000000000u64, "checking": false})
        .to_string(),
    )
    .unwrap();
    let v = ok(&w.call("launcher.updates", json!([]))).clone();
    assert!(v["tracks"].as_array().map_or(false, |t| t.iter().any(|row| row["track"] == "host")), "the tracks are still there: {v}");
    let tools = &v["tools"];
    assert_eq!(tools["host"], true, "{v}");
    assert!(tools["why"].is_null(), "a host that answered needs no why: {v}");
    let rows = tools["rows"].as_array().unwrap_or_else(|| panic!("no tool rows: {v}"));
    assert_eq!(rows.iter().map(|t| t["tool"].as_str().unwrap_or("")).collect::<Vec<_>>(), vec!["node", "claude-code"], "{v}");
    assert_eq!(rows[0]["to"], "24.11.1");
    assert_eq!(rows[1]["tone"], "security-update");
    assert_eq!(tools["checkedAt"], 1700000000000u64);
    assert!(asks(&r).iter().any(|l| l == &format!("toolchain-state {pid}")), "the rows came from the host: {:?}", asks(&r));
}

#[test]
fn with_no_host_the_tools_say_why_and_applying_one_starts_nothing() {
    let _one = one_at_a_time();
    let (base, r, key) = setup("t-tools-nohost");
    install_fakes(&r, &key, &base);
    let feed = Feed::start(&base.join("feed"));
    let _l = start_with(&r, &key, launcher_reading(&r, &key, &feed));
    let mut w = Wire::hello(&r);
    let v = ok(&w.call("launcher.updates", json!([]))).clone();
    assert_eq!(v["tools"]["host"], false, "{v}");
    assert_eq!(v["tools"]["why"], NO_HOST, "{v}");
    assert_eq!(v["tools"]["rows"], json!([]), "{v}");
    let applied = w.call("launcher.apply", json!([{"tool": "node", "version": "24.11.1"}]));
    assert_eq!(applied["ok"], false, "{applied}");
    assert_eq!(applied["reason"], NO_HOST, "{applied}");
    // Nothing was started to install it: no host, no client, nothing in the host's journal.
    assert_eq!(host_pid(&r), None, "no host was started for a tool");
    assert!(journal(&r).is_empty() && asks(&r).is_empty(), "{:?} {:?}", journal(&r), asks(&r));
    assert!(!r.data.join("client-args.txt").exists(), "no client was started for a tool");
}

#[test]
fn applying_a_tool_is_the_hosts_installer_and_the_host_keeps_running() {
    let _one = one_at_a_time();
    let (base, r, key) = setup("t-tools-apply");
    install_fakes(&r, &key, &base);
    let feed = Feed::start(&base.join("feed"));
    let _l = start_with(&r, &key, launcher_reading(&r, &key, &feed));
    let mut w = Wire::hello(&r);
    let pid = ok(&w.call("launcher.ensureHost", json!([])))["pid"].as_u64().unwrap() as u32;
    let current = std::fs::read_to_string(r.state_file()).unwrap();
    let applied = w.call("launcher.apply", json!([{"tool": "node", "version": "24.11.1"}]));
    assert_eq!(ok(&applied)["started"], true, "{applied}");
    assert!(asks(&r).iter().any(|l| l == &format!("toolchain-update {pid} node 24.11.1 confirmed=false")), "the host's installer ran it: {:?}", asks(&r));
    // An Update anyway (the host's warning) is passed on as the person said it.
    ok(&w.call("launcher.apply", json!([{"tool": "node", "version": "24.11.1", "confirmed": true}])));
    assert!(asks(&r).iter().any(|l| l == &format!("toolchain-update {pid} node 24.11.1 confirmed=true")), "{:?}", asks(&r));
    assert_eq!(host_pid(&r), Some(pid), "a tool's update never restarts the host");
    assert_eq!(std::fs::read_to_string(r.state_file()).unwrap(), current, "a tool's update moves no track");
    assert!(!journal(&r).iter().any(|l| l.starts_with("drain ") || l.starts_with("shutdown ")), "{:?}", journal(&r));
}

#[test]
fn a_check_asks_the_host_to_check_its_tools_too() {
    let _one = one_at_a_time();
    let (base, r, key) = setup("t-tools-check");
    install_fakes(&r, &key, &base);
    let feed = Feed::start(&base.join("feed"));
    let _l = start_with(&r, &key, launcher_reading(&r, &key, &feed));
    let mut w = Wire::hello(&r);
    let pid = ok(&w.call("launcher.ensureHost", json!([])))["pid"].as_u64().unwrap() as u32;
    let v = ok(&w.call("launcher.check", json!([]))).clone();
    assert!(asks(&r).iter().any(|l| l == &format!("toolchain-check {pid}")), "{:?}", asks(&r));
    assert_eq!(v["tools"]["rows"][0]["tool"], "node", "{v}");
}

#[test]
fn the_hosts_own_updater_is_answered_its_tracks_only_and_never_asked_back() {
    // genie-host's updater asks `launcher.check` / `launcher.updates` with {tools: false}: the launcher must not call the
    // host about its tools while the host waits on it about its build.
    let _one = one_at_a_time();
    let (base, r, key) = setup("t-tools-host");
    install_fakes(&r, &key, &base);
    let feed = Feed::start(&base.join("feed"));
    let _l = start_with(&r, &key, launcher_reading(&r, &key, &feed));
    let mut w = Wire::hello(&r);
    ok(&w.call("launcher.ensureHost", json!([])));
    let checked = ok(&w.call("launcher.check", json!([{"tools": false}]))).clone();
    let read = ok(&w.call("launcher.updates", json!([{"tools": false}]))).clone();
    assert!(checked.get("tools").is_none() && read.get("tools").is_none(), "{checked} {read}");
    assert!(checked["tracks"].is_array() && read["tracks"].is_array(), "{checked} {read}");
    assert!(asks(&r).is_empty(), "{:?}", asks(&r));
}

#[test]
fn the_launcher_names_no_installer_of_its_own() {
    // What installs a tool is the host's (Genie's own per-version installers, the package managers it drives): the
    // launcher's source never names one, so nothing can install from the launcher process.
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    for e in std::fs::read_dir(&dir).unwrap().flatten() {
        let text = std::fs::read_to_string(e.path()).unwrap();
        for word in ["winget", "pacman", "apt-get", "npm ", "rustup", "choco", "toolchain.update", "toolchain.install"] {
            assert!(!text.contains(word), "{} names {word}", e.path().display());
        }
    }
}

//! UPDATES FROM THE LAUNCHER (Tynn #1058, slice L6). The spec's "The update flow, per component", and the owner's rules
//! (2026-11-26): each item updates on its own; a host update always comes with its client; the client, the browser (and
//! later GApps) update without the host upgrading or shutting down.
//!
//! - The feed: GitHub's REST release list (here a local one, tests/common/feed.rs) read with an ETag, per channel.
//! - A check downloads and verifies what is newer into `<build>.partial`, then its folder; nothing is applied by a check.
//! - A client (or browser) update: pointed at; open windows stay on their build and are told; the host is never touched.
//! - A host update: the host's own drain and stop, the launcher waits for its pid, points, starts the new host, which
//!   restores each agent once. A new host that does not answer is ended and the old one is back, restoring the agents.
//! - The launcher's own update: the new launcher takes the pipe from the old; one that does not is ended and the old kept.
//!
//! Every launcher here reads the local feed (GENIE_LAUNCHER_FEED), checks only when asked (GENIE_LAUNCHER_AUTO_CHECK=0),
//! and is given short bounds where a test waits for a failure (GENIE_LAUNCHER_HOST_READY_MS, GENIE_LAUNCHER_HANDOVER_MS).
mod common;

use common::feed::Feed;
use common::live::*;
use common::*;
use genie_launcher::layout::{launcher_executable_name, Roots};
use genie_launcher::spawn::pid_alive;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

const OLD: &str = "2026.11.25-1";
const NEW: &str = "2026.11.26-1";

/// A launcher in `r` reading `feed`, with what the test adds.
fn launcher_reading(r: &Roots, key: &ed25519_dalek::SigningKey, feed: &Feed, program: Option<&Path>, extra: &[(&str, &str)]) -> Command {
    let mut c = match program {
        Some(p) => genie_at(p, r, key),
        None => genie_in(r, key),
    };
    c.env("GENIE_LAUNCHER_FEED", feed.url()).env("GENIE_LAUNCHER_AUTO_CHECK", "0");
    for (k, v) in extra {
        c.env(k, v);
    }
    c
}

fn state(r: &Roots) -> Value {
    serde_json::from_str(&std::fs::read_to_string(r.state_file()).expect("state.json")).expect("state.json is JSON")
}

fn current(r: &Roots, track: &str) -> Value {
    state(r)["tracks"][track]["current"].clone()
}

/// The fake host's journal: (verb, pid, the rest of the line).
fn journal(r: &Roots) -> Vec<(String, u32, String)> {
    std::fs::read_to_string(r.data.join("journal.txt"))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| {
            let mut parts = l.splitn(3, ' ');
            let verb = parts.next()?.to_string();
            let pid = parts.next()?.parse().ok()?;
            Some((verb, pid, parts.next().unwrap_or("").to_string()))
        })
        .collect()
}

fn verbs(r: &Roots) -> Vec<String> {
    journal(r).into_iter().map(|(v, _, _)| v).collect()
}

fn ok(v: &Value) -> &Value {
    assert_eq!(v["ok"], true, "{v}");
    &v["value"]
}

/// The track's row in a `launcher.check` / `launcher.updates` answer.
fn row<'a>(answer: &'a Value, track: &str) -> &'a Value {
    answer["tracks"].as_array().and_then(|rows| rows.iter().find(|t| t["track"] == track)).unwrap_or_else(|| panic!("no {track} row in {answer}"))
}

fn host_pid(r: &Roots) -> Option<u32> {
    genie_launcher::host::read_record(r).filter(|h| pid_alive(h.pid)).map(|h| h.pid)
}

fn host_build(r: &Roots) -> Option<String> {
    genie_launcher::host::read_record(r).filter(|h| pid_alive(h.pid)).map(|h| h.build)
}

// --- the feed ---------------------------------------------------------------------------------------------------------

#[test]
fn a_check_reads_the_feed_with_an_etag_per_channel_and_applies_nothing() {
    let _one = one_at_a_time();
    let (base, r, key) = setup("u-feed");
    install_fakes(&r, &key, &base);
    let feed = Feed::start(&base.join("feed"));
    write_package(&feed.dir, &key, &fake_client_package(NEW));
    feed.publish("client", NEW, false);
    let dev = "2026.11.27-1";
    let mut pre = fake_client_package(dev);
    pre.channel = "dev";
    write_package(&feed.dir, &key, &pre);
    feed.publish("client", dev, true);
    let _l = start_with(&r, &key, launcher_reading(&r, &key, &feed, None, &[]));
    let mut w = Wire::hello(&r);

    let first = w.call("launcher.check", json!([]));
    let client = row(ok(&first), "client");
    assert_eq!(client["current"], OLD, "{first}");
    assert_eq!(client["offer"]["build"], NEW, "stable reads full releases only: {first}");
    assert_eq!(client["state"], "ready", "downloaded and verified: {first}");
    assert!(r.code.join("client").join(NEW).join(".complete").is_file(), "the build's folder is complete");
    assert!(!r.code.join("client").join(format!("{NEW}.partial")).exists(), "no partial folder is left");
    assert_eq!(current(&r, "client"), OLD, "a check applies nothing");

    let again = w.call("launcher.check", json!([]));
    assert_eq!(row(ok(&again), "client")["offer"]["build"], NEW, "{again}");
    let hits = feed.hits();
    assert_eq!(hits.lists, 2, "{hits:?}");
    assert_eq!(hits.not_modified, 1, "the second list is a 304 by its ETag: {hits:?}");
    assert_eq!(hits.assets.iter().filter(|a| a.contains(NEW)).count(), 3, "what is downloaded is not downloaded again: {hits:?}");

    ok(&w.call("launcher.channel", json!([{"channel": "dev"}])));
    assert_eq!(state(&r)["tracks"]["client"]["channel"], "dev");
    let dev_check = w.call("launcher.check", json!([]));
    assert_eq!(row(ok(&dev_check), "client")["offer"]["build"], dev, "dev reads prereleases too: {dev_check}");
}

#[test]
fn an_update_whose_signature_is_not_genies_installs_nothing_and_says_so() {
    let _one = one_at_a_time();
    let (base, r, key) = setup("u-sig");
    install_fakes(&r, &key, &base);
    let feed = Feed::start(&base.join("feed"));
    let stranger = throwaway_key();
    write_package(&feed.dir, &stranger, &fake_client_package(NEW));
    feed.publish("client", NEW, false);
    let _l = start_with(&r, &key, launcher_reading(&r, &key, &feed, None, &[]));
    let mut w = Wire::hello(&r);
    let check = w.call("launcher.check", json!([]));
    let client = row(ok(&check), "client");
    assert_eq!(client["state"], "refused", "{check}");
    let why = client["why"].as_str().unwrap_or("");
    assert!(why.contains("This update's signature is not Genie's. Nothing was installed."), "{why}");
    assert!(why.contains("client") && why.contains(NEW), "the words name the track and the build: {why}");
    assert!(!r.code.join("client").join(NEW).exists() && !r.code.join("client").join(format!("{NEW}.partial")).exists(), "nothing landed");
    let applied = w.call("launcher.apply", json!([{"track": "client"}]));
    assert_eq!(applied["ok"], false, "nothing ready is never applied: {applied}");
    assert_eq!(current(&r, "client"), OLD);
}

// --- the client: open windows stay, the host is never touched ----------------------------------------------------------

#[test]
fn a_client_update_leaves_open_windows_alone_and_the_next_window_runs_the_new_build() {
    let _one = one_at_a_time();
    let (base, r, key) = setup("u-client");
    install_fakes(&r, &key, &base);
    let feed = Feed::start(&base.join("feed"));
    write_package(&feed.dir, &key, &fake_client_package(NEW));
    feed.publish("client", NEW, false);
    let _l = start_with(&r, &key, launcher_reading(&r, &key, &feed, None, &[]));
    let mut w = Wire::hello(&r);
    let (host, window) = host_and_staying_client(&r, &mut w);

    ok(&w.call("launcher.check", json!([])));
    let applied = w.call("launcher.apply", json!([{"track": "client"}]));
    assert_eq!(ok(&applied)["build"], NEW, "{applied}");
    std::thread::sleep(Duration::from_millis(1500));
    assert!(pid_alive(window), "the open window keeps running on its build");
    let told = std::fs::read_to_string(r.data.join(format!("client-update-ready-{window}.txt"))).unwrap_or_default();
    assert!(told.contains(NEW), "the open window is told an update is ready: {told:?}");
    assert!(r.code.join("client").join(OLD).join(".complete").is_file(), "the build the open window runs is kept");
    assert_eq!(current(&r, "client"), NEW);
    assert_eq!(state(&r)["tracks"]["client"]["previous"], OLD);
    assert_eq!(host_pid(&r), Some(host), "the host was not touched");

    std::fs::write(r.data.join("fake-client-mode.txt"), "").unwrap();
    ok(&w.call("launcher.openWindow", json!([])));
    wait_for("the next window ran", 15, || std::fs::read_to_string(r.data.join("client-env.txt")).map(|t| t.lines().count() >= 2).unwrap_or(false));
    let env = std::fs::read_to_string(r.data.join("client-env.txt")).unwrap();
    let last = env.lines().last().unwrap();
    let new_dir = r.code.join("client").join(NEW).display().to_string();
    assert!(last.contains(&new_dir), "the next window is the new build ({new_dir}): {last}");
}

#[test]
fn a_client_or_browser_update_never_touches_the_hosts_pid() {
    let _one = one_at_a_time();
    let (base, r, key) = setup("u-hostpid");
    install_fakes(&r, &key, &base);
    let feed = Feed::start(&base.join("feed"));
    write_package(&feed.dir, &key, &fake_client_package(NEW));
    feed.publish("client", NEW, false);
    write_package(&feed.dir, &key, &browser_package(NEW));
    feed.publish("browser", NEW, false);
    let _l = start_with(&r, &key, launcher_reading(&r, &key, &feed, None, &[]));
    let mut w = Wire::hello(&r);
    let host = ok(&w.call("launcher.ensureHost", json!([])))["pid"].as_u64().unwrap() as u32;

    ok(&w.call("launcher.check", json!([])));
    ok(&w.call("launcher.apply", json!([{"track": "client"}])));
    ok(&w.call("launcher.apply", json!([{"track": "browser"}])));
    std::thread::sleep(Duration::from_secs(2));
    assert_eq!(host_pid(&r), Some(host), "the same host, still running");
    assert_eq!(host_build(&r).as_deref(), Some(OLD));
    assert_eq!(verbs(&r), vec!["boot".to_string()], "the host booted once and was never drained, stopped or restarted");
    assert!(!r.data.join("host-clean-exit.txt").exists(), "the host never exited");
    assert_eq!(current(&r, "client"), NEW);
    assert_eq!(current(&r, "browser"), NEW);
    assert_eq!(current(&r, "host"), OLD);
}

#[test]
fn retention_keeps_current_and_previous_and_deletes_what_nothing_runs() {
    let _one = one_at_a_time();
    let (base, r, key) = setup("u-retain");
    install_fakes(&r, &key, &base);
    let feed = Feed::start(&base.join("feed"));
    let _l = start_with(&r, &key, launcher_reading(&r, &key, &feed, None, &[]));
    let mut w = Wire::hello(&r);
    // Each client with its browser: the browser runs on the client build its manifest names, so a client build a kept
    // browser needs is kept too.
    for build in [NEW, "2026.11.27-1"] {
        write_package(&feed.dir, &key, &fake_client_package(build));
        feed.publish("client", build, false);
        write_package(&feed.dir, &key, &browser_package(build));
        feed.publish("browser", build, false);
        ok(&w.call("launcher.check", json!([])));
        ok(&w.call("launcher.apply", json!([{"track": "client"}])));
        ok(&w.call("launcher.apply", json!([{"track": "browser"}])));
    }
    assert_eq!(current(&r, "client"), "2026.11.27-1");
    assert_eq!(state(&r)["tracks"]["client"]["previous"], NEW);
    assert!(r.code.join("client").join(NEW).is_dir(), "previous is kept (a rollback goes there)");
    assert!(!r.code.join("client").join(OLD).exists(), "the client build before previous, run by nothing, is deleted");
    assert!(!r.code.join("browser").join(OLD).exists(), "and the browser's");
    assert!(r.code.join("browser").join(NEW).is_dir() && r.code.join("browser").join("2026.11.27-1").is_dir());
}

#[test]
fn a_new_client_that_exits_at_once_three_times_running_goes_back_to_previous() {
    let _one = one_at_a_time();
    let (base, r, key) = setup("u-client-back");
    install_fakes(&r, &key, &base);
    let feed = Feed::start(&base.join("feed"));
    write_package(&feed.dir, &key, &fake_client_package(NEW));
    feed.publish("client", NEW, false);
    let _l = start_with(&r, &key, launcher_reading(&r, &key, &feed, None, &[]));
    let mut w = Wire::hello(&r);
    ok(&w.call("launcher.check", json!([])));
    ok(&w.call("launcher.apply", json!([{"track": "client"}])));
    // The fake client exits at once and never attaches: a build that does not come up.
    for _ in 0..3 {
        ok(&w.call("launcher.openWindow", json!([])));
        std::thread::sleep(Duration::from_millis(1500));
    }
    wait_for("the client went back to previous", 15, || current(&r, "client") == OLD);
    let updates = ok(&w.call("launcher.updates", json!([]))).clone();
    let said = updates["said"].as_str().unwrap_or("");
    assert!(said.contains(NEW) && said.contains(OLD), "the next window is told why: {updates}");
}

// --- the host: drain, stop, wait for the pid, point, start, restore once; or back ------------------------------------

fn host_update_ready(name: &str, extra: &[(&str, &str)], new_mode: Option<&str>) -> (PathBuf, Roots, ed25519_dalek::SigningKey, Feed, Launcher, Wire, u32) {
    let (base, r, key) = setup(name);
    install_fakes(&r, &key, &base);
    if let Some(mode) = new_mode {
        std::fs::write(r.data.join(format!("fake-host-mode-{NEW}.txt")), mode).unwrap();
    }
    let feed = Feed::start(&base.join("feed"));
    write_package(&feed.dir, &key, &fake_host_package(NEW));
    feed.publish("host", NEW, false);
    write_package(&feed.dir, &key, &fake_client_package(NEW));
    feed.publish("client", NEW, false);
    let l = start_with(&r, &key, launcher_reading(&r, &key, &feed, None, extra));
    let mut w = Wire::hello(&r);
    let old = ok(&w.call("launcher.ensureHost", json!([])))["pid"].as_u64().unwrap() as u32;
    let check = w.call("launcher.check", json!([]));
    let host = row(ok(&check), "host");
    assert_eq!(host["offer"]["build"], NEW, "{check}");
    assert_eq!(host["state"], "ready", "{check}");
    assert_eq!(host["restartsHost"], true, "{check}");
    assert_eq!(host["withClient"], NEW, "a host update comes with its client: {check}");
    assert_eq!(current(&r, "host"), OLD, "a host update waits for a person's Install");
    assert_eq!(host_pid(&r), Some(old));
    (base, r, key, feed, l, w, old)
}

#[test]
fn a_host_update_drains_stops_waits_for_the_pid_points_starts_and_restores_once() {
    let _one = one_at_a_time();
    let (_base, r, _key, _feed, _l, mut w, old) = host_update_ready("u-host", &[], None);
    let applied = w.call("launcher.apply", json!([{"track": "host"}]));
    ok(&applied);
    wait_for("the new host runs", 60, || host_build(&r).as_deref() == Some(NEW));
    wait_for("the new host restored the agents", 20, || verbs(&r).iter().any(|v| v == "restore"));
    let j = journal(&r);
    let got: Vec<&str> = j.iter().map(|(v, _, _)| v.as_str()).collect();
    assert_eq!(got, vec!["boot", "drain", "stop", "apply-asked", "exit", "boot", "restore"], "{j:?}");
    assert!(j[..5].iter().all(|(_, pid, _)| *pid == old), "the old host drained, stopped and exited: {j:?}");
    let (_, new_pid, boot) = &j[5];
    assert_ne!(*new_pid, old);
    assert!(boot.starts_with(&format!("{NEW} current={NEW} ")), "pointed before it was started: {boot}");
    assert!(boot.ends_with("prev-alive=false"), "started only once the old pid had gone: {boot}");
    assert!(j[3].2.ends_with("ok"), "the launcher took the host's apply: {j:?}");
    assert_eq!(j[6].1, *new_pid, "the new host restored");
    assert_eq!(current(&r, "host"), NEW);
    assert_eq!(state(&r)["tracks"]["host"]["previous"], OLD);
    assert_eq!(current(&r, "client"), NEW, "the host's client came with it");
    // The swap says it is done once the new host has answered its hello (a moment after it wrote host.json).
    wait_for("the swap said it is done", 20, || ok(&w.call("launcher.updates", json!([])))["hostUpdate"]["phase"] != "starting");
    let updates = ok(&w.call("launcher.updates", json!([]))).clone();
    assert_eq!(updates["hostUpdate"]["phase"], "done", "{updates}");
    assert_eq!(updates["hostUpdate"]["to"], NEW, "{updates}");
}

#[test]
fn a_new_host_that_never_answers_is_ended_and_the_old_one_comes_back_with_the_agents() {
    let _one = one_at_a_time();
    let (_base, r, _key, _feed, _l, mut w, old) = host_update_ready("u-host-back", &[("GENIE_LAUNCHER_HOST_READY_MS", "4000")], Some("hang"));
    ok(&w.call("launcher.apply", json!([{"track": "host"}])));
    wait_for("the old build runs again", 60, || host_build(&r).as_deref() == Some(OLD) && host_pid(&r) != Some(old));
    wait_for("the agents were restored", 20, || verbs(&r).iter().any(|v| v == "restore"));
    let j = journal(&r);
    let got: Vec<&str> = j.iter().map(|(v, _, _)| v.as_str()).collect();
    assert_eq!(got, vec!["boot", "drain", "stop", "apply-asked", "exit", "boot", "hang", "boot", "restore"], "{j:?}");
    let hung = j[5].1;
    assert!(j[5].2.starts_with(NEW), "the new build was tried: {j:?}");
    assert!(!pid_alive(hung), "the host that never answered was ended");
    assert!(j[7].2.starts_with(&format!("{OLD} current={OLD} ")), "pointed back before the old one started: {j:?}");
    assert_eq!(j[8].1, j[7].1, "the old build restored the agents, once (the record was not spent by the host that hung)");
    assert_eq!(current(&r, "host"), OLD);
    assert_eq!(current(&r, "client"), OLD, "its client went back with it");
    let updates = ok(&w.call("launcher.updates", json!([]))).clone();
    assert_eq!(updates["hostUpdate"]["phase"], "rolled-back", "{updates}");
    let said = updates["hostUpdate"]["said"].as_str().unwrap_or("");
    assert!(said.contains(&format!("The new host did not start within a minute, so Genie went back to {OLD}. Your agents are back.")), "{said}");
    assert!(said.contains("genie-host.log"), "the host's log is named: {said}");
}

// --- the launcher's own update: the pipe handed over, or the old one kept ---------------------------------------------

/// The launcher as installed, run from there: on Linux `<code>/launcher/<OLD>/genie` (with `~/.local/bin/genie` in the
/// test's own home), on Windows a copy standing for the NSIS folder's Genie.exe.
fn installed_launcher(base: &Path, r: &Roots, key: &ed25519_dalek::SigningKey) -> PathBuf {
    let me = std::fs::read(env!("CARGO_BIN_EXE_genie")).unwrap();
    if cfg!(windows) {
        let nsis = base.join("nsis");
        std::fs::create_dir_all(&nsis).unwrap();
        let exe = nsis.join("Genie.exe");
        std::fs::write(&exe, me).unwrap();
        exe
    } else {
        // The CLI's install reads every track of its profile from the folder: the fakes, and this launcher.
        let from = base.join("launcher-from");
        write_package(&from, key, &fake_host_package(OLD));
        write_package(&from, key, &fake_client_package(OLD));
        write_package(&from, key, &browser_package(OLD));
        write_package(&from, key, &Package::new("launcher", OLD, vec![(launcher_executable_name().into(), me)]));
        let out = run(genie_in(r, key).env("HOME", base.join("home")).env_remove("XDG_DATA_HOME").args(["install", "--profile", "both", "--yes", "--from"]).arg(&from));
        assert!(out.status.success(), "{}", text(&out));
        r.code.join("launcher").join(OLD).join("genie")
    }
}

fn self_update_ready(name: &str, program_bytes: Vec<u8>, extra: &[(&str, &str)]) -> (PathBuf, Roots, PathBuf, Feed, Launcher, u32) {
    let (base, r, key) = setup(name);
    if cfg!(windows) {
        install_fakes(&r, &key, &base);
    }
    let exe = installed_launcher(&base, &r, &key);
    let feed = Feed::start(&base.join("feed"));
    write_package(&feed.dir, &key, &Package::new("launcher", NEW, vec![(launcher_executable_name().into(), program_bytes)]));
    feed.publish("launcher", NEW, false);
    let mut c = launcher_reading(&r, &key, &feed, Some(&exe), extra);
    c.env("HOME", base.join("home")).env_remove("XDG_DATA_HOME");
    let l = start_with(&r, &key, c);
    let old = l.child.id();
    let mut w = Wire::hello(&r);
    let check = w.call("launcher.check", json!([]));
    let row = row(ok(&check), "launcher");
    assert_eq!(row["offer"]["build"], NEW, "{check}");
    assert_eq!(row["state"], "ready", "{check}");
    (base, r, exe, feed, l, old)
}

#[test]
fn a_launcher_self_update_hands_over_the_pipe_and_the_old_one_exits() {
    let _one = one_at_a_time();
    let me = std::fs::read(env!("CARGO_BIN_EXE_genie")).unwrap();
    let (base, r, exe, _feed, mut l, old) = self_update_ready("u-self", me, &[]);
    let host = ok(&Wire::hello(&r).call("launcher.ensureHost", json!([])))["pid"].as_u64().unwrap() as u32;
    let mut w = Wire::hello(&r);
    let applied = w.call("launcher.apply", json!([{"track": "launcher"}]));
    ok(&applied);
    wait_for("a new launcher answers in launcher.json", 30, || launcher_pid(&r).map_or(false, |p| p != old && pid_alive(p)));
    wait_for("the old launcher exited", 30, || matches!(l.child.try_wait(), Ok(Some(_))));
    let new = launcher_pid(&r).unwrap();
    let (_w2, welcome) = Wire::hello_welcome(&r);
    assert_eq!(welcome["pid"], new, "the pipe is the new launcher's: {welcome}");
    assert_eq!(host_pid(&r), Some(host), "the host was not touched");
    assert_eq!(current(&r, "launcher"), NEW);
    if cfg!(windows) {
        assert!(exe.is_file(), "Genie.exe is where every shortcut points");
        wait_for("Genie.exe.old is cleared once the old launcher has gone", 15, || !exe.with_file_name("Genie.exe.old").exists());
    } else {
        let link = std::fs::read_link(base.join("home/.local/bin/genie")).expect("~/.local/bin/genie");
        assert_eq!(link, r.code.join("launcher").join(NEW).join("genie"), "the link points at the new build");
        #[cfg(unix)]
        assert_eq!(std::fs::read_link(format!("/proc/{new}/exe")).unwrap(), r.code.join("launcher").join(NEW).join("genie"), "the new launcher runs from its build");
        assert_eq!(state(&r)["tracks"]["launcher"]["previous"], OLD);
    }
}

#[test]
fn a_new_launcher_that_does_not_take_the_pipe_is_ended_and_the_old_one_kept() {
    let _one = one_at_a_time();
    let (base, r, exe, _feed, mut l, old) = self_update_ready("u-self-back", fake_bytes(), &[("GENIE_LAUNCHER_HANDOVER_MS", "4000")]);
    let before = std::fs::read(&exe).unwrap();
    let was = current(&r, "launcher");
    let mut w = Wire::hello(&r);
    ok(&w.call("launcher.apply", json!([{"track": "launcher"}])));
    wait_for("the new launcher was started", 20, || r.data.join("handover-pid.txt").is_file());
    let new: u32 = std::fs::read_to_string(r.data.join("handover-pid.txt")).unwrap().trim().parse().unwrap();
    wait_for("the new launcher that did not take the pipe was ended", 30, || !pid_alive(new));
    std::thread::sleep(Duration::from_millis(500));
    assert!(matches!(l.child.try_wait(), Ok(None)), "the old launcher is still running");
    assert_eq!(launcher_pid(&r), Some(old), "launcher.json names the old launcher");
    let (mut w2, welcome) = Wire::hello_welcome(&r);
    assert_eq!(welcome["pid"], old, "the old launcher answers the pipe: {welcome}");
    assert_eq!(current(&r, "launcher"), was, "previous is restored");
    let updates = ok(&w2.call("launcher.updates", json!([]))).clone();
    let said = row(&updates, "launcher")["why"].as_str().unwrap_or("").to_string();
    assert!(said.contains("did not take over"), "{updates}");
    if cfg!(windows) {
        assert_eq!(std::fs::read(&exe).unwrap(), before, "Genie.exe is the old launcher again");
        assert!(!exe.with_file_name("Genie.exe.old").exists(), "nothing is left beside it");
    } else {
        let link = std::fs::read_link(base.join("home/.local/bin/genie")).expect("~/.local/bin/genie");
        assert_eq!(link, r.code.join("launcher").join(OLD).join("genie"), "the link points at the old build again");
    }
}

#[test]
fn a_host_update_opens_genie_again_when_a_window_was_open_on_the_new_client() {
    // Under the launcher a window leaves when the host installs (src/core/quit.ts installQuit): the launcher swaps the
    // host, then opens Genie again, on the client the host came with (the owner: "drain and swap the host, then refresh
    // the UI"). The fake client stays attached until it is ended here, as the real one exits on the install.
    let _one = one_at_a_time();
    let (_base, r, _key, _feed, _l, mut w, _old) = host_update_ready("u-host-window", &[], None);
    std::fs::write(r.data.join("fake-client-mode.txt"), "stay").unwrap();
    let window = ok(&w.call("launcher.openWindow", json!([])))["pid"].as_u64().unwrap() as u32;
    wait_for("the window attached", 15, || ok(&w.call("launcher.status", json!([])))["clients"].as_array().map_or(false, |c| c.iter().any(|p| p == window)));
    std::fs::write(r.data.join("fake-client-mode.txt"), "").unwrap();
    ok(&w.call("launcher.apply", json!([{"track": "host"}])));
    kill(window);
    wait_for("the new host runs", 60, || host_build(&r).as_deref() == Some(NEW));
    wait_for("Genie was opened again", 30, || std::fs::read_to_string(r.data.join("client-env.txt")).map(|t| t.lines().count() >= 2).unwrap_or(false));
    let env = std::fs::read_to_string(r.data.join("client-env.txt")).unwrap();
    let last = env.lines().last().unwrap();
    assert!(last.starts_with("--open-window"), "{last}");
    let new_dir = r.code.join("client").join(NEW).display().to_string();
    assert!(last.contains(&new_dir), "on the client the host came with ({new_dir}): {last}");
    assert!(last.contains(&format!("hostBuild={NEW}")), "linked to the new host: {last}");
}

#[test]
fn a_host_update_with_no_window_open_opens_none() {
    let _one = one_at_a_time();
    let (_base, r, _key, _feed, _l, mut w, _old) = host_update_ready("u-host-nowindow", &[], None);
    ok(&w.call("launcher.apply", json!([{"track": "host"}])));
    wait_for("the new host runs", 60, || host_build(&r).as_deref() == Some(NEW));
    wait_for("the swap said it is done", 20, || ok(&w.call("launcher.updates", json!([])))["hostUpdate"]["phase"] == "done");
    std::thread::sleep(Duration::from_secs(2));
    assert!(!r.data.join("client-args.txt").exists(), "nobody had Genie open, so it is not opened");
}

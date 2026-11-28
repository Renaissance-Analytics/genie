//! THE TRAY'S "OPEN GENIE BROWSER" (Tynn #1058). Measured in the launcher-install row's end-to-end check (Azure item
//! 1128-033640-233be4, Linux): the item started `genie-client --genie-browser` itself, with nothing to open, and the
//! Browser showed no window (it opens one only for an `open` its host says, and quits after 60 s with none). The item now
//! asks the host, as a client window's Browser row does: `engine.browser open [null, "user-gesture"]`; the host holds it
//! and starts the Browser through the launcher (`launcher.startBrowser`, L4), or says it to the Browser already running.
//! With no host running on a computer that has one, the item starts it first. Driven as the VM rows drive the tray:
//! `launcher.trayAct` with GENIE_LAUNCHER_TRAY_PROBE=1, which runs the item's own handler (tray::act).
mod common;

use common::live::*;
use common::*;
use genie_launcher::layout::Roots;
use serde_json::json;

fn launcher_with_tray_probe(r: &Roots, key: &ed25519_dalek::SigningKey) -> Launcher {
    let mut c = genie_in(r, key);
    c.env("GENIE_LAUNCHER_TRAY_PROBE", "1").env("GENIE_LAUNCHER_AUTO_CHECK", "0");
    start_with(r, key, c)
}

/// What the launcher asked of the host's browser service (the fake host's `browser.txt`).
fn browser_asks(r: &Roots) -> Vec<String> {
    std::fs::read_to_string(r.data.join("browser.txt")).unwrap_or_default().lines().map(str::to_string).collect()
}

/// The programs the launcher started with --genie-browser itself (the fake client's `client-args.txt`).
fn browsers_started_by_the_launcher(r: &Roots) -> usize {
    std::fs::read_to_string(r.data.join("client-args.txt")).unwrap_or_default().lines().filter(|l| l.contains("--genie-browser")).count()
}

#[test]
fn with_a_host_running_the_item_asks_it_to_open_the_browser_as_the_persons_gesture() {
    let _one = one_at_a_time();
    let (base, r, key) = setup("t-tray-browser");
    install_fakes(&r, &key, &base);
    let _l = launcher_with_tray_probe(&r, &key);
    let mut w = Wire::hello(&r);
    let h = w.call("launcher.ensureHost", json!([]));
    assert_eq!(h["ok"], true, "{h}");
    let host = h["value"]["pid"].as_u64().unwrap();
    let acted = w.call("launcher.trayAct", json!([{"action": "openBrowser"}]));
    assert_eq!(acted["ok"], true, "{acted}");
    let want = format!("browser-open {host} [null,\"user-gesture\"]");
    wait_for(&format!("the host was asked: {want}; it was asked {:?}", browser_asks(&r)), 10, || browser_asks(&r).iter().any(|l| l == &want));
    std::thread::sleep(std::time::Duration::from_millis(500));
    // The Browser is the host's to ask for (it asks launcher.startBrowser): the item starts no Browser with nothing to open.
    assert_eq!(browsers_started_by_the_launcher(&r), 0, "the item started a Browser itself");
}

#[test]
fn with_no_host_running_the_item_starts_this_computers_host_and_then_asks_it() {
    let _one = one_at_a_time();
    let (base, r, key) = setup("t-tray-browser-nohost");
    install_fakes(&r, &key, &base);
    let _l = launcher_with_tray_probe(&r, &key);
    let mut w = Wire::hello(&r);
    assert!(genie_launcher::host::read_record(&r).is_none(), "no host before the item");
    let acted = w.call("launcher.trayAct", json!([{"action": "openBrowser"}]));
    assert_eq!(acted["ok"], true, "{acted}");
    wait_for(&format!("the host started and was asked to open the Browser; it was asked {:?}", browser_asks(&r)), 20, || {
        browser_asks(&r).iter().any(|l| l.starts_with("browser-open ") && l.ends_with(" [null,\"user-gesture\"]"))
    });
    let host = genie_launcher::host::read_record(&r).expect("a host runs").pid;
    assert!(browser_asks(&r).contains(&format!("browser-open {host} [null,\"user-gesture\"]")), "{:?}", browser_asks(&r));
    assert_eq!(browsers_started_by_the_launcher(&r), 0, "the item started a Browser itself");
}

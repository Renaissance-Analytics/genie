//! THE LOGON TABLE AGAINST THE LAUNCHER'S PLAN (Tynn #1058 L5). test/fixtures/logon-table.json is read here and by
//! test/logon-table.test.ts (against src/core/logon.ts `logonEntry`, unchanged), so the launcher decides logon exactly as
//! the client did. Then the entry itself: the Run value's command and the autostart file run the launcher with --logon,
//! and applying the inputs on disk writes it when Genie should start at logon and removes it when not.
mod common;

use common::*;
use genie_launcher::logon::{self, at_logon, logon_entry, AtLogon, LogonEntry, LogonInput, LogonSettings, Place};
use serde_json::Value;
use std::path::PathBuf;

fn table() -> Vec<Value> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/logon-table.json");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("the shared table {} could not be read: {e}", path.display()));
    let v: Value = serde_json::from_str(&text).expect("the shared table is JSON");
    v["rows"].as_array().expect("rows").clone()
}

fn b(v: &Value, key: &str) -> bool {
    v[key].as_bool().unwrap_or_else(|| panic!("{key} in {v}"))
}

#[test]
fn the_table_holds_the_four_rows_of_the_logon_decision() {
    let rows = table();
    let four: Vec<(bool, bool)> = rows.iter().filter(|r| !b(r, "startMinimized")).map(|r| (b(r, "leftRunning"), b(r, "setting"))).collect();
    assert_eq!(four, vec![(true, true), (true, false), (false, true), (false, false)], "left running / shut down x setting on / off");
}

#[test]
fn logon_entry_gives_the_tables_entry_for_every_row() {
    for row in table() {
        let input = LogonInput { left_running: b(&row, "leftRunning"), setting: b(&row, "setting"), start_minimized: b(&row, "startMinimized") };
        let want = LogonEntry { launch_at_login: b(&row["entry"], "launchAtLogin"), start_minimized: b(&row["entry"], "startMinimized") };
        assert_eq!(logon_entry(input), want, "{}", row["name"]);
    }
}

#[test]
fn the_launchers_run_at_logon_starts_the_host_and_opens_a_window_as_the_table_says() {
    for row in table() {
        let input = LogonInput { left_running: b(&row, "leftRunning"), setting: b(&row, "setting"), start_minimized: b(&row, "startMinimized") };
        let want = AtLogon { start_host: b(&row["atLogon"], "startHost"), open_window: b(&row["atLogon"], "openWindow") };
        assert_eq!(at_logon(logon_entry(input)), want, "{}", row["name"]);
    }
}

#[test]
fn the_entry_runs_the_launcher_with_logon() {
    let exe = if cfg!(windows) { r"C:\Users\a b\AppData\Local\Programs\Genie\Genie.exe" } else { "/home/a b/.local/bin/genie" };
    let cmd = logon::run_command(exe);
    assert_eq!(cmd, format!("\"{exe}\" --logon"), "the Run value: the launcher, quoted, then --logon");
    let file = logon::desktop_entry("/home/a b/.local/bin/genie");
    assert!(file.starts_with("[Desktop Entry]\n"), "{file}");
    assert!(file.contains("\nExec=\"/home/a b/.local/bin/genie\" --logon\n"), "{file}");
    assert!(file.contains("\nType=Application\n") && file.contains("\nName=Genie\n") && file.contains("\nX-GNOME-Autostart-enabled=true\n"), "{file}");
    assert!(!file.contains("Hidden=true"), "{file}");
    // A path with a quote, a dollar or a backslash is escaped as the desktop entry spec says.
    assert!(logon::desktop_entry("/opt/a\"$b\\c/genie").contains("Exec=\"/opt/a\\\"\\$b\\\\c/genie\" --logon"));
}

fn test_place(base: &std::path::Path) -> Place {
    if cfg!(windows) {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        Place::WindowsRun { key: format!(r"Software\GenieLauncherTest\Run-{}-{nanos}", std::process::id()), value: logon::RUN_VALUE.to_string() }
    } else {
        Place::Autostart { file: base.join("config/autostart/genie.desktop") }
    }
}

#[test]
fn applying_writes_the_entry_when_genie_starts_at_logon_and_removes_it_when_not() {
    let base = temp_dir("logon-apply");
    let r = roots(&base);
    let place = test_place(&base);
    let exe = if cfg!(windows) { r"C:\Genie\Genie.exe" } else { "/opt/genie/genie" };
    // Shut down, setting off: no entry.
    logon::set_left_running(&r, false).expect("the mark");
    logon::write_settings(&r, LogonSettings { setting: false, start_minimized: false }).expect("the settings");
    logon::apply(&r, &place, exe).expect("applied");
    assert_eq!(logon::read_entry(&place), None, "shut down with the setting off: stays down, no entry");
    // Setting on: the entry runs this launcher with --logon.
    logon::write_settings(&r, LogonSettings { setting: true, start_minimized: false }).expect("the settings");
    assert_eq!(logon::read_settings(&r), LogonSettings { setting: true, start_minimized: false }, "the settings read back");
    logon::apply(&r, &place, exe).expect("applied");
    let entry = logon::read_entry(&place).expect("the entry is there with the setting on");
    assert!(entry.contains(&format!("\"{exe}\" --logon")), "{entry}");
    // Setting off again, but the host left running: still there.
    logon::write_settings(&r, LogonSettings { setting: false, start_minimized: false }).expect("the settings");
    logon::set_left_running(&r, true).expect("the mark");
    assert!(logon::left_running(&r), "the mark reads back");
    assert!(r.runtime_dir().join("left-running").exists(), "the mark is the P6 file");
    logon::apply(&r, &place, exe).expect("applied");
    assert!(logon::read_entry(&place).is_some(), "a host left running comes back at logon");
    // Everything shut down: gone.
    logon::set_left_running(&r, false).expect("the mark");
    logon::apply(&r, &place, exe).expect("applied");
    assert_eq!(logon::read_entry(&place), None, "shut down, setting off: the entry is removed");
    cleanup(&place);
}

#[cfg(windows)]
fn cleanup(place: &Place) {
    if let Place::WindowsRun { key, .. } = place {
        let _ = std::process::Command::new(r"C:\Windows\System32\reg.exe").args(["delete", &format!(r"HKCU\{key}"), "/f"]).output();
    }
}

#[cfg(not(windows))]
fn cleanup(_place: &Place) {}

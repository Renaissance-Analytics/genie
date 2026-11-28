//! THE MIGRATION FROM THE SINGLE-APP INSTALL (Tynn #1058 L9, the bridge). The bridge release is installed by the outgoing
//! Genie's own updater; the launcher's first run then:
//!
//! - ADOPTS the host that install left running (its executable is P6-1's copy under `<data root>/host/`, which the
//!   installer never touched): its pid is kept, and `state.json` records `host.current = adopted`, the build the bridge
//!   installed kept as `previous` for when that host has gone;
//! - REPLACES the logon entry the single app wrote (the HKCU Run value Electron named by the app's id, found by its path
//!   and arguments; the autostart file in place): one entry, the launcher's, never two;
//! - CARRIES OVER "start on logon" and "start minimised" from that entry, as Genie 2 did from Genie 1's, unless the client
//!   has already said them to the launcher.
mod common;

use common::live::*;
use common::*;
use genie_launcher::layout::{host_executable_name, Roots, Track};
use genie_launcher::logon::{self, LogonSettings, Place};
use genie_launcher::migrate;
use genie_launcher::spawn::pid_alive;
use genie_launcher::state;
use serde_json::json;
use std::process::{Child, Command, Stdio};

/// The single-app install's host: its own copy under `<data root>/host/` (P6-1), started by the old window, not by any
/// launcher, reporting the old app's build.
fn start_single_app_host(r: &Roots) -> (Child, std::path::PathBuf) {
    let copy = r.data.join("host").join("runtime-39.2.7-host");
    std::fs::create_dir_all(&copy).unwrap();
    let exe = copy.join(host_executable_name());
    std::fs::write(&exe, fake_bytes()).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let _ = std::fs::remove_file(r.runtime_dir().join("host.json"));
    let child = Command::new(&exe)
        .env("GENIE_HOME", &r.data)
        .env("GENIE_HOST_BUILD", "2.0.0-beta.66.1")
        .env_remove("FAKE_HOST_MODE")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("the single-app host starts");
    let pid = child.id();
    wait_for("the single-app host wrote host.json", 15, || genie_launcher::host::read_record(r).map(|rec| rec.pid == pid).unwrap_or(false));
    (child, copy)
}

fn host_state(r: &Roots) -> state::TrackState {
    state::read(&r.state_file()).unwrap().track(Track::Host.as_str()).cloned().unwrap_or_default()
}

#[test]
fn the_launcher_adopts_the_single_app_host_keeping_its_pid_and_records_adopted() {
    let _one = one_at_a_time();
    let (base, r, key) = setup("adopt");
    install_fakes(&r, &key, &base);
    let (mut old, copy) = start_single_app_host(&r);
    let pid = old.id();
    let _l = start(&r, &key);
    let mut w = Wire::hello(&r);

    let v = w.call("launcher.ensureHost", json!([]));
    assert_eq!(v["ok"], true, "{v}");
    assert_eq!(v["value"]["how"], "adopted", "{v}");
    assert_eq!(v["value"]["pid"].as_u64(), Some(pid as u64), "the host keeps its pid: {v}");
    assert!(pid_alive(pid), "the adopted host is still running");
    let t = host_state(&r);
    assert_eq!(t.current.as_deref(), Some(state::ADOPTED), "host.current records the adoption: {t:?}");
    assert_eq!(t.previous.as_deref(), Some("2026.11.25-1"), "the host the bridge installed waits as previous: {t:?}");
    let journal = std::fs::read_to_string(r.data.join("journal.txt")).unwrap_or_default();
    assert_eq!(journal.matches("boot ").count(), 1, "no second host was started beside it: {journal}");

    // Adopting it again changes nothing: `adopted` never becomes its own previous.
    let again = w.call("launcher.ensureHost", json!([]));
    assert_eq!(again["value"]["pid"].as_u64(), Some(pid as u64), "{again}");
    assert_eq!(host_state(&r), t, "a second adoption leaves the state as it was");

    // Once that host has gone, the launcher starts the host the bridge installed, and the single app's copy goes.
    let stop = w.call("launcher.stopHost", json!([]));
    assert_eq!(stop["value"]["stopped"], true, "{stop}");
    let _ = old.wait();
    let started = w.call("launcher.ensureHost", json!([]));
    assert_eq!(started["ok"], true, "{started}");
    assert_eq!(started["value"]["how"], "started", "{started}");
    assert_eq!(started["value"]["build"], "2026.11.25-1", "{started}");
    let t = host_state(&r);
    assert_eq!(t.current.as_deref(), Some("2026.11.25-1"), "host.current is the installed build again: {t:?}");
    assert_ne!(t.previous.as_deref(), Some(state::ADOPTED), "an adopted host is never a rollback target: {t:?}");
    assert!(!copy.exists(), "the single app's host copy is removed once nothing runs from it");
}

#[test]
fn a_host_the_launcher_started_is_adopted_without_recording_adopted() {
    let _one = one_at_a_time();
    let (base, r, key) = setup("adopt-own");
    install_fakes(&r, &key, &base);
    let _l = start(&r, &key);
    let mut w = Wire::hello(&r);
    let first = w.call("launcher.ensureHost", json!([]));
    assert_eq!(first["value"]["how"], "started", "{first}");
    let again = w.call("launcher.ensureHost", json!([]));
    assert_eq!(again["value"]["how"], "adopted", "{again}");
    let t = host_state(&r);
    assert_eq!(t.current.as_deref(), Some("2026.11.25-1"), "its own host is its current build, not `adopted`: {t:?}");
}

// --- the logon entry and the settings ---------------------------------------------------------------------------

fn test_place(base: &std::path::Path) -> Place {
    if cfg!(windows) {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        Place::WindowsRun { key: format!(r"Software\GenieLauncherTest\Run-{}-{nanos}", std::process::id()), value: logon::RUN_VALUE.to_string() }
    } else {
        Place::Autostart { file: base.join("config/autostart/genie.desktop") }
    }
}

fn exe() -> &'static str {
    if cfg!(windows) {
        r"C:\Users\a b\AppData\Local\Programs\Genie\Genie.exe"
    } else {
        "/home/a b/.local/bin/genie"
    }
}

/// What the single app wrote: on Windows Electron's `setLoginItemSettings` (the value named by the app's id, the path
/// quoted, `--hidden` when start minimised), and Genie 1's beside it; on Linux the autostart file running the AppImage.
fn seed_single_app_entry(place: &Place, start_minimized: bool) {
    let hidden = if start_minimized { " --hidden" } else { "" };
    match place {
        Place::WindowsRun { key, .. } => {
            reg_set(key, "ai.tynn.genie", &format!("\"{}\"{hidden}", exe()));
            reg_set(key, "Someone else", r#""C:\Other\other.exe" --tray"#);
        }
        Place::Autostart { file } => {
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            let text = format!("[Desktop Entry]\nType=Application\nName=Genie\nComment=Genie\nExec=\"/home/a b/Applications/Genie.AppImage\"{hidden}\nHidden=false\nNoDisplay=false\nX-GNOME-Autostart-enabled=true\n");
            std::fs::write(file, text).unwrap();
            std::fs::write(file.parent().unwrap().join("other.desktop"), "[Desktop Entry]\nExec=/usr/bin/other\n").unwrap();
        }
    }
}

/// Every entry at the place that runs Genie (by path, either the launcher's or the single app's).
fn genie_entries(place: &Place) -> Vec<(String, String)> {
    match place {
        Place::WindowsRun { key, .. } => reg_values(key).into_iter().filter(|(_, data)| data.to_lowercase().contains("genie")).collect(),
        Place::Autostart { file } => std::fs::read_dir(file.parent().unwrap())
            .map(|d| d.flatten().map(|e| (e.file_name().to_string_lossy().into_owned(), std::fs::read_to_string(e.path()).unwrap_or_default())).filter(|(_, t)| t.to_lowercase().contains("genie")).collect())
            .unwrap_or_default(),
    }
}

fn others_kept(place: &Place) {
    match place {
        Place::WindowsRun { key, .. } => assert!(reg_values(key).iter().any(|(n, d)| n == "Someone else" && d.contains("other.exe")), "another program's Run value is left alone"),
        Place::Autostart { file } => assert!(file.parent().unwrap().join("other.desktop").exists(), "another program's autostart file is left alone"),
    }
}

#[test]
fn the_logon_entry_is_replaced_never_doubled() {
    let base = temp_dir("migrate-entry");
    let r = roots(&base);
    let place = test_place(&base);
    seed_single_app_entry(&place, true);
    assert_eq!(genie_entries(&place).len(), 1, "the single app's entry is there before");

    let carried = migrate::carry_over(&r, &place, exe()).expect("carried over");
    let entries = genie_entries(&place);
    assert_eq!(entries.len(), 1, "one entry runs Genie: {entries:?}");
    let (_, data) = &entries[0];
    assert!(data.contains(&format!("\"{}\" --logon", exe())), "it is the launcher's, run with --logon: {data}");
    assert!(!data.contains("--hidden") && !data.contains("AppImage"), "nothing of the single app's entry is left in it: {data}");
    if let Place::WindowsRun { key, .. } = &place {
        assert!(reg_values(key).iter().any(|(n, _)| n == logon::RUN_VALUE), "it is the launcher's value, {}", logon::RUN_VALUE);
    }
    assert!(!carried.removed.is_empty(), "what was replaced is said: {:?}", carried.removed);
    others_kept(&place);

    // Run again (a second start, a reinstall): still one.
    migrate::carry_over(&r, &place, exe()).expect("carried over again");
    assert_eq!(genie_entries(&place).len(), 1, "a second migration doubles nothing: {:?}", genie_entries(&place));
    others_kept(&place);
    cleanup(&place);
}

#[test]
fn start_on_logon_and_start_minimised_are_carried_over_from_the_single_apps_entry() {
    // Start minimised on: both settings carried, and the entry stays (it starts the host, no window).
    let base = temp_dir("migrate-settings-min");
    let r = roots(&base);
    let place = test_place(&base);
    seed_single_app_entry(&place, true);
    let carried = migrate::carry_over(&r, &place, exe()).expect("carried over");
    assert_eq!(carried.settings, Some(LogonSettings { setting: true, start_minimized: true }), "{carried:?}");
    assert_eq!(logon::read_settings(&r), LogonSettings { setting: true, start_minimized: true }, "kept where the launcher reads them");
    assert!(logon::read_entry(&place).is_some(), "start on logon stays on");
    cleanup(&place);

    // Start on logon, a window at logon.
    let base = temp_dir("migrate-settings-window");
    let r = roots(&base);
    let place = test_place(&base);
    seed_single_app_entry(&place, false);
    migrate::carry_over(&r, &place, exe()).expect("carried over");
    assert_eq!(logon::read_settings(&r), LogonSettings { setting: true, start_minimized: false });
    cleanup(&place);

    // No entry: both off, and nothing is written.
    let base = temp_dir("migrate-settings-none");
    let r = roots(&base);
    let place = test_place(&base);
    let carried = migrate::carry_over(&r, &place, exe()).expect("carried over");
    assert_eq!(carried.settings, Some(LogonSettings { setting: false, start_minimized: false }), "{carried:?}");
    assert_eq!(logon::read_entry(&place), None, "start on logon was off: no entry");
    cleanup(&place);

    // What the client has already said wins: the single app's entry is replaced by what the settings say now.
    let base = temp_dir("migrate-settings-said");
    let r = roots(&base);
    let place = test_place(&base);
    logon::write_settings(&r, LogonSettings { setting: false, start_minimized: false }).unwrap();
    seed_single_app_entry(&place, true);
    let carried = migrate::carry_over(&r, &place, exe()).expect("carried over");
    assert_eq!(carried.settings, None, "nothing carried over what the client said: {carried:?}");
    assert_eq!(logon::read_settings(&r), LogonSettings { setting: false, start_minimized: false });
    assert!(genie_entries(&place).is_empty(), "the old entry is gone and none is written: {:?}", genie_entries(&place));
    cleanup(&place);

    // A host left running by the single app ("Just close the UI": the same P6 file) still comes back at logon.
    let base = temp_dir("migrate-settings-left");
    let r = roots(&base);
    let place = test_place(&base);
    logon::set_left_running(&r, true).unwrap();
    migrate::carry_over(&r, &place, exe()).expect("carried over");
    assert!(logon::read_entry(&place).is_some(), "the host left running comes back at logon");
    cleanup(&place);
}

#[cfg(windows)]
fn reg_set(key: &str, name: &str, data: &str) {
    let out = Command::new(r"C:\Windows\System32\reg.exe").args(["add", &format!(r"HKCU\{key}"), "/v", name, "/t", "REG_SZ", "/d", data, "/f"]).output().unwrap();
    assert!(out.status.success(), "reg add: {}", String::from_utf8_lossy(&out.stderr));
}

#[cfg(windows)]
fn reg_values(key: &str) -> Vec<(String, String)> {
    migrate::run_values(key)
}

#[cfg(not(windows))]
fn reg_set(_key: &str, _name: &str, _data: &str) {}

#[cfg(not(windows))]
fn reg_values(_key: &str) -> Vec<(String, String)> {
    Vec::new()
}

#[cfg(windows)]
fn cleanup(place: &Place) {
    if let Place::WindowsRun { key, .. } = place {
        let _ = Command::new(r"C:\Windows\System32\reg.exe").args(["delete", &format!(r"HKCU\{key}"), "/f"]).output();
    }
}

#[cfg(not(windows))]
fn cleanup(_place: &Place) {}

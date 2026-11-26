//! LINUX: THE LAUNCHER'S OWN PLACE AND THE DESKTOP ENTRY (the spec's layout table). `genie install --from` with a
//! launcher package beside the others puts the launcher at `<code root>/launcher/<build>/genie`, points `~/.local/bin/genie`
//! at it, and writes `~/.local/share/applications/genie.desktop` (Genie, Genie in doctor mode, the `genie` scheme), each
//! running the launcher. `genie uninstall` stops the host and removes all of it, keeping the data root.
#![cfg(unix)]
mod common;

use common::*;
use genie_launcher::layout::{browser_executable_name, client_executable_name, host_executable_name, HOST_ENTRY};
use std::path::Path;

fn packages(dir: &Path, key: &ed25519_dalek::SigningKey, build: &str) {
    write_package(dir, key, &Package::new("client", build, vec![(client_executable_name().into(), b"#!/bin/sh\necho client\n".to_vec())]));
    write_package(dir, key, &Package::new("browser", build, vec![(browser_executable_name().into(), b"#!/bin/sh\necho browser\n".to_vec())]));
    write_package(dir, key, &Package::new("host", build, vec![(host_executable_name().into(), b"#!/bin/sh\n".to_vec()), (HOST_ENTRY.into(), b"// host".to_vec())]));
    write_package(dir, key, &Package::new("launcher", build, vec![("genie".into(), std::fs::read(env!("CARGO_BIN_EXE_genie")).unwrap())]));
}

#[test]
fn install_puts_the_launcher_in_its_place_links_it_and_writes_the_desktop_entry_and_uninstall_removes_them() {
    use std::os::unix::fs::PermissionsExt;
    let base = temp_dir("desktop");
    let r = roots(&base);
    let home = base.join("home");
    std::fs::create_dir_all(&home).unwrap();
    let key = throwaway_key();
    let from = base.join("from");
    packages(&from, &key, "2026.11.26-1");
    let out = run(genie_in(&r, &key).env("HOME", &home).env_remove("XDG_DATA_HOME").args(["install", "--profile", "both", "--yes", "--from"]).arg(&from));
    assert!(out.status.success(), "{}", text(&out));
    assert!(text(&out).contains("installed launcher 2026.11.26-1"), "{}", text(&out));

    let launcher = r.code.join("launcher").join("2026.11.26-1").join("genie");
    assert!(launcher.is_file(), "the launcher is in its build folder");
    assert_eq!(std::fs::metadata(&launcher).unwrap().permissions().mode() & 0o111, 0o111, "and it runs");
    let link = home.join(".local/bin/genie");
    assert_eq!(std::fs::read_link(&link).expect("~/.local/bin/genie is a link"), launcher);

    let entry = std::fs::read_to_string(home.join(".local/share/applications/genie.desktop")).expect("the desktop entry");
    assert!(entry.starts_with("[Desktop Entry]\n"), "{entry}");
    assert!(entry.contains("\nName=Genie\n"), "{entry}");
    assert!(entry.contains(&format!("\nExec={} %u\n", link.display())), "it runs the launcher: {entry}");
    assert!(entry.contains("\nMimeType=x-scheme-handler/genie;\n"), "{entry}");
    assert!(entry.contains("\nActions=doctor;\n") && entry.contains(&format!("\nExec={} --doctor\n", link.display())), "Genie (doctor mode): {entry}");
    assert!(!entry.contains(&r.code.join("client").display().to_string()), "never a client build's path, which changes with each update: {entry}");

    // The launcher it installed answers for itself.
    let status = run(std::process::Command::new(&link).env("GENIE_CODE_ROOT", &r.code).env("GENIE_HOME", &r.data).args(["status", "--json"]));
    assert!(status.status.success(), "{}", text(&status));
    let v: serde_json::Value = serde_json::from_slice(&status.stdout).unwrap();
    assert_eq!(v["tracks"]["launcher"]["current"], "2026.11.26-1");

    let out = run(genie_in(&r, &key).env("HOME", &home).arg("uninstall"));
    assert!(out.status.success(), "{}", text(&out));
    assert!(!r.code.exists(), "the programs folder is gone");
    assert!(std::fs::symlink_metadata(&link).is_err(), "the link is gone");
    assert!(!home.join(".local/share/applications/genie.desktop").exists(), "the desktop entry is gone");
    assert!(r.data.exists(), "the data root is kept");
}

#[test]
fn with_no_launcher_package_no_entry_is_written() {
    let base = temp_dir("desktop-none");
    let r = roots(&base);
    let home = base.join("home");
    std::fs::create_dir_all(&home).unwrap();
    let key = throwaway_key();
    let from = base.join("from");
    packages(&from, &key, "2026.11.26-1");
    std::fs::remove_file(from.join(format!("launcher-2026.11.26-1-{}-{}.manifest.json", genie_launcher::manifest::this_platform(), genie_launcher::manifest::this_arch()))).unwrap();
    let out = run(genie_in(&r, &key).env("HOME", &home).args(["install", "--from"]).arg(&from));
    assert!(out.status.success(), "{}", text(&out));
    assert!(!home.join(".local").exists(), "nothing written outside the code root: {:?}", std::fs::read_dir(&home).unwrap().collect::<Vec<_>>());
}

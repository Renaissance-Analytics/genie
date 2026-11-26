//! THE LAYOUT, `install --from`, VERIFY BEFORE RUN, AND A PRIVATE CODE ROOT.
mod common;

use common::*;
use genie_launcher::folder::{sweep, verify_build, HashScope, COMPLETE};
use genie_launcher::install::{install_from, InstallOptions, Installed, Profile};
use genie_launcher::layout::{browser_executable_name, client_executable_name, host_executable_name, Roots, Track, HOST_ENTRY};
use genie_launcher::{keys, secure, state};
use std::path::Path;

fn host_files() -> Vec<(String, Vec<u8>)> {
    vec![
        (host_executable_name().to_string(), b"host program".to_vec()),
        (HOST_ENTRY.to_string(), b"host entry".to_vec()),
        ("app/node_modules/x/x.node".to_string(), vec![7u8; 70_000]),
    ]
}
fn client_files() -> Vec<(String, Vec<u8>)> {
    vec![(client_executable_name().to_string(), b"client program".to_vec()), ("resources/app.asar".to_string(), vec![1u8; 5000])]
}

fn browser_files() -> Vec<(String, Vec<u8>)> {
    vec![(browser_executable_name().to_string(), b"browser program".to_vec()), ("resources/app.asar".to_string(), vec![2u8; 5000])]
}

/// The browser beside a test's own client: every profile installs it (its own track, the owner 2026-11-26).
fn with_browser(dir: &Path, key: &ed25519_dalek::SigningKey, build: &str) {
    write_package(dir, key, &Package::new("browser", build, browser_files()));
}

fn options(from: &Path, profile: Profile, channel: &str) -> InstallOptions {
    InstallOptions { from: from.to_path_buf(), profile, channel: channel.to_string(), launcher_build: "2026.11.25-1".to_string() }
}

fn both(dir: &Path, key: &ed25519_dalek::SigningKey, build: &str) {
    write_package(dir, key, &Package::new("client", build, client_files()));
    with_browser(dir, key, build);
    write_package(dir, key, &Package::new("host", build, host_files()));
}

#[test]
fn the_code_root_and_data_root_follow_the_environment_and_each_os() {
    let base = temp_dir("roots");
    let r = roots(&base);
    assert_eq!(r.track_dir(Track::Host), r.code.join("host"));
    assert_eq!(r.build_dir(Track::Client, "2026.11.25-1"), Some(r.code.join("client").join("2026.11.25-1")));
    assert_eq!(r.build_dir(Track::Client, "../x"), None, "a folder name is only ever a track build");
    assert_eq!(r.build_dir(Track::Client, "2.0.0"), None);
    assert_eq!(r.state_file(), r.code.join("state.json"));
    assert_eq!(r.runtime_dir(), r.data.join("runtime"));
    assert_eq!(r.logs_dir(), r.data.join("logs"));
    let host = r.host_program("2026.11.25-1").unwrap();
    assert_eq!(host.path(), r.code.join("host").join("2026.11.25-1").join(host_executable_name()));
    assert_eq!(host.folder(), r.code.join("host").join("2026.11.25-1"));
    assert!(r.host_program("2026.11.25").is_none());
}

#[test]
fn state_json_is_written_whole_and_points_current_and_previous() {
    let base = temp_dir("state");
    let file = base.join("state.json");
    let mut s = state::read(&file).expect("no file is the empty state");
    assert!(s.tracks.is_empty());
    s.point("host", "2026.11.18-1", "stable");
    s.point("host", "2026.11.25-1", "stable");
    state::write_atomic(&file, &s).unwrap();
    let back = state::read(&file).unwrap();
    let host = back.track("host").unwrap();
    assert_eq!(host.current.as_deref(), Some("2026.11.25-1"));
    assert_eq!(host.previous.as_deref(), Some("2026.11.18-1"));
    assert_eq!(host.channel, "stable");
    // No temporary file is left beside it.
    let names: Vec<_> = std::fs::read_dir(&base).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(names, vec![std::ffi::OsString::from("state.json")]);
    std::fs::write(&file, b"not json").unwrap();
    assert!(state::read(&file).is_err());
}

#[test]
fn install_from_lays_out_every_track_verified_and_points_at_them() {
    let base = temp_dir("install");
    let r = roots(&base);
    let key = throwaway_key();
    let from = base.join("from");
    both(&from, &key, "2026.11.25-1");
    let done = install_from(&r, &options(&from, Profile::Both, "stable"), &[verifying(&key)]).expect("installs");
    assert_eq!(done, vec![
        Installed { track: Track::Client, build: "2026.11.25-1".into() },
        Installed { track: Track::Browser, build: "2026.11.25-1".into() },
        Installed { track: Track::Host, build: "2026.11.25-1".into() },
    ]);
    for (track, files) in [(Track::Client, client_files()), (Track::Browser, browser_files()), (Track::Host, host_files())] {
        let dir = r.build_dir(track, "2026.11.25-1").unwrap();
        for (path, bytes) in files {
            assert_eq!(std::fs::read(dir.join(&path)).unwrap(), bytes, "{path}");
        }
        assert!(dir.join(COMPLETE).is_file());
        assert!(dir.join("manifest.json").is_file() && dir.join("manifest.json.sig").is_file());
        verify_build(&r, track, "2026.11.25-1", &[verifying(&key)], HashScope::All).expect("verifies after install");
    }
    let s = state::read(&r.state_file()).unwrap();
    assert_eq!(s.profile.as_deref(), Some("both"));
    assert_eq!(s.track("host").unwrap().current.as_deref(), Some("2026.11.25-1"));
    assert_eq!(s.track("client").unwrap().current.as_deref(), Some("2026.11.25-1"));
    assert_eq!(s.track("browser").unwrap().current.as_deref(), Some("2026.11.25-1"));
}

#[test]
fn the_client_profile_installs_the_client_and_the_browser_and_no_host() {
    let base = temp_dir("client-profile");
    let r = roots(&base);
    let key = throwaway_key();
    let from = base.join("from");
    both(&from, &key, "2026.11.25-1");
    install_from(&r, &options(&from, Profile::Client, "stable"), &[verifying(&key)]).expect("installs");
    assert!(!r.track_dir(Track::Host).exists());
    let s = state::read(&r.state_file()).unwrap();
    assert_eq!(s.profile.as_deref(), Some("client"));
    assert!(s.track("host").is_none());
    assert_eq!(s.track("client").unwrap().current.as_deref(), Some("2026.11.25-1"));
    assert_eq!(s.track("browser").unwrap().current.as_deref(), Some("2026.11.25-1"));
}

#[test]
fn a_host_installs_only_with_the_client_it_ships_with() {
    // A host update always comes with its client (the owner, 2026-11-26): a host whose withClient is not the client being
    // installed beside it, or already current, installs nothing.
    let base = temp_dir("host-client");
    let r = roots(&base);
    let key = throwaway_key();
    let from = base.join("from");
    write_package(&from, &key, &Package::new("client", "2026.11.25-1", client_files()));
    with_browser(&from, &key, "2026.11.25-1");
    let mut host = Package::new("host", "2026.11.25-1", host_files());
    host.with_client = Some("2026.11.24-1");
    write_package(&from, &key, &host);
    let why = install_from(&r, &options(&from, Profile::Both, "stable"), &[verifying(&key)]).unwrap_err();
    assert!(why.contains("ships with client 2026.11.24-1") && why.contains("2026.11.25-1"), "{why}");
    for t in [Track::Client, Track::Browser, Track::Host] {
        assert_nothing_landed(&r, t);
    }
    // Its own client beside it (another build than the host's): installs.
    let ok = base.join("ok");
    write_package(&ok, &key, &Package::new("client", "2026.11.24-1", client_files()));
    with_browser(&ok, &key, "2026.11.25-1");
    write_package(&ok, &key, &host);
    install_from(&r, &options(&ok, Profile::Both, "stable"), &[verifying(&key)]).expect("a host with its own client installs");
}

#[test]
fn a_client_or_browser_package_alone_never_touches_the_host() {
    // Each part updates on its own (the owner, 2026-11-26): a client and a browser newer than the host's stay beside the
    // host already installed, which keeps its current build and its folder.
    let base = temp_dir("client-alone");
    let r = roots(&base);
    let key = throwaway_key();
    let one = base.join("one");
    both(&one, &key, "2026.11.25-1");
    install_from(&r, &options(&one, Profile::Both, "stable"), &[verifying(&key)]).unwrap();
    let two = base.join("two");
    write_package(&two, &key, &Package::new("client", "2026.11.26-1", client_files()));
    with_browser(&two, &key, "2026.11.26-2");
    install_from(&r, &options(&two, Profile::Client, "stable"), &[verifying(&key)]).expect("the client and browser install alone");
    let s = state::read(&r.state_file()).unwrap();
    assert_eq!(s.track("host").unwrap().current.as_deref(), Some("2026.11.25-1"));
    assert_eq!(s.track("client").unwrap().current.as_deref(), Some("2026.11.26-1"));
    assert_eq!(s.track("browser").unwrap().current.as_deref(), Some("2026.11.26-2"));
    verify_build(&r, Track::Host, "2026.11.25-1", &[verifying(&key)], HashScope::All).expect("the host's folder is untouched");
}

#[test]
fn a_second_install_keeps_the_first_as_previous_and_the_same_build_refuses() {
    let base = temp_dir("upgrade");
    let r = roots(&base);
    let key = throwaway_key();
    let one = base.join("one");
    let two = base.join("two");
    both(&one, &key, "2026.11.18-1");
    both(&two, &key, "2026.11.25-1");
    install_from(&r, &options(&one, Profile::Both, "stable"), &[verifying(&key)]).unwrap();
    install_from(&r, &options(&two, Profile::Both, "stable"), &[verifying(&key)]).unwrap();
    let s = state::read(&r.state_file()).unwrap();
    assert_eq!(s.track("host").unwrap().previous.as_deref(), Some("2026.11.18-1"));
    let again = install_from(&r, &options(&two, Profile::Both, "stable"), &[verifying(&key)]).unwrap_err();
    assert!(again.contains("not newer"), "{again}");
    let older = install_from(&r, &options(&one, Profile::Both, "stable"), &[verifying(&key)]).unwrap_err();
    assert!(older.contains("not newer"), "{older}");
}

fn assert_nothing_landed(r: &Roots, track: Track) {
    let dir = r.track_dir(track);
    let left: Vec<_> = std::fs::read_dir(&dir).map(|d| d.map(|e| e.unwrap().file_name()).collect()).unwrap_or_default();
    assert!(left.is_empty(), "nothing of a refused package is left: {left:?}");
    assert!(state::read(&r.state_file()).unwrap().track(track.as_str()).is_none(), "state.json does not point at it");
}

#[test]
fn a_tampered_file_refuses_and_leaves_nothing() {
    let base = temp_dir("tampered");
    let r = roots(&base);
    let key = throwaway_key();
    let from = base.join("from");
    // A good client beside it: the profile installs both, and the host's refusal must leave neither (the run
    // 1125-060418-1c2da8 refused with "no client package" instead, which is not the check this names).
    write_package(&from, &key, &Package::new("client", "2026.11.25-1", client_files()));
    with_browser(&from, &key, "2026.11.25-1");
    let p = Package::new("host", "2026.11.25-1", host_files());
    let manifest = manifest_bytes(&p);
    let mut archived = host_files();
    archived[2].1[100] ^= 0x01;
    write_package_with(&from, &key, &p, &manifest, &archived);
    let why = install_from(&r, &options(&from, Profile::Both, "stable"), &[verifying(&key)]).unwrap_err();
    assert!(why.contains("do not match its signed manifest"), "{why}");
    assert_nothing_landed(&r, Track::Host);
    assert_nothing_landed(&r, Track::Client);
}

#[test]
fn an_unlisted_or_missing_file_refuses() {
    let key = throwaway_key();
    for (name, archived) in [
        ("unlisted", { let mut f = host_files(); f.push(("planted.dll".into(), b"x".to_vec())); f }),
        ("missing", { let mut f = host_files(); f.pop(); f }),
    ] {
        let base = temp_dir(name);
        let r = roots(&base);
        let from = base.join("from");
        write_package(&from, &key, &Package::new("client", "2026.11.25-1", client_files()));
        with_browser(&from, &key, "2026.11.25-1");
        let p = Package::new("host", "2026.11.25-1", host_files());
        write_package_with(&from, &key, &p, &manifest_bytes(&p), &archived);
        let why = install_from(&r, &options(&from, Profile::Both, "stable"), &[verifying(&key)]).unwrap_err();
        assert!(why.contains("do not match its signed manifest"), "{name}: {why}");
        assert_nothing_landed(&r, Track::Host);
        assert_nothing_landed(&r, Track::Client);
    }
}

#[test]
fn a_package_signed_by_another_key_installs_nothing() {
    let base = temp_dir("unsigned");
    let r = roots(&base);
    let from = base.join("from");
    both(&from, &throwaway_key(), "2026.11.25-1");
    let why = install_from(&r, &options(&from, Profile::Both, "stable"), &[verifying(&throwaway_key())]).unwrap_err();
    assert!(why.contains("This update's signature is not Genie's. Nothing was installed."), "{why}");
    assert_nothing_landed(&r, Track::Client);
    assert_nothing_landed(&r, Track::Browser);
    assert_nothing_landed(&r, Track::Host);
}

#[test]
fn a_dev_package_does_not_install_on_stable() {
    let base = temp_dir("dev-on-stable");
    let r = roots(&base);
    let key = throwaway_key();
    let from = base.join("from");
    let mut p = Package::new("client", "2026.11.25-1", client_files());
    p.channel = "dev";
    write_package(&from, &key, &p);
    let mut b = Package::new("browser", "2026.11.25-1", browser_files());
    b.channel = "dev";
    write_package(&from, &key, &b);
    assert!(install_from(&r, &options(&from, Profile::Client, "stable"), &[verifying(&key)]).is_err());
    assert!(install_from(&r, &options(&from, Profile::Client, "dev"), &[verifying(&key)]).is_ok());
}

#[test]
fn both_archive_formats_install_on_every_os() {
    for format in [Format::Zip, Format::TarZst] {
        let base = temp_dir("formats");
        let r = roots(&base);
        let key = throwaway_key();
        let from = base.join("from");
        let mut p = Package::new("client", "2026.11.25-1", client_files());
        p.format = format;
        write_package(&from, &key, &p);
        with_browser(&from, &key, "2026.11.25-1");
        install_from(&r, &options(&from, Profile::Client, "stable"), &[verifying(&key)]).unwrap_or_else(|e| panic!("{format:?}: {e}"));
    }
}

#[test]
fn a_link_in_a_tar_refuses() {
    let base = temp_dir("tar-link");
    let r = roots(&base);
    let key = throwaway_key();
    let from = base.join("from");
    let p = Package::new("client", "2026.11.25-1", client_files());
    let manifest = manifest_bytes(&p);
    let stem = p.stem();
    std::fs::create_dir_all(&from).unwrap();
    std::fs::write(from.join(format!("{stem}.manifest.json")), &manifest).unwrap();
    std::fs::write(from.join(format!("{stem}.manifest.json.sig")), sign_b64(&key, &manifest)).unwrap();
    let mut entries: Vec<(String, u8, Vec<u8>)> = client_files().into_iter().map(|(n, d)| (n, b'0', d)).collect();
    entries.push(("link".into(), b'2', vec![]));
    std::fs::write(from.join(format!("{stem}.tar.zst")), zstd_raw(&tar_entries(&entries))).unwrap();
    with_browser(&from, &key, "2026.11.25-1");
    assert!(install_from(&r, &options(&from, Profile::Client, "stable"), &[verifying(&key)]).is_err());
    assert_nothing_landed(&r, Track::Client);
}

#[test]
fn a_folder_with_no_complete_marker_is_never_run_and_is_swept() {
    let base = temp_dir("no-complete");
    let r = roots(&base);
    let key = throwaway_key();
    let from = base.join("from");
    both(&from, &key, "2026.11.25-1");
    install_from(&r, &options(&from, Profile::Both, "stable"), &[verifying(&key)]).unwrap();
    let dir = r.build_dir(Track::Host, "2026.11.25-1").unwrap();
    std::fs::remove_file(dir.join(COMPLETE)).unwrap();
    let why = verify_build(&r, Track::Host, "2026.11.25-1", &[verifying(&key)], HashScope::Executables).unwrap_err();
    assert!(why.contains(".complete"), "{why}");
    std::fs::create_dir_all(r.track_dir(Track::Client).join("2026.11.26-1.partial")).unwrap();
    let swept = sweep(&r);
    assert_eq!(swept.len(), 2, "{swept:?}");
    assert!(!dir.exists());
    assert!(r.build_dir(Track::Client, "2026.11.25-1").unwrap().exists(), "a complete folder stays");
}

#[test]
fn a_file_changed_after_install_refuses_to_run() {
    let base = temp_dir("changed");
    let r = roots(&base);
    let key = throwaway_key();
    let from = base.join("from");
    both(&from, &key, "2026.11.25-1");
    install_from(&r, &options(&from, Profile::Both, "stable"), &[verifying(&key)]).unwrap();
    let dir = r.build_dir(Track::Host, "2026.11.25-1").unwrap();
    // The program changed (same size), and a DLL planted beside it: both refuse a run.
    let mut exe = std::fs::read(dir.join(host_executable_name())).unwrap();
    exe[0] ^= 1;
    std::fs::write(dir.join(host_executable_name()), &exe).unwrap();
    assert!(verify_build(&r, Track::Host, "2026.11.25-1", &[verifying(&key)], HashScope::Executables).is_err());
    exe[0] ^= 1;
    std::fs::write(dir.join(host_executable_name()), &exe).unwrap();
    verify_build(&r, Track::Host, "2026.11.25-1", &[verifying(&key)], HashScope::Executables).expect("restored");
    std::fs::write(dir.join("version.dll"), b"planted").unwrap();
    let why = verify_build(&r, Track::Host, "2026.11.25-1", &[verifying(&key)], HashScope::Executables).unwrap_err();
    assert!(why.contains("version.dll"), "{why}");
}

#[test]
fn a_next_key_in_a_trusted_manifest_is_trusted_after_it() {
    let base = temp_dir("rotation");
    let r = roots(&base);
    let key = throwaway_key();
    let next = throwaway_key();
    let one = base.join("one");
    let mut p = Package::new("client", "2026.11.25-1", client_files());
    p.next_key = Some(public_b64(&next));
    write_package(&one, &key, &p);
    with_browser(&one, &key, "2026.11.25-1");
    let before = keys::trusted_keys(&r);
    assert!(!before.contains(&verifying(&next)));
    install_from(&r, &options(&one, Profile::Client, "stable"), &[verifying(&key)]).unwrap();
    assert!(keys::trusted_keys(&r).contains(&verifying(&next)), "the next key is trusted once a trusted manifest named it");
}

#[test]
fn a_code_root_others_can_change_refuses() {
    let base = temp_dir("private");
    let r = roots(&base);
    secure::check_private(&r.code).expect("a fresh private folder passes");
    make_world_writable(&r.code);
    let why = secure::check_private(&r.code).unwrap_err();
    assert!(why.starts_with("Genie's programs folder can be changed by other accounts on this computer"), "{why}");
    // The launcher itself refuses to run from it, with the same words.
    let key = throwaway_key();
    let out = run(genie_in(&r, &key).arg("ensure-host"));
    assert_eq!(out.status.code(), Some(125));
    assert!(text(&out).contains("can be changed by other accounts"), "{}", text(&out));
}

#[cfg(unix)]
fn make_world_writable(dir: &Path) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o777)).unwrap();
}

#[cfg(windows)]
fn make_world_writable(dir: &Path) {
    // Everyone (WD) gets full control beside this user: the shape of a programs folder others can change.
    let sid = genie_launcher::win::current_user_sid().unwrap();
    let out = std::process::Command::new(r"C:\Windows\System32\icacls.exe").arg(dir).args(["/grant", "*S-1-1-0:(OI)(CI)F"]).output().unwrap();
    assert!(out.status.success(), "icacls: {}", String::from_utf8_lossy(&out.stderr));
    let _ = sid;
}

#[test]
fn install_from_the_command_line_needs_the_signature_and_reports_status() {
    let base = temp_dir("cli");
    let r = roots(&base);
    let key = throwaway_key();
    let from = base.join("from");
    both(&from, &key, "2026.11.25-1");
    let out = run(genie_in(&r, &key).args(["install", "--profile", "both", "--channel", "stable", "--yes", "--from"]).arg(&from));
    assert!(out.status.success(), "{}", text(&out));
    let out = run(genie_in(&r, &key).args(["status", "--json"]));
    assert!(out.status.success(), "{}", text(&out));
    let status: serde_json::Value = serde_json::from_slice(&out.stdout).expect("status --json is JSON");
    assert_eq!(status["profile"], "both");
    assert_eq!(status["tracks"]["host"]["current"], "2026.11.25-1");
    assert_eq!(status["tracks"]["host"]["verified"], true);
    assert_eq!(status["tracks"]["client"]["verified"], true);
    assert_eq!(status["tracks"]["browser"]["verified"], true);
    assert_eq!(status["host"]["running"], false);
    // Another key: the same packages refuse.
    let other = temp_dir("cli-other");
    let r2 = roots(&other);
    let out = run(genie_in(&r2, &throwaway_key()).args(["install", "--from"]).arg(&from));
    assert_eq!(out.status.code(), Some(125));
    assert!(text(&out).contains("signature is not Genie's"), "{}", text(&out));
}

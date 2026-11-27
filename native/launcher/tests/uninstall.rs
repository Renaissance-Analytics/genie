//! `genie uninstall` REMOVES ONLY WHAT THE LAUNCHER OWNS (Tynn #1058 L4; the coordinator, 2026-11-27). The code root can
//! come from GENIE_CODE_ROOT, so a wrong value (a home folder, the data root, a drive root) must never be wiped: the
//! launcher removes the track builds it installed (state.json's), their partial folders, its trusted keys and state.json,
//! then a track folder or the code root only when nothing else is left in it. It refuses outright, removing nothing, when
//! the code root is or holds the home folder or the data root.
mod common;

use common::*;
use genie_launcher::layout::Roots;
use genie_launcher::state;
use std::path::Path;
use std::process::Command;

const BUILD: &str = "2026.11.27-1";
const OLD: &str = "2026.11.26-1";

/// A code root as an install leaves it: client and host current, the client's previous, a partial, state.json.
fn installed(roots: &Roots) {
    for (track, build) in [("client", BUILD), ("client", OLD), ("host", BUILD)] {
        let dir = roots.code.join(track).join(build);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".complete"), b"").unwrap();
        std::fs::write(dir.join("program"), b"x").unwrap();
    }
    std::fs::create_dir_all(roots.code.join("host").join(format!("{BUILD}.partial"))).unwrap();
    let mut st = state::State::default();
    st.profile = Some("both".to_string());
    st.point("client", OLD, "stable");
    st.point("client", BUILD, "stable");
    st.point("host", BUILD, "stable");
    state::write_atomic(&roots.state_file(), &st).unwrap();
    std::fs::write(roots.code.join("trusted-keys.json"), b"[]").unwrap();
}

/// `genie uninstall` with this test's roots, and a home of the test's own (never the machine's).
fn uninstall(roots: &Roots, home: &Path) -> std::process::Output {
    let key = throwaway_key();
    let mut c: Command = genie_in(roots, &key);
    c.env("HOME", home).env("USERPROFILE", home).env("XDG_DATA_HOME", home.join(".local").join("share")).arg("uninstall");
    run(&mut c)
}

#[test]
fn a_foreign_file_in_the_code_root_is_kept() {
    let base = temp_dir("uninstall-foreign");
    let roots = roots(&base);
    installed(&roots);
    std::fs::write(roots.code.join("notes.txt"), b"not Genie's").unwrap();
    std::fs::create_dir_all(roots.code.join("client").join("my-stuff")).unwrap();
    std::fs::write(roots.code.join("client").join("my-stuff").join("keep.txt"), b"mine").unwrap();

    let out = uninstall(&roots, &base);
    assert!(out.status.success(), "{}", text(&out));

    assert_eq!(std::fs::read(roots.code.join("notes.txt")).unwrap(), b"not Genie's", "a file the launcher never wrote is kept");
    assert_eq!(std::fs::read(roots.code.join("client").join("my-stuff").join("keep.txt")).unwrap(), b"mine");
    for gone in [roots.code.join("client").join(BUILD), roots.code.join("client").join(OLD), roots.code.join("host").join(BUILD), roots.code.join("host").join(format!("{BUILD}.partial")), roots.state_file(), roots.code.join("trusted-keys.json")] {
        assert!(!gone.exists(), "{} is the launcher's and goes", gone.display());
    }
    assert!(!roots.code.join("host").exists(), "a track folder left empty goes");
    assert!(roots.code.join("client").exists(), "a track folder still holding something foreign stays");
    assert!(roots.data.exists(), "the data root is never removed");
}

#[test]
fn a_code_root_left_empty_goes() {
    let base = temp_dir("uninstall-empty");
    let roots = roots(&base);
    installed(&roots);
    let out = uninstall(&roots, &base);
    assert!(out.status.success(), "{}", text(&out));
    assert!(!roots.code.exists(), "nothing foreign was in it, so the code root itself goes");
    assert!(roots.data.exists());
}

#[test]
fn a_code_root_that_is_the_home_folder_is_refused_and_nothing_is_removed() {
    let base = temp_dir("uninstall-home");
    let roots = Roots { code: base.clone(), data: base.join(".genie") };
    std::fs::create_dir_all(&roots.data).unwrap();
    installed(&roots);
    std::fs::write(base.join("diary.txt"), b"mine").unwrap();
    let out = uninstall(&roots, &base);
    assert!(!out.status.success(), "refused: {}", text(&out));
    assert!(text(&out).contains("home folder"), "it says why: {}", text(&out));
    assert!(base.join("diary.txt").exists() && roots.state_file().exists() && roots.code.join("client").join(BUILD).exists(), "nothing removed");
}

#[test]
fn a_code_root_holding_the_data_root_is_refused_and_nothing_is_removed() {
    let base = temp_dir("uninstall-data");
    let code = base.join("code");
    let roots = Roots { code: code.clone(), data: code.join("data") };
    std::fs::create_dir_all(&roots.data).unwrap();
    installed(&roots);
    std::fs::write(roots.data.join("agents.json"), b"{}").unwrap();
    let out = uninstall(&roots, &base);
    assert!(!out.status.success(), "refused: {}", text(&out));
    assert!(text(&out).contains("data root"), "it says why: {}", text(&out));
    assert!(roots.data.join("agents.json").exists() && roots.state_file().exists(), "nothing removed");
}

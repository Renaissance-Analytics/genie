//! THE MIGRATION'S CARD (Tynn #1058 L9): shown from the bridge's first act until the launcher's client is up, so the move
//! never reads as "Genie crashed". When it may close, where it is started, and that it says so in the migration's log.
use genie_launcher::migrate::{card_may_close, CARD_LIMIT};
use serde_json::json;

#[test]
fn the_card_stays_until_a_client_is_attached_to_the_launcher_and_no_longer_than_its_limit() {
    assert!(!card_may_close(None), "no launcher yet: the card stays");
    assert!(!card_may_close(Some(&json!({"clients": []}))), "the launcher is up but no window yet: the card stays");
    assert!(!card_may_close(Some(&json!({}))), "a status that says nothing of clients: the card stays");
    assert!(card_may_close(Some(&json!({"clients": [4242]}))), "a client window attached: the card goes");
    assert!(CARD_LIMIT.as_secs() >= 60 && CARD_LIMIT.as_secs() <= 180, "bounded: never a card left on screen for ever");
}

fn source(file: &str) -> String {
    std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(file)).unwrap().replace("\r\n", "\n")
}

#[test]
fn the_bridge_appimage_shows_the_card_from_its_first_act_and_the_installer_starts_it_before_the_install() {
    let main = source("src/main.rs");
    let bridge = &main[main.find("fn cmd_bridge").expect("cmd_bridge")..];
    let card = bridge.find("run_moving_card").expect("the bridge shows the card");
    let install = bridge.find("cmd_install(").expect("the bridge installs");
    assert!(card < install, "the card is up before the install starts");
    assert!(main.contains("Some(\"moving-card\")"), "`genie moving-card` is a mode of its own (the Windows installer's)");
    let nsh = source("../../build/launcher-installer.nsh");
    let exec = nsh.find("Genie.exe\" moving-card").expect("the installer starts the card");
    let install = nsh.find("Genie.exe\" install --profile").expect("the installer's install");
    assert!(exec < install, "on an update the card is up before the packages install");
    assert!(nsh[..exec].contains("${isUpdated}"), "only on an update (the single app's updater ran it)");
}

/// NO CONSOLE WINDOW BEHIND IT (run 1127-223352-5d8720, during-06-windows.png: the installer's `Genie.exe moving-card`
/// opened a console that said "moving: shown" behind the card). The launcher is a console program, so in the modes a
/// person sees it lets go of a console that is its own alone (one started from a terminal is shared and kept).
#[test]
fn the_modes_a_person_sees_let_go_of_a_console_that_is_theirs_alone() {
    let main = source("src/main.rs");
    let f = &main[main.find("fn release_own_console").expect("the console is let go of")..];
    let f = &f[..f.find("\n}\n").unwrap()];
    assert!(f.contains("GetConsoleProcessList") && f.contains("FreeConsole"), "only a console of its own: {f}");
    assert!(f.contains("== 1"), "a console with other processes (a terminal) is kept: {f}");
    let modes = &main[main.find("fn main()").unwrap()..];
    let release = modes.find("release_own_console()").expect("main lets go of it");
    for mode in ["Some(\"moving-card\")", "Some(\"--logon\")", "None | Some(\"--updated\")"] {
        assert!(modes.find(mode).map_or(false, |at| at > release), "{mode} comes after the console is let go of");
    }
    assert!(main[..main.find("fn release_own_console").unwrap()].contains("fn shown_to_a_person"), "the modes are named in one place");
}

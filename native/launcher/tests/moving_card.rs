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

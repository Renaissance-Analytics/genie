//! THE SETUP WINDOW'S PAGE (Tynn #1058 L3, the owner's direction C, "Wish Orb"): what the launcher hands its webview is the
//! bundled page with the mockup's own CSS put in, the three install screens, and nothing fetched. How it looks is the
//! launcher-install row's screenshots, compared with sandbox/launcher-design/shots/direction-c-{choose,install,ready}.png.
#![cfg(feature = "ui")]

use genie_launcher::ui::setup_html;

#[test]
fn the_page_is_the_mockups_install_screens_with_its_css_bundled() {
    let html = setup_html();
    assert!(!html.contains("/*GENIE_CSS*/"), "the CSS is put in place of its marker");
    assert!(html.contains("C: Wish Orb"), "direction C's theme is in the page");
    assert!(html.contains("@media (prefers-reduced-motion: reduce)"), "reduce motion is honoured");
    for id in ["s-choose", "s-install", "s-ready"] {
        assert!(html.contains(&format!("id=\"{id}\"")), "the {id} screen");
    }
    assert!(html.contains("Genie + this computer as a host") && html.contains("Genie only"), "the owner's choice");
}

#[test]
fn the_page_fetches_nothing() {
    let html = setup_html();
    for bad in ["src=\"http", "href=\"http", "@import", "url(http", "fetch(", "XMLHttpRequest"] {
        assert!(!html.contains(bad), "the setup page names {bad}");
    }
}

#[test]
fn a_failure_says_what_to_do_in_plain_words_and_keeps_the_launchers_own_for_details() {
    use genie_launcher::ui::failure_view;
    let raw = "This package is not the one asked for (channel dev, this install reads stable). Nothing was installed.";
    let v = failure_view(raw);
    assert_eq!(v["words"], "This installer is for a different Genie channel (dev). Download the stable installer.");
    assert_eq!(v["detail"], raw, "the raw words go under Show details");
    assert_eq!(v["retry"], false, "trying the same installer again cannot help");
    assert_eq!(v["get"], true, "the way forward is the right installer");
    let damaged = failure_view("This package's files do not match its signed manifest (x is not the file its manifest names). Nothing was installed.");
    assert_eq!(damaged["title"], "This installer is damaged");
    // Trying the same damaged installer again cannot help: Get the installer and Close (the coordinator, 2026-11-26).
    assert_eq!(damaged["retry"], false);
    assert_eq!(damaged["get"], true);
    assert_eq!(failure_view("This update's signature is not Genie's. Nothing was installed. (no trusted key signed it)")["get"], true);
    let other = failure_view("the programs folder could not be made");
    assert_eq!(other["retry"], true);
    assert_eq!(other["get"], false);
    assert_eq!(genie_launcher::ui::DOWNLOAD_URL, "https://github.com/Renaissance-Analytics/genie/releases/latest");
    assert_eq!(other["detail"], "the programs folder could not be made");
}

#[test]
fn the_failure_screen_marks_the_failed_step_turns_the_bar_red_and_offers_a_way_forward() {
    let html = setup_html();
    assert_eq!(genie_launcher::ui::failed_labels()["check"], "Couldn’t confirm this package", "the failed step says it failed");
    assert!(html.contains("<use href=\"#i-x\"/>"), "with a red cross");
    assert!(html.contains(".bar.bad .fill{background:var(--bad)}"), "the bar turns red where it stopped");
    assert!(html.contains("id=\"retry\">Try again") && html.contains("id=\"fail-close\">Close"), "Try again and Close");
    assert!(html.contains("id=\"get-installer\">Get the installer"), "Get the installer, when retrying cannot help");
}

#[test]
fn hidden_parts_stay_hidden_whatever_their_display_rule() {
    // The failure actions are `hidden` until a failure, inside `.fail-actions{display:flex}`: the hidden rule must win.
    assert!(setup_html().contains("[hidden]{display:none!important}"));
}

#[test]
fn a_steps_words_follow_its_state() {
    use genie_launcher::ui::step_label;
    // Waiting, running, done: never "Installed" on a row that is still at 2 %.
    assert_eq!(step_label("client", "todo"), "Install Genie");
    assert_eq!(step_label("client", "now"), "Installing Genie…");
    assert_eq!(step_label("client", "done"), "Installed Genie");
    assert_eq!(step_label("check", "now"), "Checking that everything is from Genie…");
    assert_eq!(step_label("check", "done"), "Checked that everything is from Genie");
    assert_eq!(step_label("host", "now"), "Installing the host…");
    assert_eq!(step_label("start", "now"), "Starting the host…");
    assert_eq!(step_label("start", "done"), "Host started");
    for id in ["check", "client", "host", "start"] {
        let words: Vec<&str> = ["todo", "now", "done", "failed"].iter().map(|s| step_label(id, s)).collect();
        assert!(words.iter().all(|w| !w.is_empty()), "{id}: {words:?}");
        let mut unique = words.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), 4, "{id}: each state has its own words: {words:?}");
        assert!(step_label(id, "now").ends_with('…'), "{id}: a running step says it is running");
    }
}

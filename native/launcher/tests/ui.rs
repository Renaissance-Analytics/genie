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
    let damaged = failure_view("This package's files do not match its signed manifest (x is not the file its manifest names). Nothing was installed.");
    assert_eq!(damaged["title"], "This installer is damaged");
    assert_eq!(damaged["retry"], true);
    let other = failure_view("the programs folder could not be made");
    assert_eq!(other["retry"], true);
    assert_eq!(other["detail"], "the programs folder could not be made");
}

#[test]
fn the_failure_screen_marks_the_failed_step_turns_the_bar_red_and_offers_a_way_forward() {
    let html = setup_html();
    assert!(html.contains("Couldn’t confirm this package"), "the failed step says it failed");
    assert!(html.contains("<use href=\"#i-x\"/>"), "with a red cross");
    assert!(html.contains(".bar.bad .fill{background:var(--bad)}"), "the bar turns red where it stopped");
    assert!(html.contains("id=\"retry\">Try again") && html.contains("id=\"fail-close\">Close"), "Try again and Close");
}

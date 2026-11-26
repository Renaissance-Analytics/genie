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

//! THE TRAY PANEL AND THE LAUNCH PAD (Tynn #1058, tasks #1514 and #1515): the owner's direction C, "Wish Orb"
//! (sandbox/launcher-design/shots/direction-c-tray.png and direction-c-pad.png). What the two windows say, and what each
//! of their buttons does, from a launcher's state given here (no host, no window, no network). How they look is the
//! launcher-install row's screenshots `launch-tray-panel-<os>.png` and `launch-pad-<os>.png`, set beside the mockup's.
use genie_launcher::panel::{self, Facts, Pick, Rect};
use genie_launcher::tray::{Action, HostView, View};

const DAY: u64 = 24 * 60 * 60 * 1000;

/// The mockup's state: the host running three agents, a window open, the Browser installed, four updates ready, Genie
/// starting at sign-in, two paired hosts, up two days.
fn mockup() -> Facts {
    Facts {
        view: View { host: HostView::Running { agents: Some(3) }, windows: 1, browser: true, needs_you: 0, updates: 4, host_update: None },
        paired: vec!["https://studio-desktop.local:7443".to_string(), "https://build-box.example".to_string()],
        at_logon: true,
        host_started_ms: Some(1_000_000),
        now_ms: 1_000_000 + 2 * DAY + 5 * 60 * 1000,
    }
}

#[test]
fn the_panel_is_the_mockups_tray_screen_item_for_item() {
    let p = panel::panel(&mockup());
    assert_eq!(p["head"]["title"], "Genie");
    assert_eq!(p["head"]["line"], "This computer’s host · running · 3 agents", "the header's line, the mockup's words");
    assert_eq!(p["head"]["state"], "running", "the status pill: running");
    assert_eq!(
        panel::panel_text(&p),
        vec![
            "Open Genie",
            "Open Genie Browser",
            "---",
            "# Hosts",
            "• This computer — 3 agents",
            "• studio-desktop.local — paired",
            "• build-box.example — paired",
            "---",
            "Stop this computer’s host",
            "Updates (4)",
            "[x] Start when I sign in",
            "---",
            "Close Genie — agents keep running",
            "Shut down everything",
        ]
    );
    let items = p["items"].as_array().unwrap();
    let find = |id: &str| items.iter().find(|i| i["id"] == id).unwrap_or_else(|| panic!("no item {id}: {p}"));
    assert_eq!(find("openGenie")["strong"], true, "Open Genie is the first, strong item");
    assert_eq!(find("openGenie")["icon"], "i-window");
    assert_eq!(find("openBrowser")["icon"], "i-globe");
    assert_eq!(find("stopHost")["icon"], "i-host");
    assert_eq!(find("updates")["icon"], "i-rocket");
    assert_eq!(find("updates")["badge"], 4, "Updates with its count, as a badge");
    assert_eq!(find("logon")["kind"], "toggle");
    assert_eq!(find("logon")["on"], true);
    assert_eq!(find("shutDown")["danger"], true, "Shut down everything in red");
    assert_eq!(find("host:local")["dot"], "ok");
    assert_eq!(find("host:https://build-box.example")["dot"], "off", "a paired host the launcher cannot ask is not shown as running");
}

#[test]
fn every_panel_item_is_the_native_menus_own_action() {
    let p = panel::panel(&mockup());
    for item in p["items"].as_array().unwrap() {
        let Some(id) = item["id"].as_str() else { continue };
        match panel::pick(id) {
            Some(Pick::Act(a)) => assert!(Action::ALL.contains(&a), "{id}"),
            Some(Pick::Logon) => assert_eq!(id, "logon"),
            Some(Pick::Host(url)) => assert!(id.ends_with(&url), "{id}"),
            Some(Pick::Pad) => panic!("the pad is the header's, not an item's: {id}"),
            None => panic!("an item no click can act on: {id}"),
        }
    }
    assert_eq!(panel::pick("openGenie"), Some(Pick::Act(Action::OpenGenie)));
    assert_eq!(panel::pick("openBrowser"), Some(Pick::Act(Action::OpenBrowser)));
    assert_eq!(panel::pick("stopHost"), Some(Pick::Act(Action::StopHost)), "the same Stop, with its question (tray::act)");
    assert_eq!(panel::pick("startHost"), Some(Pick::Act(Action::StartHost)));
    assert_eq!(panel::pick("updates"), Some(Pick::Act(Action::Updates)));
    assert_eq!(panel::pick("closeUi"), Some(Pick::Act(Action::CloseUi)));
    assert_eq!(panel::pick("shutDown"), Some(Pick::Act(Action::ShutDown)));
    assert_eq!(panel::pick("openSettings"), Some(Pick::Act(Action::OpenSettings)));
    assert_eq!(panel::pick("host:local"), Some(Pick::Act(Action::OpenGenie)), "this computer's row opens Genie on it");
    assert_eq!(panel::pick("host:https://build-box.example"), Some(Pick::Host("https://build-box.example".to_string())));
    assert_eq!(panel::pick("pad"), Some(Pick::Pad));
    assert_eq!(panel::pick("logon"), Some(Pick::Logon));
    assert_eq!(panel::pick("rm -rf"), None);
    assert_eq!(panel::pick("host:"), None);
}

#[test]
fn a_stopped_host_offers_start_and_closing_genie_says_nothing_keeps_running() {
    let mut f = mockup();
    f.view.host = HostView::Stopped;
    f.view.windows = 0;
    f.at_logon = false;
    let p = panel::panel(&f);
    assert_eq!(p["head"]["line"], "This computer’s host · stopped");
    assert_eq!(p["head"]["state"], "stopped");
    let t = panel::panel_text(&p);
    assert!(t.contains(&"Start this computer’s host".to_string()), "{t:?}");
    assert!(!t.iter().any(|l| l.starts_with("Stop this")), "{t:?}");
    assert!(t.contains(&"• This computer — stopped".to_string()), "{t:?}");
    assert!(t.contains(&"[ ] Start when I sign in".to_string()), "the toggle off: {t:?}");
    assert!(t.contains(&"Close Genie (unavailable)".to_string()), "no window open, nothing to close, no 'agents keep running': {t:?}");
}

#[test]
fn a_client_only_computer_lists_only_its_paired_hosts_and_offers_no_host_of_its_own() {
    let mut f = mockup();
    f.view.host = HostView::NotHere;
    f.view.browser = false;
    let p = panel::panel(&f);
    assert_eq!(p["head"]["line"], "No host on this computer");
    assert_eq!(p["head"]["state"], "none");
    let t = panel::panel_text(&p);
    assert!(!t.iter().any(|l| l.contains("This computer")), "{t:?}");
    assert!(!t.iter().any(|l| l.contains("this computer’s host")), "{t:?}");
    assert!(!t.contains(&"Open Genie Browser".to_string()), "no Browser installed: {t:?}");
    assert!(t.contains(&"• studio-desktop.local — paired".to_string()), "{t:?}");
    f.paired.clear();
    let t = panel::panel_text(&panel::panel(&f));
    assert!(!t.contains(&"# Hosts".to_string()), "no hosts at all: no heading over nothing: {t:?}");
}

#[test]
fn what_waits_on_the_person_and_a_ready_host_update_keep_their_items() {
    let mut f = mockup();
    f.view.needs_you = 2;
    f.view.host_update = Some("2026.11.28-2".into());
    f.view.updates = 1;
    let t = panel::panel_text(&panel::panel(&f));
    assert_eq!(t[0], "Needs you (2)", "first, above Open Genie: {t:?}");
    assert!(t.contains(&"Updates (1)".to_string()), "{t:?}");
    assert!(t.contains(&"Update host".to_string()), "{t:?}");
    assert_eq!(panel::pick("openDeck"), Some(Pick::Act(Action::OpenDeck)));
    assert_eq!(panel::pick("installHostUpdate"), Some(Pick::Act(Action::InstallHostUpdate)));
    f.view.updates = 0;
    f.view.host_update = None;
    let p = panel::panel(&f);
    let up = p["items"].as_array().unwrap().iter().find(|i| i["id"] == "updates").unwrap().clone();
    assert!(up["badge"].is_null(), "nothing ready: no badge: {up}");
}

#[test]
fn the_pad_is_the_mockups_launch_pad_with_the_launchers_own_numbers() {
    let d = panel::pad(&mockup());
    assert_eq!(d["sub"], "Everything is running.");
    assert_eq!(d["host"]["title"], "This computer’s host");
    assert_eq!(d["host"]["pill"], "Running");
    assert_eq!(d["host"]["ok"], true);
    assert_eq!(d["host"]["detail"], "3 agents working · up 2 days");
    assert_eq!(d["host"]["button"]["id"], "stopHost");
    assert_eq!(d["host"]["button"]["label"], "Stop");
    assert_eq!(d["genie"]["id"], "openGenie");
    assert_eq!(d["genie"]["enabled"], true);
    assert_eq!(d["browser"]["id"], "openBrowser");
    assert_eq!(d["browser"]["enabled"], true);
    assert_eq!(d["updates"]["count"], 4);
    assert_eq!(d["updates"]["label"], "Updates ready");
    assert_eq!(d["settings"]["id"], "openSettings");
}

#[test]
fn the_pad_with_a_stopped_host_offers_start_and_one_agent_is_one() {
    let mut f = mockup();
    f.view.host = HostView::Stopped;
    f.view.updates = 1;
    let d = panel::pad(&f);
    assert_eq!(d["sub"], "Your host is stopped.");
    assert_eq!(d["host"]["pill"], "Stopped");
    assert_eq!(d["host"]["ok"], false);
    assert_eq!(d["host"]["detail"], "Your agents wait until it starts");
    assert_eq!(d["host"]["button"]["id"], "startHost");
    assert_eq!(d["host"]["button"]["label"], "Start");
    assert_eq!(d["updates"]["label"], "Update ready");
    f.view.host = HostView::Running { agents: Some(1) };
    f.host_started_ms = Some(f.now_ms - 3 * 60 * 1000);
    assert_eq!(panel::pad(&f)["host"]["detail"], "1 agent working · up 3 min");
    f.view.host = HostView::Running { agents: Some(0) };
    assert_eq!(panel::pad(&f)["host"]["detail"], "No agents working · up 3 min");
    f.view.host = HostView::NotHere;
    f.view.browser = false;
    let d = panel::pad(&f);
    assert_eq!(d["host"]["title"], "No host on this computer");
    assert!(d["host"]["button"].is_null(), "nothing to start or stop: {d}");
    assert_eq!(d["browser"]["enabled"], false, "no Browser installed: its Open is not offered");
    f.view.updates = 0;
    assert_eq!(panel::pad(&f)["updates"]["label"], "Updates");
}

#[test]
fn uptime_is_said_as_a_person_says_it() {
    let m = 60 * 1000;
    assert_eq!(panel::uptime(20 * 1000), "up less than a minute");
    assert_eq!(panel::uptime(m), "up 1 min");
    assert_eq!(panel::uptime(59 * m), "up 59 min");
    assert_eq!(panel::uptime(60 * m), "up 1 hour");
    assert_eq!(panel::uptime(5 * 60 * m + 10 * m), "up 5 hours");
    assert_eq!(panel::uptime(DAY), "up 1 day");
    assert_eq!(panel::uptime(2 * DAY + 3 * 60 * m), "up 2 days");
}

#[test]
fn a_paired_host_is_named_by_its_address() {
    assert_eq!(panel::host_name("https://studio-desktop.local:7443"), "studio-desktop.local");
    assert_eq!(panel::host_name("https://build-box.example/"), "build-box.example");
    assert_eq!(panel::host_name("wss://relay.tynn.ai/h/abc"), "relay.tynn.ai");
    assert_eq!(panel::host_name("10.0.0.5:7443"), "10.0.0.5");
}

#[test]
fn the_paired_hosts_are_read_from_the_runtime_folder_addresses_only() {
    let dir = std::env::temp_dir().join(format!("genie-panel-paired-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("device-hosts.json"), r#"{"hosts":["https://a.example","https://b.example",3,null]}"#).unwrap();
    assert_eq!(panel::read_paired(&dir), vec!["https://a.example".to_string(), "https://b.example".to_string()]);
    std::fs::write(dir.join("device-hosts.json"), "not json").unwrap();
    assert!(panel::read_paired(&dir).is_empty());
    std::fs::remove_dir_all(&dir).unwrap();
    assert!(panel::read_paired(&dir).is_empty(), "no file: none");
}

#[test]
fn the_panel_opens_above_a_bottom_taskbar_at_its_icon_and_below_a_top_bar() {
    // The mockup: a 520 x 640 desk, the taskbar's top at 596, the icon at x 431: the panel's right edge 16 px in.
    let desk = Rect { left: 0, top: 0, right: 520, bottom: 596 };
    assert_eq!(panel::place((431, 618), desk, (300, 470), 16), (204, 110));
    // A wide screen: the panel sits over its icon.
    let wide = Rect { left: 0, top: 0, right: 1920, bottom: 1032 };
    assert_eq!(panel::place((1500, 1050), wide, (300, 470), 12), (1350, 550));
    // Omarchy's Waybar at the top (Hyprland reserves its 26 px): under the bar, by the pointer.
    let top = Rect { left: 0, top: 26, right: 1280, bottom: 720 };
    assert_eq!(panel::place((1150, 13), top, (300, 470), 8), (972, 34));
    // A left taskbar: beside it.
    let left = Rect { left: 48, top: 0, right: 1280, bottom: 720 };
    assert_eq!(panel::place((20, 700), left, (300, 470), 12), (60, 238));
    // Never off screen, whatever the anchor.
    let (x, y) = panel::place((-500, -500), wide, (300, 470), 12);
    assert!(x >= 12 && y >= 12, "{x} {y}");
}

#[test]
fn the_tray_the_person_sees_is_the_panel() {
    let tray = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/tray.rs")).unwrap();
    // Windows: a click on the icon (either button) opens the panel; the platform menu is only the fallback.
    let click = tray.split("WM_TRAY =>").nth(1).expect("the icon's click handler").split("WM_SHOW_MENU =>").next().unwrap();
    assert!(click.contains("WM_LBUTTONUP") && click.contains("WM_RBUTTONUP"), "{click}");
    assert!(click.matches("open_panel(").count() >= 1, "a click opens the panel: {click}");
    assert!(!click.contains("Action::OpenGenie"), "a click no longer opens Genie behind the person's back: {click}");
    // Linux: the StatusNotifierItem's activation (a left click) opens the panel; its right-click menu is drawn by the
    // desktop's own tray from DBusMenu, which no webview can replace.
    let activate = tray.split("fn activate(").nth(1).expect("the activation").split("fn menu(").next().unwrap();
    assert!(activate.contains("open_panel("), "{activate}");
}

#[cfg(feature = "ui")]
#[test]
fn the_pages_are_the_mockups_markup_with_its_css_bundled_and_fetch_nothing() {
    let p = panel::panel(&mockup());
    let html = genie_launcher::ui::panel_html(&p);
    assert!(!html.contains("/*GENIE_CSS*/") && html.contains("C: Wish Orb"), "the CSS in place");
    assert!(html.contains("@media (prefers-reduced-motion: reduce)"));
    for class in ["class=\"menu", "m-head", "m-item", "m-sep", "m-label", "tb-lamp"] {
        assert!(html.contains(class), "the mockup's {class}");
    }
    assert!(html.contains("This computer’s host · running · 3 agents"), "the model is in the page");
    let pad = genie_launcher::ui::pad_html(&panel::pad(&mockup()));
    for part in ["pad-top", "hero hero-sm", "host-card", "class=\"tiles", "class=\"apps", "Genie Apps", "Coming soon", "Apps you add to Genie will show up here, ready to open.", "Your workspaces and agents", "Browse alongside your agents", "foot split"] {
        assert!(pad.contains(part), "the pad has {part}");
    }
    for page in [&html, &pad] {
        for bad in ["src=\"http", "href=\"http", "@import", "url(http", "fetch(", "XMLHttpRequest", "innerHTML"] {
            assert!(!page.contains(bad), "a page names {bad}");
        }
    }
    // The model goes in as a script literal: no text of it can close the script element.
    let mut f = mockup();
    f.paired = vec!["https://x</script><b>".to_string()];
    assert!(!genie_launcher::ui::panel_html(&panel::panel(&f)).contains("x</script><b>"));
}

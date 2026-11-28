//! THE SETUP WINDOW (Tynn #1058 L3): the owner's direction C, "Wish Orb" (sandbox/launcher-design/direction-c.html,
//! screens 1a choose, 1b installing, 1c ready), rendered from assets bundled in the launcher (`ui/`) in the platform
//! webview: WebView2 on Windows, WebKitGTK on Linux. The page has no network and loads nothing: its HTML and the mockup's
//! own CSS are compiled in.
//!
//! NSIS cannot host a webview for its install step cleanly (no supported WebView2 plugin), and the Linux launcher has no
//! installer around it at all, so the installer does the bare install (the launcher at Genie.exe and its packages beside
//! it) and the launcher shows these screens itself on its first run: `genie setup --from <packages>`, or `Genie.exe` alone
//! when nothing is installed and its packages are beside it. A silent install (`/S`, `install --from`) shows none.
//!
//! The window asks the profile, installs (`install::install_from_with`, each manifest checked, then each file, with its
//! progress on the ring and the bar), starts the host (profile both), and on Open Genie closes; the caller then opens the
//! client window and becomes the launcher. Its words for a failure are the install's own.

use crate::install::{install_from_with, InstallOptions, Profile, Progress};
use crate::layout::{Roots, Track};
use ed25519_dalek::VerifyingKey;
use serde_json::{json, Value};
use std::path::PathBuf;
use tao::dpi::LogicalSize;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::platform::run_return::EventLoopExtRunReturn;
use tao::window::WindowBuilder;
use wry::{WebContext, WebViewBuilder};

/// The setup page with the mockup's CSS in place.
pub fn setup_html() -> String {
    let css = format!("{}\n{}", include_str!("../ui/base.css"), include_str!("../ui/theme-c.css"));
    include_str!("../ui/setup.html").replace("/*GENIE_CSS*/", &css)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SetupOutcome {
    /// Installed, and the person pressed Open Genie: the profile installed.
    Opened(Profile),
    /// Closed before an install finished: nothing was installed, or the install failed (said in the window).
    Closed,
}

enum UserEvent {
    Ipc(String),
    Eval(String),
    Installed(Result<Profile, String>),
}

/// The steps as the window lists them, for this profile, and where the install is.
struct Steps {
    profile: Profile,
    checked: bool,
    files_total: usize,
    files_done: usize,
    host_files: (usize, usize),
    window_files: (usize, usize),
    starting_host: bool,
}

impl Steps {
    fn percent(&self) -> u32 {
        if !self.checked {
            return 2;
        }
        let files = if self.files_total == 0 { 1.0 } else { self.files_done as f64 / self.files_total as f64 };
        let span = if self.profile == Profile::Both { 85.0 } else { 93.0 };
        let p = 5.0 + files * span + if self.starting_host { 5.0 } else { 0.0 };
        p.min(99.0) as u32
    }
    fn view(&self) -> Value {
        let state = |done: bool, now: bool| if done { "done" } else if now { "now" } else { "todo" };
        // A step's words follow its state (the coordinator, 2026-11-26): "Install Genie" waiting, "Installing Genie…"
        // running, "Installed Genie" done; never a done word on a running row.
        let step = |id: &str, st: &str, percent: Option<u32>| {
            let mut v = json!({"id": id, "label": step_label(id, st), "state": st});
            if let Some(p) = percent {
                v["percent"] = json!(p);
            }
            v
        };
        let windows_done = self.window_files.1 > 0 && self.window_files.0 >= self.window_files.1;
        let host_done = self.host_files.1 > 0 && self.host_files.0 >= self.host_files.1;
        let pct = |(d, o): (usize, usize)| if o == 0 { 0 } else { (d * 100 / o) as u32 };
        let mut steps = vec![
            step("check", state(self.checked, !self.checked), None),
            step("client", state(windows_done, self.checked && !windows_done), Some(pct(self.window_files))),
        ];
        let sub;
        if self.profile == Profile::Both {
            steps.push(step("host", state(host_done, windows_done && !host_done), Some(pct(self.host_files))));
            steps.push(step("start", state(false, self.starting_host), None));
            sub = if self.starting_host { "Starting your host." } else if !self.checked { "Checking that everything is from Genie." } else { "About a minute left." };
        } else {
            sub = if !self.checked { "Checking that everything is from Genie." } else { "Almost there." };
        }
        json!({"percent": self.percent(), "sub": sub, "steps": steps})
    }
}

/// Where a person gets Genie's installer: the releases of the repository every installed Genie trusts.
pub const DOWNLOAD_URL: &str = "https://github.com/Renaissance-Analytics/genie/releases/latest";

/// Opens the download page in the person's browser, through the OS's own opener (ShellExecuteW; GTK's show_uri): no
/// shell, no PATH search, a fixed https address.
fn open_download_page(window: &tao::window::Window) -> Result<(), String> {
    #[cfg(windows)]
    {
        let _ = window;
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
        let (op, url) = (wide("open"), wide(DOWNLOAD_URL));
        let r = unsafe { ShellExecuteW(std::ptr::null_mut(), op.as_ptr(), url.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL) };
        if (r as isize) <= 32 { Err(format!("the download page could not be opened (error {})", r as isize)) } else { Ok(()) }
    }
    #[cfg(unix)]
    {
        use tao::platform::unix::WindowExtUnix;
        gtk::show_uri_on_window(Some(window.gtk_window()), DOWNLOAD_URL, 0).map_err(|e| format!("the download page could not be opened: {e}"))
    }
}

/// The failure in words a person acts on, with the launcher's own words kept for Show details. `retry` is false when
/// trying again cannot help; `get` offers the right installer (another channel, not Genie's, damaged).
pub fn failure_view(why: &str) -> Value {
    let channel = why.find("(channel ").and_then(|at| {
        let rest = &why[at + "(channel ".len()..];
        let got = rest.split(',').next()?.trim().to_string();
        let wants = rest.split("this install reads ").nth(1)?.split(')').next()?.trim().to_string();
        Some((got, wants))
    });
    let is_channel = channel.is_some();
    let (title, words, retry): (&str, String, bool) = if let Some((got, wants)) = channel {
        ("This is the wrong installer", format!("This installer is for a different Genie channel ({got}). Download the {wants} installer."), false)
    } else if why.contains("signature is not Genie's") {
        ("This installer isn’t Genie’s", "This installer isn’t signed by Genie, so nothing was installed. Download Genie again from its own page.".to_string(), false)
    } else if why.contains("do not match its signed manifest") {
        ("This installer is damaged", "A file in this installer isn’t the one Genie signed, so nothing was installed. Download the installer again.".to_string(), false)
    } else if why.contains("is not newer than") {
        ("Genie is already installed", "This version of Genie is already on this computer.".to_string(), false)
    } else if why.contains("needs a newer launcher") {
        ("This installer needs a newer Genie", "Update Genie first, then run this installer again.".to_string(), false)
    } else if why.contains("host did not start") || why.contains("host exited before") {
        ("Genie’s host didn’t start", "Genie is installed, but its host didn’t start. Try again; if it keeps happening, the host’s log is under Show details.".to_string(), true)
    } else {
        ("Genie could not be set up", "Something stopped the install. Try again.".to_string(), true)
    };
    let get = is_channel || why.contains("signature is not Genie's") || why.contains("do not match its signed manifest");
    json!({"title": title, "words": words, "detail": why, "retry": retry, "get": get})
}

/// A step's words in each state: waiting (`todo`), running (`now`), `done`, and `failed` (the failure screen's).
pub fn step_label(id: &str, state: &str) -> &'static str {
    match (id, state) {
        ("check", "now") => "Checking that everything is from Genie…",
        ("check", "done") => "Checked that everything is from Genie",
        ("check", "failed") => "Couldn’t confirm this package",
        ("check", _) => "Check that everything is from Genie",
        ("client", "now") => "Installing Genie…",
        ("client", "done") => "Installed Genie",
        ("client", "failed") => "Couldn’t install Genie",
        ("client", _) => "Install Genie",
        ("host", "now") => "Installing the host…",
        ("host", "done") => "Installed the host",
        ("host", "failed") => "Couldn’t install the host",
        ("host", _) => "Install the host",
        ("start", "now") => "Starting the host…",
        ("start", "done") => "Host started",
        ("start", "failed") => "The host didn’t start",
        ("start", _) => "Start the host",
        _ => "",
    }
}

/// Every step's words in every state, for the page's failure screen (it marks the running step failed).
pub fn failed_labels() -> Value {
    json!({"check": step_label("check", "failed"), "client": step_label("client", "failed"), "host": step_label("host", "failed"), "start": step_label("start", "failed")})
}

fn eval(proxy: &EventLoopProxy<UserEvent>, call: &str, arg: &Value) {
    let _ = proxy.send_event(UserEvent::Eval(format!("window.genieSetup && window.genieSetup.{call}({arg})")));
}

/// The install in its own thread, its progress said in the window.
fn install(proxy: EventLoopProxy<UserEvent>, roots: Roots, mut options: InstallOptions, keys: Vec<VerifyingKey>, profile: Profile) {
    options.profile = profile;
    std::thread::spawn(move || {
        let mut steps = Steps { profile, checked: false, files_total: 0, files_done: 0, host_files: (0, 0), window_files: (0, 0), starting_host: false };
        eval(&proxy, "progress", &steps.view());
        let mut last = std::time::Instant::now();
        let mut window_done: std::collections::BTreeMap<&'static str, (usize, usize)> = Default::default();
        let result = install_from_with(&roots, &options, &keys, &mut |p| {
            match p {
                Progress::Checked { files } => {
                    steps.checked = true;
                    steps.files_total = files;
                }
                Progress::File { track, done, of } => {
                    steps.files_done += 1;
                    match track {
                        Track::Host => steps.host_files = (done, of),
                        Track::Client | Track::Browser => {
                            window_done.insert(track.as_str(), (done, of));
                            steps.window_files = window_done.values().fold((0, 0), |a, b| (a.0 + b.0, a.1 + b.1));
                        }
                        Track::Launcher => {}
                    }
                }
            }
            if last.elapsed() >= std::time::Duration::from_millis(120) || matches!(p, Progress::Checked { .. }) {
                last = std::time::Instant::now();
                eval(&proxy, "progress", &steps.view());
            }
        });
        let result = result.and_then(|_| {
            if profile == Profile::Both {
                steps.starting_host = true;
                eval(&proxy, "progress", &steps.view());
                crate::host::ensure_host(&roots, &keys).map(|_| ())
            } else {
                Ok(())
            }
        });
        let _ = proxy.send_event(UserEvent::Installed(result.map(|_| profile)));
    });
}

/// Shows the setup window until the person opens Genie or closes it. `options.from` holds the packages.
pub fn run_setup(roots: &Roots, options: InstallOptions, keys: Vec<VerifyingKey>) -> Result<SetupOutcome, String> {
    // WEBKITGTK WITHOUT A GPU DRAWS NOTHING (measured, item 1126-102126-14ccd0: the setup window took keys and installed,
    // and showed nothing; EGL could not start). Its DMA-BUF renderer and accelerated compositing are off for this small,
    // static window, unless the person set them: it is drawn on the CPU on every machine.
    #[cfg(unix)]
    for (k, v) in [("WEBKIT_DISABLE_DMABUF_RENDERER", "1"), ("WEBKIT_DISABLE_COMPOSITING_MODE", "1")] {
        if std::env::var_os(k).is_none() {
            std::env::set_var(k, v);
        }
    }
    let mut event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let window = WindowBuilder::new()
        .with_title("Set up Genie")
        .with_inner_size(LogicalSize::new(520.0, 640.0))
        .with_resizable(false)
        .with_decorations(false)
        .build(&event_loop)
        .map_err(|e| format!("the setup window could not be made: {e}"))?;
    let proxy = event_loop.create_proxy();
    let ipc = proxy.clone();
    // The webview's own data (WebView2's cache) under the data root, never beside the launcher in the NSIS folder.
    let data: PathBuf = roots.data.join("launcher").join("webview");
    let mut context = WebContext::new(Some(data));
    let builder = WebViewBuilder::new_with_web_context(&mut context)
        .with_html(setup_html())
        .with_ipc_handler(move |req: wry::http::Request<String>| {
            let _ = ipc.send_event(UserEvent::Ipc(req.body().clone()));
        });
    #[cfg(windows)]
    let webview = builder.build(&window).map_err(|e| format!("the setup window's webview (WebView2) could not start: {e}"))?;
    #[cfg(unix)]
    let webview = {
        // Into tao's own box: the window already holds it, and a GTK window holds one child (measured, item
        // 1126-094349-6c2f68: "a GtkApplicationWindow can only contain one widget at a time", and no window showed).
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        let vbox = window.default_vbox().ok_or("the setup window has no GTK box for its webview")?;
        builder.build_gtk(vbox).map_err(|e| format!("the setup window's webview (WebKitGTK) could not start: {e}"))?
    };
    // Each screen as it comes, on the launcher's output: the rows read it (WebKitGTK has no CDP), and so does a person's log.
    println!("setup: choose");
    let mut outcome = SetupOutcome::Closed;
    let mut installing = false;
    let mut installed: Option<Profile> = None;
    event_loop.run_return(|event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => {
                if !installing {
                    *control_flow = ControlFlow::Exit;
                }
            }
            Event::UserEvent(UserEvent::Eval(js)) => {
                let _ = webview.evaluate_script(&js);
            }
            Event::UserEvent(UserEvent::Installed(result)) => {
                installing = false;
                match result {
                    Ok(p) => {
                        println!("setup: ready ({})", p.as_str());
                        installed = Some(p);
                        eval(&proxy, "ready", &json!({"profile": p.as_str()}));
                    }
                    Err(why) => {
                        println!("setup: failed: {why}");
                        let mut view = failure_view(&why);
                        view["failedLabels"] = failed_labels();
                        eval(&proxy, "failed", &view)
                    }
                }
            }
            Event::UserEvent(UserEvent::Ipc(body)) => {
                let msg: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
                match msg["kind"].as_str() {
                    Some("drag") => {
                        let _ = window.drag_window();
                    }
                    Some("minimize") => window.set_minimized(true),
                    Some("close") if !installing => *control_flow = ControlFlow::Exit,
                    Some("install") if !installing && installed.is_none() => {
                        let profile = msg["profile"].as_str().and_then(Profile::parse).unwrap_or(Profile::Both);
                        installing = true;
                        println!("setup: installing ({})", profile.as_str());
                        install(proxy.clone(), roots.clone(), options.clone(), keys.clone(), profile);
                    }
                    Some("get-installer") => match open_download_page(&window) {
                        Ok(()) => println!("setup: opened the download page {DOWNLOAD_URL}"),
                        Err(why) => println!("setup: {why}"),
                    },
                    Some("retry") if !installing && installed.is_none() => {
                        println!("setup: choose (again)");
                        eval(&proxy, "reset", &Value::Null);
                    }
                    Some("open") => {
                        if let Some(p) = installed {
                            println!("setup: open");
                            outcome = SetupOutcome::Opened(p);
                            *control_flow = ControlFlow::Exit;
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    });
    drop(webview);
    drop(window);
    Ok(outcome)
}

// --- L5 (Tynn #1058): the launcher's questions ----------------------------------------------------------------------

/// A question the launcher asks before it stops anything from the tray (tray.rs): Cancel is always the default.
pub use crate::tray::Question;

/// The question's page: the mockup's CSS and the question in place.
pub fn prompt_html(q: &Question) -> String {
    let css = format!("{}\n{}", include_str!("../ui/base.css"), include_str!("../ui/theme-c.css"));
    let data = json!({"title": q.title, "lead": q.lead, "stops": q.stops, "note": q.note, "confirm": q.confirm});
    // As a script literal: `<` escaped, so no text of the question can close the script element.
    let literal = data.to_string().replace('<', "\\u003c");
    include_str!("../ui/prompt.html").replace("/*GENIE_CSS*/", &css).replace("/*GENIE_PROMPT*/null", &literal)
}

enum Resident {
    Ask(Question, std::sync::mpsc::Sender<bool>),
    Ipc(tao::window::WindowId, String),
    /// L6: the Updates window opened (or brought forward).
    ShowUpdates(std::sync::Arc<crate::control::Context>),
    /// L6: what the open Updates window shows now.
    UpdatesView(Value),
}

// --- L6 (Tynn #1058): the Updates window -----------------------------------------------------------------------------

/// The Updates page with the mockup's CSS and what it shows first in place.
pub fn updates_html(first: &Value) -> String {
    let css = format!("{}\n{}", include_str!("../ui/base.css"), include_str!("../ui/theme-c.css"));
    let literal = first.to_string().replace('<', "\\u003c");
    include_str!("../ui/updates.html").replace("/*GENIE_CSS*/", &css).replace("/*GENIE_UPDATES*/null", &literal)
}

/// What the Updates window is given: `launcher.updates`, and whether a check is running.
fn updates_data(ctx: &crate::control::Context, checking: bool) -> Value {
    let mut v = crate::updates::view(&ctx.updates, &ctx.roots);
    v["checking"] = json!(checking);
    v
}

/// Opens the launcher's Updates window, or brings it forward: `false` when this launcher has no window loop.
pub fn show_updates(ctx: std::sync::Arc<crate::control::Context>) -> bool {
    let Some(proxy) = RESIDENT.get().and_then(|p| p.lock().ok().map(|p| p.clone())) else { return false };
    proxy.send_event(Resident::ShowUpdates(ctx)).is_ok()
}

static UPDATES_OPEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static CHECKING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// The window's buttons, each acted on off the window's thread (a host's drain or a download takes a while).
fn updates_act(ctx: std::sync::Arc<crate::control::Context>, msg: Value, proxy: EventLoopProxy<Resident>) {
    use std::sync::atomic::Ordering;
    std::thread::spawn(move || {
        let kind = msg["kind"].as_str().unwrap_or("");
        eprintln!("genie: updates window: {kind} {}", msg["track"].as_str().unwrap_or(""));
        match kind {
            "check" => {
                CHECKING.store(true, Ordering::SeqCst);
                let _ = proxy.send_event(Resident::UpdatesView(updates_data(&ctx, true)));
                if let Err(why) = crate::updates::check_with_tools(&ctx.updates, &ctx.roots) {
                    eprintln!("genie: updates window: the check failed: {why}");
                }
                CHECKING.store(false, Ordering::SeqCst);
            }
            "apply" => {
                if let Some(track) = msg["track"].as_str().and_then(Track::parse) {
                    if let Err(why) = crate::control::apply_track(&ctx, track) {
                        eprintln!("genie: updates window: {why}");
                    }
                }
            }
            // A host's tool (L7): the host's installer asked; the window redraws from the host's rows as it moves.
            "applyTool" => {
                if let Err(why) = crate::updates::apply_tool(&ctx.roots, &msg) {
                    eprintln!("genie: updates window: {why}");
                }
                crate::updates::tools_changed(&ctx.updates);
            }
            "applyAll" => {
                // The client and the browser first (nothing stops), then the host (its drain), the launcher last (it hands over).
                let v = crate::updates::view(&ctx.updates, &ctx.roots);
                let ready = |t: &str| v["tracks"].as_array().map_or(false, |rows| rows.iter().any(|r| r["track"] == t && r["state"] == "ready"));
                for track in [Track::Client, Track::Browser, Track::Host, Track::Launcher] {
                    if ready(track.as_str()) {
                        if let Err(why) = crate::control::apply_track(&ctx, track) {
                            eprintln!("genie: updates window: {why}");
                        }
                    }
                }
            }
            "openGenie" => {
                if let Err(why) = crate::control::open_window(&ctx) {
                    eprintln!("genie: updates window: Open Genie: {why}");
                }
            }
            "hostLog" => {
                let log = crate::host::host_log(&ctx.roots);
                let path = log.display().to_string().replace('\\', "/");
                let uri = if path.starts_with('/') { format!("file://{path}") } else { format!("file:///{path}") };
                if let Err(why) = open_with_the_os(&uri) {
                    eprintln!("genie: updates window: the host's log: {why}");
                }
            }
            _ => {}
        }
        let _ = proxy.send_event(Resident::UpdatesView(updates_data(&ctx, CHECKING.load(Ordering::SeqCst))));
    });
}

/// A fixed address opened by the OS's own opener (ShellExecuteW; GTK's show_uri): no shell, no PATH search.
fn open_with_the_os(uri: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
        let (op, target) = (wide("open"), wide(uri));
        let r = unsafe { ShellExecuteW(std::ptr::null_mut(), op.as_ptr(), target.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL) };
        if (r as isize) <= 32 { Err(format!("{uri} could not be opened (error {})", r as isize)) } else { Ok(()) }
    }
    #[cfg(unix)]
    {
        gtk::show_uri_on_window(None::<&gtk::Window>, uri, 0).map_err(|e| format!("{uri} could not be opened: {e}"))
    }
}

static RESIDENT: std::sync::OnceLock<std::sync::Mutex<EventLoopProxy<Resident>>> = std::sync::OnceLock::new();

/// Asks the question in a window of the launcher's own and waits for the answer: `Some(true)` to go on, `Some(false)` for
/// Cancel, Esc or a closed window; `None` when this launcher has no window to ask in (then nothing is stopped).
pub fn ask(q: Question) -> Option<bool> {
    let proxy = RESIDENT.get()?.lock().ok()?.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    proxy.send_event(Resident::Ask(q, tx)).ok()?;
    rx.recv().ok()
}

/// THE LAUNCHER'S RESIDENT WINDOW LOOP, on the main thread for the launcher's whole life (the control wire is served on
/// another): each question opens a small window, centred and on top, and closes with its answer. `Err` when no window can
/// be shown here (no display, or the webview cannot start); it returns only then.
pub fn run_resident(data_dir: PathBuf) -> Result<(), String> {
    #[cfg(unix)]
    {
        if std::env::var_os("WAYLAND_DISPLAY").is_none() && std::env::var_os("DISPLAY").is_none() {
            return Err("no display (neither WAYLAND_DISPLAY nor DISPLAY)".to_string());
        }
        for (k, v) in [("WEBKIT_DISABLE_DMABUF_RENDERER", "1"), ("WEBKIT_DISABLE_COMPOSITING_MODE", "1")] {
            if std::env::var_os(k).is_none() {
                std::env::set_var(k, v);
            }
        }
        gtk::init().map_err(|e| format!("GTK could not start: {e}"))?;
    }
    let mut event_loop = EventLoopBuilder::<Resident>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    if RESIDENT.set(std::sync::Mutex::new(proxy.clone())).is_err() {
        return Err("the launcher's window loop is already running".to_string());
    }
    let mut context = WebContext::new(Some(data_dir));
    let mut open: std::collections::HashMap<tao::window::WindowId, (tao::window::Window, wry::WebView, std::sync::mpsc::Sender<bool>, String)> = Default::default();
    // L6: the Updates window, one at most, and the launcher it shows.
    let mut updates: Option<(tao::window::Window, wry::WebView, std::sync::Arc<crate::control::Context>)> = None;
    event_loop.run_return(|event, target, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(Resident::ShowUpdates(ctx)) => {
                if let Some((window, _, _)) = &updates {
                    window.set_minimized(false);
                    window.set_focus();
                    return;
                }
                let first = updates_data(&ctx, false);
                let made = (|| -> Result<(tao::window::Window, wry::WebView), String> {
                    let window = WindowBuilder::new()
                        .with_title("Updates")
                        .with_inner_size(LogicalSize::new(520.0, 640.0))
                        .with_resizable(false)
                        .with_decorations(false)
                        .build(target)
                        .map_err(|e| format!("the Updates window could not be made: {e}"))?;
                    if let Some(m) = window.current_monitor().or_else(|| window.primary_monitor()) {
                        let (ms, mp, ws) = (m.size(), m.position(), window.outer_size());
                        let x = mp.x + (ms.width.saturating_sub(ws.width) / 2) as i32;
                        let y = mp.y + (ms.height.saturating_sub(ws.height) / 2) as i32;
                        window.set_outer_position(tao::dpi::PhysicalPosition::new(x, y));
                    }
                    let id = window.id();
                    let ipc = proxy.clone();
                    let builder = WebViewBuilder::new_with_web_context(&mut context).with_html(updates_html(&first)).with_ipc_handler(move |req: wry::http::Request<String>| {
                        let _ = ipc.send_event(Resident::Ipc(id, req.body().clone()));
                    });
                    #[cfg(windows)]
                    let webview = builder.build(&window).map_err(|e| format!("the Updates webview (WebView2) could not start: {e}"))?;
                    #[cfg(unix)]
                    let webview = {
                        use tao::platform::unix::WindowExtUnix;
                        use wry::WebViewBuilderExtUnix;
                        let vbox = window.default_vbox().ok_or("the Updates window has no GTK box for its webview")?;
                        builder.build_gtk(vbox).map_err(|e| format!("the Updates webview (WebKitGTK) could not start: {e}"))?
                    };
                    window.set_focus();
                    Ok((window, webview))
                })();
                match made {
                    Ok((window, webview)) => {
                        updates = Some((window, webview, std::sync::Arc::clone(&ctx)));
                        UPDATES_OPEN.store(true, std::sync::atomic::Ordering::SeqCst);
                        // Once a second while it is open: what it shows, from the launcher's own view (no network).
                        let proxy = proxy.clone();
                        std::thread::spawn(move || {
                            while UPDATES_OPEN.load(std::sync::atomic::Ordering::SeqCst) {
                                std::thread::sleep(std::time::Duration::from_secs(1));
                                let _ = proxy.send_event(Resident::UpdatesView(updates_data(&ctx, CHECKING.load(std::sync::atomic::Ordering::SeqCst))));
                            }
                        });
                    }
                    Err(why) => eprintln!("genie: {why}"),
                }
            }
            Event::UserEvent(Resident::UpdatesView(v)) => {
                if let Some((_, webview, _)) = &updates {
                    let _ = webview.evaluate_script(&format!("window.render && window.render({})", v.to_string().replace('<', "\\u003c")));
                }
            }
            Event::UserEvent(Resident::Ipc(id, body)) if updates.as_ref().map_or(false, |(w, _, _)| w.id() == id) => {
                let msg = serde_json::from_str::<Value>(&body).unwrap_or(Value::Null);
                match msg["kind"].as_str() {
                    Some("shown") => eprintln!("genie: the Updates window is shown"),
                    Some("drag") => {
                        if let Some((window, _, _)) = &updates {
                            let _ = window.drag_window();
                        }
                    }
                    Some("minimize") => {
                        if let Some((window, _, _)) = &updates {
                            window.set_minimized(true);
                        }
                    }
                    Some("close") | Some("later") => {
                        UPDATES_OPEN.store(false, std::sync::atomic::Ordering::SeqCst);
                        updates = None;
                    }
                    Some(_) => {
                        if let Some((_, _, ctx)) = &updates {
                            updates_act(std::sync::Arc::clone(ctx), msg, proxy.clone());
                        }
                    }
                    None => {}
                }
            }
            Event::WindowEvent { window_id, event: WindowEvent::CloseRequested, .. } if updates.as_ref().map_or(false, |(w, _, _)| w.id() == window_id) => {
                UPDATES_OPEN.store(false, std::sync::atomic::Ordering::SeqCst);
                updates = None;
            }
            Event::UserEvent(Resident::Ask(q, reply)) => {
                let made = (|| -> Result<(tao::window::Window, wry::WebView), String> {
                    let window = WindowBuilder::new()
                        .with_title("Genie")
                        .with_inner_size(LogicalSize::new(460.0, 440.0))
                        .with_resizable(false)
                        .with_decorations(false)
                        .with_always_on_top(true)
                        .build(target)
                        .map_err(|e| format!("the question's window could not be made: {e}"))?;
                    if let Some(m) = window.current_monitor().or_else(|| window.primary_monitor()) {
                        let (ms, mp, ws) = (m.size(), m.position(), window.outer_size());
                        let x = mp.x + (ms.width.saturating_sub(ws.width) / 2) as i32;
                        let y = mp.y + (ms.height.saturating_sub(ws.height) / 2) as i32;
                        window.set_outer_position(tao::dpi::PhysicalPosition::new(x, y));
                    }
                    let id = window.id();
                    let ipc = proxy.clone();
                    let builder = WebViewBuilder::new_with_web_context(&mut context).with_html(prompt_html(&q)).with_ipc_handler(move |req: wry::http::Request<String>| {
                        let _ = ipc.send_event(Resident::Ipc(id, req.body().clone()));
                    });
                    #[cfg(windows)]
                    let webview = builder.build(&window).map_err(|e| format!("the question's webview (WebView2) could not start: {e}"))?;
                    #[cfg(unix)]
                    let webview = {
                        use tao::platform::unix::WindowExtUnix;
                        use wry::WebViewBuilderExtUnix;
                        let vbox = window.default_vbox().ok_or("the question's window has no GTK box for its webview")?;
                        builder.build_gtk(vbox).map_err(|e| format!("the question's webview (WebKitGTK) could not start: {e}"))?
                    };
                    window.set_focus();
                    Ok((window, webview))
                })();
                match made {
                    Ok((window, webview)) => {
                        open.insert(window.id(), (window, webview, reply, q.title.clone()));
                    }
                    Err(why) => {
                        eprintln!("genie: {why}; nothing was stopped");
                        let _ = reply.send(false);
                    }
                }
            }
            Event::UserEvent(Resident::Ipc(id, body)) => {
                let kind = serde_json::from_str::<Value>(&body).ok().and_then(|v| v["kind"].as_str().map(str::to_string)).unwrap_or_default();
                match kind.as_str() {
                    "shown" => {
                        if let Some((_, _, _, title)) = open.get(&id) {
                            eprintln!("genie: asking: {title}");
                        }
                    }
                    "confirm" | "cancel" => {
                        if let Some((window, webview, reply, title)) = open.remove(&id) {
                            eprintln!("genie: {title}: {}", if kind == "confirm" { "confirmed" } else { "cancelled" });
                            let _ = reply.send(kind == "confirm");
                            drop(webview);
                            drop(window);
                        }
                    }
                    _ => {}
                }
            }
            Event::WindowEvent { window_id, event: WindowEvent::CloseRequested, .. } => {
                if let Some((window, webview, reply, _)) = open.remove(&window_id) {
                    let _ = reply.send(false);
                    drop(webview);
                    drop(window);
                }
            }
            _ => {}
        }
    });
    Err("the launcher's window loop ended".to_string())
}

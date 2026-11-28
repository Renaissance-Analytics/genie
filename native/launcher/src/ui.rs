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
    /// #1514: the tray panel opened for a click at this point (physical; the pointer when `None`), or closed when open.
    ShowPanel(std::sync::Arc<crate::control::Context>, Value, Option<(i32, i32)>),
    /// #1515: the launch pad opened (or brought forward).
    ShowPad(std::sync::Arc<crate::control::Context>, Value),
    /// What the open panel or pad shows now.
    View(Surface, Value),
    /// A click on an element of the panel's or the pad's page (`launcher.uiProbe`).
    Click(Surface, String),
    /// The panel or the pad closed.
    Close(Surface),
    /// Shown even though its page never said it had loaded (a slow webview never hides it altogether).
    Reveal(Surface),
    /// Every open question answered Cancel (a VM row's tidy-up, `launcher.uiProbe {cancelAsks}`).
    CancelAsks,
}

/// The launcher's UI log (`<data>/logs/genie-launcher-ui.log`): what the panel, the pad and the questions did, kept where a
/// launcher started by the installer's shell (no stderr anyone reads, on Windows) still leaves it. Set when one first opens.
static UI_LOG: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// A line said on stderr and kept in the UI log.
pub fn ui_log(line: &str) {
    eprintln!("{line}");
    if let Some(file) = UI_LOG.get() {
        use std::io::Write;
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(file) {
            let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
            let _ = writeln!(f, "{ms} {line}");
        }
    }
}

macro_rules! ui_say {
    ($($t:tt)*) => { $crate::ui::ui_log(&format!($($t)*)) };
}

/// The questions open now, by title (`launcher.uiProbe`: the tray panel's Stop asks first, as the menu's did).
static ASKING: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

fn set_asking(titles: Vec<String>) {
    if let Ok(mut held) = ASKING.lock() {
        *held = titles;
    }
}

/// The questions open now.
pub fn asking() -> Vec<String> {
    ASKING.lock().map(|a| a.clone()).unwrap_or_default()
}

/// Every open question answered Cancel.
pub fn cancel_asks() -> bool {
    resident().map_or(false, |p| p.send_event(Resident::CancelAsks).is_ok())
}

/// The tray panel or the launch pad, open.
struct OpenSurface {
    window: tao::window::Window,
    webview: wry::WebView,
    ctx: std::sync::Arc<crate::control::Context>,
    anchor: Option<(i32, i32)>,
    /// The window has had the focus (the panel closes when it loses it, not before it ever had it).
    focused: bool,
    shown: bool,
    size: (f64, f64),
}

/// How long after the panel closed on losing the focus a click on the icon is that same click (the panel stays closed:
/// the icon toggles it).
const PANEL_TOGGLE: std::time::Duration = std::time::Duration::from_millis(400);

/// A window for the panel or the pad, hidden until its page has said how it looks.
fn surface_window(target: &tao::event_loop::EventLoopWindowTarget<Resident>, context: &mut WebContext, proxy: &EventLoopProxy<Resident>, surface: Surface, html: String) -> Result<(tao::window::Window, wry::WebView), String> {
    let mut builder = WindowBuilder::new().with_resizable(false).with_decorations(false).with_visible(false);
    builder = match surface {
        // The panel: frameless, over everything, out of the taskbar, its corners the page's own (transparent around them).
        Surface::Panel => builder.with_title("Genie tray").with_inner_size(LogicalSize::new(300.0, 470.0)).with_always_on_top(true).with_transparent(true),
        Surface::Pad => builder.with_title("Genie").with_inner_size(LogicalSize::new(520.0, 640.0)),
    };
    if surface == Surface::Panel {
        #[cfg(windows)]
        {
            use tao::platform::windows::WindowBuilderExtWindows;
            builder = builder.with_skip_taskbar(true);
        }
        #[cfg(unix)]
        {
            use tao::platform::unix::WindowBuilderExtUnix;
            builder = builder.with_skip_taskbar(true);
        }
    }
    let window = builder.build(target).map_err(|e| format!("{}'s window could not be made: {e}", surface.name()))?;
    if surface == Surface::Pad {
        if let Some(m) = window.current_monitor().or_else(|| window.primary_monitor()) {
            let (ms, mp, ws) = (m.size(), m.position(), window.outer_size());
            window.set_outer_position(tao::dpi::PhysicalPosition::new(mp.x + (ms.width.saturating_sub(ws.width) / 2) as i32, mp.y + (ms.height.saturating_sub(ws.height) / 2) as i32));
        }
    }
    let id = window.id();
    let ipc = proxy.clone();
    let mut wb = WebViewBuilder::new_with_web_context(context).with_html(html).with_ipc_handler(move |req: wry::http::Request<String>| {
        let _ = ipc.send_event(Resident::Ipc(id, req.body().clone()));
    });
    wb = if surface == Surface::Panel { wb.with_transparent(true) } else { wb.with_background_color(CARD_BACKDROP) };
    #[cfg(windows)]
    let webview = wb.build(&window).map_err(|e| format!("{}'s webview (WebView2) could not start: {e}", surface.name()))?;
    #[cfg(unix)]
    let webview = {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        let vbox = window.default_vbox().ok_or_else(|| format!("{}'s window has no GTK box for its webview", surface.name()))?;
        wb.build_gtk(vbox).map_err(|e| format!("{}'s webview (WebKitGTK) could not start: {e}", surface.name()))?
    };
    // Shown regardless after 3 s, if its page never says it has loaded.
    let reveal = proxy.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(3));
        let _ = reveal.send_event(Resident::Reveal(surface));
    });
    Ok((window, webview))
}

fn eval_model(webview: &wry::WebView, call: &str, arg: &Value) {
    let _ = webview.evaluate_script(&format!("window.{call} && window.{call}({})", arg.to_string().replace('<', "\\u003c")));
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
        ui_say!("genie: updates window: {kind} {}", msg["track"].as_str().unwrap_or(""));
        match kind {
            "check" => {
                CHECKING.store(true, Ordering::SeqCst);
                let _ = proxy.send_event(Resident::UpdatesView(updates_data(&ctx, true)));
                if let Err(why) = crate::updates::check_with_tools(&ctx.updates, &ctx.roots) {
                    ui_say!("genie: updates window: the check failed: {why}");
                }
                CHECKING.store(false, Ordering::SeqCst);
            }
            "apply" => {
                if let Some(track) = msg["track"].as_str().and_then(Track::parse) {
                    if let Err(why) = crate::control::apply_track(&ctx, track) {
                        ui_say!("genie: updates window: {why}");
                    }
                }
            }
            // A host's tool (L7): the host's installer asked; the window redraws from the host's rows as it moves.
            "applyTool" => {
                if let Err(why) = crate::updates::apply_tool(&ctx.roots, &msg) {
                    ui_say!("genie: updates window: {why}");
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
                            ui_say!("genie: updates window: {why}");
                        }
                    }
                }
            }
            "openGenie" => {
                if let Err(why) = crate::control::open_window(&ctx) {
                    ui_say!("genie: updates window: Open Genie: {why}");
                }
            }
            "hostLog" => {
                let log = crate::host::host_log(&ctx.roots);
                let path = log.display().to_string().replace('\\', "/");
                let uri = if path.starts_with('/') { format!("file://{path}") } else { format!("file:///{path}") };
                if let Err(why) = open_with_the_os(&uri) {
                    ui_say!("genie: updates window: the host's log: {why}");
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
    // #1514/#1515: the tray panel and the launch pad, one of each at most.
    let mut panel: Option<OpenSurface> = None;
    let mut pad: Option<OpenSurface> = None;
    let mut panel_closed_at: Option<std::time::Instant> = None;
    fn close(slot: &mut Option<OpenSurface>, surface: Surface) {
        forget_shown(surface);
        if slot.take().is_some() {
            surface.open_flag().store(false, std::sync::atomic::Ordering::SeqCst);
            ui_say!("genie: {} closed", surface.name());
        }
    }
    event_loop.run_return(|event, target, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(Resident::ShowPanel(ctx, model, anchor)) => {
                if panel.is_some() {
                    ui_say!("genie: the tray panel was open: a click on the icon closes it");
                    close(&mut panel, Surface::Panel);
                    return;
                }
                if panel_closed_at.map_or(false, |t| t.elapsed() < PANEL_TOGGLE) {
                    ui_say!("genie: the tray panel closed on this same click: it stays closed");
                    return;
                }
                forget_shown(Surface::Panel);
                match surface_window(target, &mut context, &proxy, Surface::Panel, panel_html(&model)) {
                    Ok((window, webview)) => {
                        Surface::Panel.open_flag().store(true, std::sync::atomic::Ordering::SeqCst);
                        keep_current(Surface::Panel, std::sync::Arc::clone(&ctx), proxy.clone());
                        panel = Some(OpenSurface { window, webview, ctx, anchor, focused: false, shown: false, size: (300.0, 470.0) });
                    }
                    Err(why) => ui_say!("genie: {why}"),
                }
            }
            Event::UserEvent(Resident::ShowPad(ctx, model)) => {
                if let Some(p) = &pad {
                    eval_model(&p.webview, "render", &model);
                    p.window.set_minimized(false);
                    p.window.set_focus();
                    return;
                }
                forget_shown(Surface::Pad);
                match surface_window(target, &mut context, &proxy, Surface::Pad, pad_html(&model)) {
                    Ok((window, webview)) => {
                        Surface::Pad.open_flag().store(true, std::sync::atomic::Ordering::SeqCst);
                        keep_current(Surface::Pad, std::sync::Arc::clone(&ctx), proxy.clone());
                        pad = Some(OpenSurface { window, webview, ctx, anchor: None, focused: false, shown: false, size: (520.0, 640.0) });
                    }
                    Err(why) => ui_say!("genie: {why}"),
                }
            }
            Event::UserEvent(Resident::View(surface, model)) => {
                let slot = if surface == Surface::Panel { &panel } else { &pad };
                if let Some(s) = slot {
                    eval_model(&s.webview, "render", &model);
                }
            }
            Event::UserEvent(Resident::Click(surface, id)) => {
                let slot = if surface == Surface::Panel { &panel } else { &pad };
                if let Some(s) = slot {
                    eval_model(&s.webview, "genieClick", &Value::String(id));
                }
            }
            Event::UserEvent(Resident::Close(surface)) => {
                if surface == Surface::Panel { close(&mut panel, surface) } else { close(&mut pad, surface) }
            }
            Event::UserEvent(Resident::Reveal(surface)) => {
                let slot = if surface == Surface::Panel { &mut panel } else { &mut pad };
                if let Some(s) = slot.as_mut().filter(|s| !s.shown) {
                    s.shown = true;
                    s.window.set_visible(true);
                    let _ = s.webview.evaluate_script("setTimeout(function () { window.genieReport && window.genieReport(); }, 250)");
                    if surface == Surface::Panel {
                        place_panel(&s.window, s.anchor, s.size);
                    } else {
                        place_pad(&s.window);
                    }
                    s.window.set_focus();
                    ui_say!("genie: {} is shown before its page said it loaded", surface.name());
                }
            }
            Event::UserEvent(Resident::Ipc(id, body)) if panel.as_ref().map_or(false, |s| s.window.id() == id) || pad.as_ref().map_or(false, |s| s.window.id() == id) => {
                let surface = if panel.as_ref().map_or(false, |s| s.window.id() == id) { Surface::Panel } else { Surface::Pad };
                let msg = serde_json::from_str::<Value>(&body).unwrap_or(Value::Null);
                let slot = if surface == Surface::Panel { &mut panel } else { &mut pad };
                match msg["kind"].as_str() {
                    Some("shown") => {
                        if let Ok(mut held) = SHOWN.lock() {
                            held.retain(|(s, _)| *s != surface);
                            held.push((surface, msg.clone()));
                        }
                        let Some(s) = slot.as_mut() else { return };
                        let size = (msg["w"].as_f64().unwrap_or(s.size.0).max(1.0), msg["h"].as_f64().unwrap_or(s.size.1).max(1.0));
                        if surface == Surface::Panel && (size != s.size || !s.shown) {
                            s.size = size;
                            s.window.set_inner_size(LogicalSize::new(size.0, size.1));
                            place_panel(&s.window, s.anchor, size);
                        }
                        if !s.shown {
                            s.shown = true;
                            s.window.set_visible(true);
                    let _ = s.webview.evaluate_script("setTimeout(function () { window.genieReport && window.genieReport(); }, 250)");
                            s.window.set_focus();
                            if surface == Surface::Pad {
                                place_pad(&s.window);
                            }
                            ui_say!("genie: {} is shown: {}", surface.name(), msg["text"].as_str().unwrap_or("").replace('\n', " | "));
                        }
                    }
                    Some("drag") => {
                        if let Some(s) = slot.as_ref() {
                            let _ = s.window.drag_window();
                        }
                    }
                    Some("minimize") => {
                        if let Some(s) = slot.as_ref() {
                            s.window.set_minimized(true);
                        }
                    }
                    Some("close") => close(slot, surface),
                    Some("pick") => {
                        let Some(item) = msg["id"].as_str().map(str::to_string) else { return };
                        let Some(ctx) = slot.as_ref().map(|s| std::sync::Arc::clone(&s.ctx)) else { return };
                        // The panel closes once an item is chosen, as a menu does; "Start when I sign in" turns over in place.
                        if surface == Surface::Panel && item != "logon" {
                            close(slot, surface);
                        }
                        pick(surface, ctx, &item, proxy.clone());
                    }
                    _ => {}
                }
            }
            Event::WindowEvent { window_id, event: WindowEvent::Focused(focused), .. } if panel.as_ref().map_or(false, |s| s.window.id() == window_id) => {
                ui_say!("genie: the tray panel {} the focus", if focused { "has" } else { "lost" });
                if focused {
                    if let Some(s) = panel.as_mut() {
                        s.focused = true;
                    }
                } else if panel.as_ref().map_or(false, |s| s.focused) {
                    close(&mut panel, Surface::Panel);
                    panel_closed_at = Some(std::time::Instant::now());
                }
            }
            Event::WindowEvent { window_id, event: WindowEvent::CloseRequested, .. } if panel.as_ref().map_or(false, |s| s.window.id() == window_id) => close(&mut panel, Surface::Panel),
            Event::WindowEvent { window_id, event: WindowEvent::CloseRequested, .. } if pad.as_ref().map_or(false, |s| s.window.id() == window_id) => close(&mut pad, Surface::Pad),
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
                    Err(why) => ui_say!("genie: {why}"),
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
                    Some("shown") => ui_say!("genie: the Updates window is shown"),
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
            Event::UserEvent(Resident::CancelAsks) => {
                for (_, (window, webview, reply, title)) in open.drain() {
                    ui_say!("genie: {title}: cancelled");
                    let _ = reply.send(false);
                    drop(webview);
                    drop(window);
                }
                set_asking(Vec::new());
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
                        set_asking(open.values().map(|o| o.3.clone()).collect());
                    }
                    Err(why) => {
                        ui_say!("genie: {why}; nothing was stopped");
                        let _ = reply.send(false);
                    }
                }
            }
            Event::UserEvent(Resident::Ipc(id, body)) => {
                let kind = serde_json::from_str::<Value>(&body).ok().and_then(|v| v["kind"].as_str().map(str::to_string)).unwrap_or_default();
                match kind.as_str() {
                    "shown" => {
                        if let Some((_, _, _, title)) = open.get(&id) {
                            ui_say!("genie: asking: {title}");
                        }
                    }
                    "confirm" | "cancel" => {
                        if let Some((window, webview, reply, title)) = open.remove(&id) {
                            set_asking(open.values().map(|o| o.3.clone()).collect());
                            ui_say!("genie: {title}: {}", if kind == "confirm" { "confirmed" } else { "cancelled" });
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
                    set_asking(open.values().map(|o| o.3.clone()).collect());
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

// --- L9 (Tynn #1058): the migration's card ---------------------------------------------------------------------------

/// The card's page with the mockup's CSS in place: "Moving Genie to its new launcher… your agents keep working".
pub fn moving_html() -> String {
    let css = format!("{}
{}", include_str!("../ui/base.css"), include_str!("../ui/theme-c.css"));
    include_str!("../ui/moving.html").replace("/*GENIE_CSS*/", &css)
}

enum Card {
    /// The page has loaded: the window may be shown.
    Loaded,
    /// Not loaded within `CARD_LOAD_WAIT`: shown anyway, so a slow WebView2 never hides the card altogether.
    ShowAnyway,
    Close,
}

/// How long the card waits, hidden, for its page to load before it is shown regardless.
const CARD_LOAD_WAIT: std::time::Duration = std::time::Duration::from_secs(5);
/// The card's own backdrop (theme-c.css's body colour), behind the page while it loads.
const CARD_BACKDROP: (u8, u8, u8, u8) = (0x05, 0x04, 0x0f, 0xff);

/// THE MIGRATION'S CARD, on this (the main) thread: shown at once, centred and on top; `work` (the bridge's install and
/// hand-over) runs on another thread meanwhile; the card closes once the launcher has a client window attached
/// (`migrate::card_may_close`), or after `migrate::CARD_LIMIT`. With no window possible here (no display, no webview)
/// the work still runs, and the reason is the `Err`.
pub fn run_moving_card(roots: &Roots, work: Option<Box<dyn FnOnce() + Send>>) -> Result<(), String> {
    #[cfg(unix)]
    for (k, v) in [("WEBKIT_DISABLE_DMABUF_RENDERER", "1"), ("WEBKIT_DISABLE_COMPOSITING_MODE", "1")] {
        if std::env::var_os(k).is_none() {
            std::env::set_var(k, v);
        }
    }
    let shown = (|| -> Result<_, String> {
        #[cfg(unix)]
        if std::env::var_os("WAYLAND_DISPLAY").is_none() && std::env::var_os("DISPLAY").is_none() {
            return Err("no display".to_string());
        }
        let event_loop = EventLoopBuilder::<Card>::with_user_event().build();
        let window = WindowBuilder::new()
            .with_title("Genie")
            .with_inner_size(LogicalSize::new(460.0, 360.0))
            .with_resizable(false)
            .with_decorations(false)
            .with_always_on_top(true)
            // Hidden until its page has loaded (run 1128-012125-5d34ca: an empty white window for a frame or more).
            .with_visible(false)
            .build(&event_loop)
            .map_err(|e| format!("the card could not be made: {e}"))?;
        if let Some(m) = window.current_monitor().or_else(|| window.primary_monitor()) {
            let (ms, mp, ws) = (m.size(), m.position(), window.outer_size());
            window.set_outer_position(tao::dpi::PhysicalPosition::new(mp.x + (ms.width.saturating_sub(ws.width) / 2) as i32, mp.y + (ms.height.saturating_sub(ws.height) / 2) as i32));
        }
        let mut context = WebContext::new(Some(roots.data.join("launcher").join("webview")));
        let loaded = event_loop.create_proxy();
        let builder = WebViewBuilder::new_with_web_context(&mut context)
            .with_html(moving_html())
            .with_background_color(CARD_BACKDROP)
            .with_ipc_handler(move |req: wry::http::Request<String>| {
                if req.body() == "loaded" {
                    let _ = loaded.send_event(Card::Loaded);
                }
            });
        #[cfg(windows)]
        let webview = builder.build(&window).map_err(|e| format!("the card's webview (WebView2) could not start: {e}"))?;
        #[cfg(unix)]
        let webview = {
            use tao::platform::unix::WindowExtUnix;
            use wry::WebViewBuilderExtUnix;
            let vbox = window.default_vbox().ok_or("the card has no GTK box for its webview")?;
            builder.build_gtk(vbox).map_err(|e| format!("the card's webview (WebKitGTK) could not start: {e}"))?
        };
        Ok((event_loop, window, webview, context))
    })();
    let (mut event_loop, window, webview, context) = match shown {
        Ok(s) => s,
        Err(why) => {
            crate::migrate::log_line(roots, &format!("the moving card could not be shown ({why}); the move goes on without it"));
            if let Some(w) = work {
                w();
            }
            return Err(why);
        }
    };
    let anyway = event_loop.create_proxy();
    std::thread::spawn(move || {
        std::thread::sleep(CARD_LOAD_WAIT);
        let _ = anyway.send_event(Card::ShowAnyway);
    });
    let proxy = event_loop.create_proxy();
    let r = roots.clone();
    std::thread::spawn(move || {
        let started = std::time::Instant::now();
        if let Some(w) = work {
            w();
        }
        loop {
            let status = crate::control::call_running(&r, "launcher.status", json!([])).ok().flatten();
            if crate::migrate::card_may_close(status.as_ref()) {
                crate::migrate::log_line(&r, "the moving card closed: a client window is attached to the launcher");
                break;
            }
            if started.elapsed() >= crate::migrate::CARD_LIMIT {
                crate::migrate::log_line(&r, "the moving card closed: no client window within its limit");
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
        let _ = proxy.send_event(Card::Close);
    });
    let mut shown = false;
    event_loop.run_return(|event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(Card::Loaded) if !shown => {
                shown = true;
                window.set_visible(true);
                crate::migrate::log_line(roots, "the moving card is shown (its page loaded)");
                println!("moving: shown");
            }
            Event::UserEvent(Card::ShowAnyway) if !shown => {
                shown = true;
                window.set_visible(true);
                crate::migrate::log_line(roots, &format!("the moving card is shown before its page loaded ({} s)", CARD_LOAD_WAIT.as_secs()));
                println!("moving: shown");
            }
            Event::UserEvent(Card::Close) => *control_flow = ControlFlow::Exit,
            _ => {}
        }
    });
    println!("moving: closed");
    drop(webview);
    drop(window);
    drop(context);
    Ok(())
}

// --- Tynn #1058 (#1514, #1515): the tray panel and the launch pad -----------------------------------------------------

/// A page with the mockup's CSS and its first model in place (a script literal: `<` escaped, so no text of the model can
/// close the script element).
fn page_with_model(html: &str, model: &Value) -> String {
    let css = format!("{}\n{}", include_str!("../ui/base.css"), include_str!("../ui/theme-c.css"));
    html.replace("/*GENIE_CSS*/", &css).replace("/*GENIE_MODEL*/null", &model.to_string().replace('<', "\\u003c"))
}

/// The tray panel's page (`panel::panel`'s model), the mockup's tray screen.
pub fn panel_html(model: &Value) -> String {
    page_with_model(include_str!("../ui/panel.html"), model)
}

/// The launch pad's page (`panel::pad`'s model), the mockup's screen 0.
pub fn pad_html(model: &Value) -> String {
    page_with_model(include_str!("../ui/pad.html"), model)
}

/// The two windows: the tray panel and the launch pad.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Surface {
    Panel,
    Pad,
}

impl Surface {
    pub fn parse(name: &str) -> Option<Surface> {
        match name {
            "panel" => Some(Surface::Panel),
            "pad" => Some(Surface::Pad),
            _ => None,
        }
    }
    fn name(self) -> &'static str {
        match self {
            Surface::Panel => "the tray panel",
            Surface::Pad => "the launch pad",
        }
    }
    fn model(self, ctx: &crate::control::Context) -> Value {
        let f = crate::panel::facts(ctx);
        match self {
            Surface::Panel => crate::panel::panel(&f),
            Surface::Pad => crate::panel::pad(&f),
        }
    }
    fn open_flag(self) -> &'static std::sync::atomic::AtomicBool {
        match self {
            Surface::Panel => &PANEL_OPEN,
            Surface::Pad => &PAD_OPEN,
        }
    }
}

static PANEL_OPEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static PAD_OPEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// What each window's page last said it shows (its own words, read in the webview: `launcher.uiProbe`).
static SHOWN: std::sync::Mutex<Vec<(Surface, Value)>> = std::sync::Mutex::new(Vec::new());

fn resident() -> Option<EventLoopProxy<Resident>> {
    RESIDENT.get().and_then(|p| p.lock().ok().map(|p| p.clone()))
}

/// Opens the tray panel for a click at `anchor` (physical pixels; the pointer when `None`), or closes it when it is open:
/// `false` when this launcher has no window loop (the caller falls back to the platform's menu).
pub fn show_panel(ctx: std::sync::Arc<crate::control::Context>, anchor: Option<(i32, i32)>) -> bool {
    let _ = UI_LOG.set(ctx.roots.logs_dir().join("genie-launcher-ui.log"));
    let Some(proxy) = resident() else {
        ui_say!("genie: the tray panel: this launcher has no window loop");
        return false;
    };
    ui_say!("genie: the tray panel asked for (anchor {anchor:?})");
    let model = Surface::Panel.model(&ctx);
    proxy.send_event(Resident::ShowPanel(ctx, model, anchor)).is_ok()
}

/// Opens the launch pad, or brings it forward: `false` when this launcher has no window loop.
pub fn show_pad(ctx: std::sync::Arc<crate::control::Context>) -> bool {
    let _ = UI_LOG.set(ctx.roots.logs_dir().join("genie-launcher-ui.log"));
    let Some(proxy) = resident() else {
        ui_say!("genie: the launch pad: this launcher has no window loop");
        return false;
    };
    let model = Surface::Pad.model(&ctx);
    proxy.send_event(Resident::ShowPad(ctx, model)).is_ok()
}

/// Whether the window is open now.
pub fn is_open(surface: Surface) -> bool {
    surface.open_flag().load(std::sync::atomic::Ordering::SeqCst)
}

/// What the window's page last said it shows: `{text, items: [{id, label, enabled}], …}`.
pub fn shown(surface: Surface) -> Option<Value> {
    SHOWN.lock().ok()?.iter().find(|(s, _)| *s == surface).map(|(_, v)| v.clone())
}

/// A click on the element `data-id=<id>` of the window's page, as the person's click (the page's own handler runs): the
/// VM rows drive the windows with it (`launcher.uiProbe`, GENIE_LAUNCHER_TRAY_PROBE=1 only).
pub fn click(surface: Surface, id: &str) -> bool {
    resident().map_or(false, |p| p.send_event(Resident::Click(surface, id.to_string())).is_ok())
}

/// The window closed (a VM row's tidy-up).
pub fn close_surface(surface: Surface) -> bool {
    resident().map_or(false, |p| p.send_event(Resident::Close(surface)).is_ok())
}

/// Once every 2 s while the window is open: its model, from the launcher's own state, off the window's thread.
fn keep_current(surface: Surface, ctx: std::sync::Arc<crate::control::Context>, proxy: EventLoopProxy<Resident>) {
    std::thread::spawn(move || {
        while surface.open_flag().load(std::sync::atomic::Ordering::SeqCst) {
            std::thread::sleep(std::time::Duration::from_secs(2));
            if !surface.open_flag().load(std::sync::atomic::Ordering::SeqCst) {
                break;
            }
            let _ = proxy.send_event(Resident::View(surface, surface.model(&ctx)));
        }
    });
}

/// A click on one of the windows' items or buttons, acted on off the window's thread.
fn pick(surface: Surface, ctx: std::sync::Arc<crate::control::Context>, id: &str, proxy: EventLoopProxy<Resident>) {
    use crate::panel::Pick;
    ui_say!("genie: {}: {id}", surface.name());
    match crate::panel::pick(id) {
        Some(Pick::Act(action)) => crate::tray::act(ctx, action),
        Some(Pick::Logon) => {
            std::thread::spawn(move || {
                match crate::panel::toggle_logon(&ctx.roots) {
                    Ok(said) => ui_say!("genie: {}: start when I sign in: {said}", surface.name()),
                    Err(why) => ui_say!("genie: {}: start when I sign in: {why}", surface.name()),
                }
                let _ = proxy.send_event(Resident::View(surface, surface.model(&ctx)));
            });
        }
        Some(Pick::Pad) => {
            std::thread::spawn(move || {
                show_pad(ctx);
            });
        }
        Some(Pick::Host(url)) => {
            std::thread::spawn(move || {
                // Only a host this computer paired with: the page names it, the launcher's own list decides.
                if !crate::panel::read_paired(&ctx.roots.runtime_dir()).contains(&url) {
                    ui_say!("genie: {}: {url} is not a paired host", surface.name());
                    return;
                }
                if let Err(why) = crate::control::open_window_on(&ctx, &url) {
                    ui_say!("genie: {}: a window on {url}: {why}", surface.name());
                }
            });
        }
        None => ui_say!("genie: {}: nothing is {id:?}", surface.name()),
    }
}

/// What a window's page said is forgotten when it opens or closes: a reader never takes a closed window's words for a
/// new one's.
fn forget_shown(surface: Surface) {
    if let Ok(mut held) = SHOWN.lock() {
        held.retain(|(s, _)| *s != surface);
    }
}

/// The launch pad at its own size: Hyprland gave its floating window more than it asked for (630 x 674, run
/// 1128-083346-4f0fbb), so its socket sizes and centres it. Elsewhere the window is made at its size and centred.
fn place_pad(window: &tao::window::Window) {
    #[cfg(unix)]
    if hypr::running() {
        let title = window.title();
        std::thread::spawn(move || hypr::place_pad(&title, (520, 640)));
    }
    #[cfg(not(unix))]
    let _ = window;
}

/// The panel put where it belongs once its page says how big it is: against the tray it was opened from.
fn place_panel(window: &tao::window::Window, anchor: Option<(i32, i32)>, size: (f64, f64)) {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::POINT;
        use windows_sys::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST};
        use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
        let scale = window.scale_factor();
        let at = anchor.unwrap_or_else(|| {
            let mut p = POINT { x: 0, y: 0 };
            unsafe { GetCursorPos(&mut p) };
            (p.x, p.y)
        });
        let mut info: MONITORINFO = unsafe { std::mem::zeroed() };
        info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        let monitor = unsafe { MonitorFromPoint(POINT { x: at.0, y: at.1 }, MONITOR_DEFAULTTONEAREST) };
        if unsafe { GetMonitorInfoW(monitor, &mut info) } == 0 {
            return;
        }
        let w = info.rcWork;
        let work = crate::panel::Rect { left: w.left, top: w.top, right: w.right, bottom: w.bottom };
        let px = ((size.0 * scale).round() as i32, (size.1 * scale).round() as i32);
        let (x, y) = crate::panel::place(at, work, px, (12.0 * scale).round() as i32);
        window.set_outer_position(tao::dpi::PhysicalPosition::new(x, y));
    }
    #[cfg(unix)]
    {
        if hypr::running() {
            // Hyprland: a client cannot place its own window on Wayland; Hyprland's own socket does (no program run).
            let title = window.title();
            std::thread::spawn(move || hypr::place_panel(&title, (size.0.round() as i32, size.1.round() as i32)));
            return;
        }
        // Elsewhere (X11; a Wayland desktop that ignores it): by the pointer, as the platform allows.
        let at = anchor.or_else(|| window.cursor_position().ok().map(|p| (p.x as i32, p.y as i32)));
        if let (Some(at), Some(m)) = (at, window.current_monitor().or_else(|| window.primary_monitor())) {
            let (mp, ms) = (m.position(), m.size());
            let scale = window.scale_factor();
            let work = crate::panel::Rect { left: mp.x, top: mp.y, right: mp.x + ms.width as i32, bottom: mp.y + ms.height as i32 };
            let px = ((size.0 * scale).round() as i32, (size.1 * scale).round() as i32);
            let (x, y) = crate::panel::place(at, work, px, (8.0 * scale).round() as i32);
            window.set_outer_position(tao::dpi::PhysicalPosition::new(x, y));
        }
    }
}

/// HYPRLAND'S OWN SOCKET (`$XDG_RUNTIME_DIR/hypr/<signature>/.socket.sock`): where the pointer is, the monitor's area
/// less its bars (`reserved`), and the panel moved there (`movewindowpixel exact`). Spoken directly: no hyprctl is run.
#[cfg(unix)]
mod hypr {
    use crate::panel::{place, Rect};
    use serde_json::Value;
    use std::io::{Read, Write};
    use std::os::unix::net::UnixStream;
    use std::path::PathBuf;

    fn socket() -> Option<PathBuf> {
        let sig = std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE")?;
        let mut places = Vec::new();
        if let Some(run) = std::env::var_os("XDG_RUNTIME_DIR") {
            places.push(PathBuf::from(run).join("hypr").join(&sig).join(".socket.sock"));
        }
        places.push(PathBuf::from("/tmp/hypr").join(&sig).join(".socket.sock"));
        places.into_iter().find(|p| p.exists())
    }

    pub fn running() -> bool {
        socket().is_some()
    }

    fn ask(request: &str) -> Option<String> {
        let mut s = UnixStream::connect(socket()?).ok()?;
        s.set_read_timeout(Some(std::time::Duration::from_secs(2))).ok()?;
        s.write_all(request.as_bytes()).ok()?;
        let mut out = String::new();
        s.read_to_string(&mut out).ok()?;
        Some(out)
    }

    fn json(request: &str) -> Option<Value> {
        serde_json::from_str(&ask(request)?).ok()
    }

    /// A monitor's area less what its bars reserve, in Hyprland's layout pixels.
    fn work_area(m: &Value) -> Option<Rect> {
        let scale = m["scale"].as_f64().filter(|s| *s > 0.0).unwrap_or(1.0);
        let (x, y) = (m["x"].as_i64()? as i32, m["y"].as_i64()? as i32);
        let (w, h) = ((m["width"].as_f64()? / scale) as i32, (m["height"].as_f64()? / scale) as i32);
        let r: Vec<i32> = m["reserved"].as_array().map(|a| a.iter().map(|v| v.as_i64().unwrap_or(0) as i32).collect()).unwrap_or_default();
        let g = |i: usize| r.get(i).copied().unwrap_or(0);
        Some(Rect { left: x + g(0), top: y + g(1), right: x + w - g(2), bottom: y + h - g(3) })
    }

    /// One dispatch, in the words this Hyprland reads: the legacy line (`movewindowpixel exact …`) first, and when the reply
    /// is Lua's (Hyprland 0.56 with a Lua config wraps it as `return hl.dispatch(…)` and says the legacy words do not
    /// parse), its Lua dispatcher. What it answered is returned, for the log.
    fn dispatch(legacy: &str, lua: &str) -> String {
        let one_line = |t: String| t.split_whitespace().collect::<Vec<_>>().join(" ");
        let said = one_line(ask(&format!("dispatch {legacy}")).unwrap_or_default());
        if said == "ok" {
            return said;
        }
        // Hyprland 0.56 (a Lua config): the dispatcher as `dispatch` wraps it (`return hl.dispatch(...)`), then as `eval`
        // (the queue's own way of speaking to it, `hyprctl eval`).
        let wrapped = one_line(ask(&format!("dispatch {lua}")).unwrap_or_default());
        if wrapped == "ok" || (!wrapped.is_empty() && !wrapped.contains("error")) {
            return format!("lua: {wrapped}");
        }
        let evaluated = one_line(ask(&format!("eval hl.dispatch({lua})")).unwrap_or_default());
        format!("{said} / lua: {wrapped} / eval: {evaluated}")
    }

    /// The window of this launcher with this title, as Hyprland lists it, once it has mapped (looked for up to 2 s).
    fn address_of(title: &str) -> Option<String> {
        let me = std::process::id() as u64;
        for _ in 0..40 {
            let found = json("j/clients").and_then(|c| {
                c.as_array()?.iter().find(|w| w["pid"].as_u64() == Some(me) && w["title"].as_str() == Some(title)).and_then(|w| w["address"].as_str().map(str::to_string))
            });
            if found.is_some() {
                return found;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        None
    }

    /// The monitor's work area under `at` (else the focused monitor's).
    fn work_at(at: (i32, i32)) -> Option<Rect> {
        let list = json("j/monitors").and_then(|m| m.as_array().cloned()).unwrap_or_default();
        let on = list.iter().find(|m| {
            let Some(a) = work_area(m) else { return false };
            let (x, y) = (m["x"].as_i64().unwrap_or(0) as i32, m["y"].as_i64().unwrap_or(0) as i32);
            at.0 >= x && at.0 < a.right + 1 && at.1 >= y && at.1 < a.bottom + 1
        });
        on.or_else(|| list.iter().find(|m| m["focused"] == true)).and_then(work_area)
    }

    /// The window sized and put at `(x, y)`, focused; for the panel also without Hyprland's border and shadow (its corners
    /// and its edge are the page's own). Each reply logged.
    fn fit(name: &str, address: &str, size: (i32, i32), at: (i32, i32), bare: bool) {
        let (w, h) = size;
        let (x, y) = at;
        let sel = format!("address:{address}");
        let mut said = vec![
            format!("size {}", dispatch(&format!("resizewindowpixel exact {w} {h},{sel}"), &format!("hl.dsp.window.resize({{ x = {w}, y = {h}, window = \"{sel}\" }})"))),
            format!("at {}", dispatch(&format!("movewindowpixel exact {x} {y},{sel}"), &format!("hl.dsp.window.move({{ x = {x}, y = {y}, window = \"{sel}\" }})"))),
        ];
        if bare {
            for (legacy, prop, value) in [("bordersize", "border_size", "0"), ("noshadow", "no_shadow", "1")] {
                said.push(format!("{prop} {}", dispatch(&format!("setprop {sel} {legacy} {value}"), &format!("hl.dsp.window.set_prop({{ prop = \"{prop}\", value = \"{value}\", window = \"{sel}\" }})"))));
            }
        }
        said.push(format!("focus {}", dispatch(&format!("focuswindow {sel}"), &format!("hl.dsp.focus({{ window = \"{sel}\" }})"))));
        ui_say!("genie: {name}: {w}x{h} at {x},{y}: {}", said.join("; "));
    }

    /// The tray panel, its page's size, by the pointer under (or over) the bar it was opened from.
    pub fn place_panel(title: &str, size: (i32, i32)) {
        let Some(address) = address_of(title) else {
            ui_say!("genie: the tray panel: Hyprland did not list its window, so it stays where Hyprland put it");
            return;
        };
        let Some(cursor) = json("j/cursorpos") else { return };
        let at = (cursor["x"].as_f64().unwrap_or(0.0) as i32, cursor["y"].as_f64().unwrap_or(0.0) as i32);
        let Some(work) = work_at(at) else { return };
        let pos = place(at, work, size, 8);
        ui_say!("genie: the tray panel: pointer {},{}; work area {work:?}", at.0, at.1);
        fit("the tray panel", &address, size, pos, true);
    }

    /// The launch pad at its own size (520 x 640), centred on the work area.
    pub fn place_pad(title: &str, size: (i32, i32)) {
        let Some(address) = address_of(title) else { return };
        let at = json("j/cursorpos").map(|c| (c["x"].as_f64().unwrap_or(0.0) as i32, c["y"].as_f64().unwrap_or(0.0) as i32)).unwrap_or((0, 0));
        let Some(work) = work_at(at) else { return };
        let pos = (work.left + ((work.right - work.left - size.0) / 2).max(0), work.top + ((work.bottom - work.top - size.1) / 2).max(0));
        fit("the launch pad", &address, size, pos, false);
    }
}

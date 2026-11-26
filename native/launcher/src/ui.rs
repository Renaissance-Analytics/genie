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
        let windows_done = self.window_files.1 > 0 && self.window_files.0 >= self.window_files.1;
        let host_done = self.host_files.1 > 0 && self.host_files.0 >= self.host_files.1;
        let pct = |(d, o): (usize, usize)| if o == 0 { 0 } else { (d * 100 / o) as u32 };
        let mut steps = vec![
            json!({"label": "Checked that everything is from Genie", "state": state(self.checked, !self.checked)}),
            json!({"label": "Installed Genie", "state": state(windows_done, self.checked && !windows_done), "percent": pct(self.window_files)}),
        ];
        let sub;
        if self.profile == Profile::Both {
            steps.push(json!({"label": "Installing the host", "state": state(host_done, windows_done && !host_done), "percent": pct(self.host_files)}));
            steps.push(json!({"label": "Starting the host", "state": state(false, self.starting_host)}));
            sub = if self.starting_host { "Starting your host." } else if !self.checked { "Checking that everything is from Genie." } else { "About a minute left." };
        } else {
            sub = if !self.checked { "Checking that everything is from Genie." } else { "Almost there." };
        }
        json!({"percent": self.percent(), "sub": sub, "steps": steps})
    }
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
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        builder.build_gtk(window.gtk_window()).map_err(|e| format!("the setup window's webview (WebKitGTK) could not start: {e}"))?
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
                        eval(&proxy, "failed", &Value::String(why))
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

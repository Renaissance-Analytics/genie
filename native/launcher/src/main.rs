//! `Genie.exe` / `genie`: the launcher's command line (Tynn #1058 L2).
//!
//!   genie                         open Genie, as the Start menu and the desktop entry run it: with a launcher already
//!                                 running, ask it for a window and exit; else run the launcher (one per user), start
//!                                 the host (profile both) and open a client window
//!   genie serve | --hidden        run the launcher alone: its control wire and its tray, until it is ended
//!   genie --logon                 what the logon entry runs (L5): the logon table decides; with nothing to start it exits
//!                                 (Genie stays down until it is opened), else the host and, unless start-minimised, a
//!                                 window, and the launcher stays in the tray
//!   genie setup --from <folder> [--channel stable|dev]
//!                                 the setup window (direction C): choose, install with its progress, ready, Open Genie.
//!                                 `genie` alone does the same on a machine with nothing installed and packages\ beside
//!                                 the launcher (the NSIS installer's bare install). Without a webview: the default
//!                                 profile, installed bare, said on the console
//!   genie --doctor                Genie's doctor mode: the client's --doctor, nothing else started
//!   genie uninstall [--yes]       stop the host gracefully and remove the programs folder (the data root is kept)
//!   genie install --from <folder> [--profile both|client] [--channel stable|dev] [--yes]
//!   genie status [--json]         what is installed and running
//!   genie ensure-host             adopt the running host or start the current one
//!   genie stop-host               the graceful stop
//!   genie close-ui                "Just close the UI": every client window closes; the host and the launcher keep running
//!   genie shut-down               "Shut down everything": the host's graceful stop, then the launcher exits (waited for)
//!   genie logon-settings on|off on|off   start on logon, start minimised: what the client says; the entry follows
//!   genie tray-menu | tray-act <action>  the tray's menu as words, and one of its items (GENIE_LAUNCHER_TRAY_PROBE=1 only:
//!                                 the VM rows' screenshots)
//!   genie version                 this launcher's build
//!   genie detach|job|pipe-owner-only ...   genie-launch.exe's modes (Windows), same contracts

use genie_launcher::{control, host, install, keys, layout::Roots, secure, LAUNCHER_BUILD, LAUNCH_FAILED};
use std::ffi::OsString;
use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    #[cfg(windows)]
    unsafe {
        // No DLL is loaded from the working folder or PATH: System32 only (the planted-DLL class of #1031's RCE).
        windows_sys::Win32::System::LibraryLoader::SetDefaultDllDirectories(windows_sys::Win32::System::LibraryLoader::LOAD_LIBRARY_SEARCH_SYSTEM32);
    }
    let args: Vec<OsString> = std::env::args_os().collect();
    let first = args.get(1).and_then(|a| a.to_str()).unwrap_or("");
    match first {
        "detach" | "job" | "pipe-owner-only" => return code(compat(first, &args)),
        _ => {}
    }
    let text: Vec<String> = match args.iter().skip(1).map(|a| a.to_str().map(str::to_owned)).collect::<Option<Vec<_>>>() {
        Some(t) => t,
        None => return fail("an argument is not valid Unicode"),
    };
    let roots = match Roots::from_env() {
        Ok(r) => r,
        Err(why) => return fail(&why),
    };
    // THE BRIDGE APPIMAGE (L9): run from its own mount, this launcher installs what it carries and hands over.
    #[cfg(unix)]
    if let Some(packages) = bridge_packages() {
        return cmd_bridge(roots, packages, text);
    }
    match text.first().map(String::as_str) {
        // `--updated`: what electron-updater's NSIS run starts the installed app with (L9: the bridge's installer
        // starts the launcher so), and Genie opens.
        None | Some("--updated") => cmd_open(roots),
        Some("--doctor") => match genie_launcher::components::component("client").ok_or_else(|| "no client component".to_string()).and_then(|c| control::start_component(&roots, c, vec!["--doctor".to_string()])) {
            Ok(_) => ExitCode::SUCCESS,
            Err(why) => fail(&why),
        },
        Some("uninstall") => cmd_uninstall(&roots),
        Some("setup") => {
            let mut from: Option<PathBuf> = None;
            let mut channel = "stable".to_string();
            let rest = &text[1..];
            let mut i = 0;
            while i < rest.len() {
                match (rest[i].as_str(), rest.get(i + 1)) {
                    ("--from", Some(v)) => from = Some(PathBuf::from(v)),
                    ("--channel", Some(v)) if v == "stable" || v == "dev" => channel = v.clone(),
                    (other, _) => return fail(&format!("setup: unknown option '{other}'")),
                }
                i += 2;
            }
            let Some(from) = from else { return fail("setup needs --from <folder>") };
            match cmd_setup(&roots, from, channel, false).and_then(|_| hand_over_to_installed(&roots)) {
                Ok(true) => ExitCode::SUCCESS,
                Ok(false) => cmd_open(roots),
                Err(why) => fail(&why),
            }
        }
        Some("--logon") => cmd_logon(roots),
        Some("serve") | Some("--hidden") => {
            if let Err(why) = private_code_root(&roots) {
                return fail(&why);
            }
            // `serve --handover <pid>` (L6): a new launcher taking over from the one that updated itself.
            let handover = match text.iter().position(|a| a == "--handover") {
                Some(i) => match text.get(i + 1).and_then(|p| p.parse::<u32>().ok()) {
                    Some(pid) => Some(pid),
                    None => return fail("--handover needs the old launcher's pid"),
                },
                None => None,
            };
            match control::serve_then(roots, handover, |_| {}) {
                Ok(()) => ExitCode::SUCCESS,
                Err(why) => fail(&why),
            }
        }
        Some("install") => cmd_install(&roots, &text[1..]),
        Some("status") => {
            let json = control::status(&roots);
            if text.iter().any(|a| a == "--json") {
                println!("{}", json);
            } else {
                println!("{}", serde_json::to_string_pretty(&json).unwrap_or_default());
            }
            ExitCode::SUCCESS
        }
        Some("ensure-host") => {
            if let Err(why) = private_code_root(&roots) {
                return fail(&why);
            }
            let keys = keys::trusted_keys(&roots);
            match host::ensure_host(&roots, &keys) {
                Ok(v) => {
                    println!("{}", v);
                    ExitCode::SUCCESS
                }
                Err(why) => fail(&why),
            }
        }
        Some("stop-host") => match host::stop_host(&roots) {
            Ok(v) => {
                println!("{}", v);
                ExitCode::SUCCESS
            }
            Err(why) => fail(&why),
        },
        Some("close-ui") => print_call(&roots, "launcher.closeUi", serde_json::json!([])),
        Some("shut-down") => cmd_shut_down(&roots),
        Some("logon-settings") => {
            let on = |v: Option<&String>| match v.map(String::as_str) {
                Some("on") => Some(true),
                Some("off") => Some(false),
                _ => None,
            };
            let (Some(setting), Some(start_minimized)) = (on(text.get(1)), on(text.get(2))) else {
                return fail("logon-settings <start on logon: on|off> <start minimised: on|off>");
            };
            let args = serde_json::json!([{"setting": setting, "startMinimized": start_minimized}]);
            match control::call_running(&roots, "launcher.logon", args) {
                Ok(Some(v)) => {
                    println!("{v}");
                    ExitCode::SUCCESS
                }
                Ok(None) => {
                    use genie_launcher::logon;
                    match logon::write_settings(&roots, logon::LogonSettings { setting, start_minimized }).and_then(|_| logon::entry_exe()).and_then(|exe| logon::apply(&roots, &logon::place(), &exe)) {
                        Ok(said) => {
                            println!("{said}");
                            ExitCode::SUCCESS
                        }
                        Err(why) => fail(&why),
                    }
                }
                Err(why) => fail(&why),
            }
        }
        Some("tray-menu") => print_call(&roots, "launcher.trayMenu", serde_json::json!([])),
        Some("tray-act") => match text.get(1) {
            Some(a) => print_call(&roots, "launcher.trayAct", serde_json::json!([{"action": a}])),
            None => fail("tray-act <openGenie|openBrowser|startHost|stopHost|closeUi|shutDown>"),
        },
        Some("version") | Some("--version") => {
            println!("{}", LAUNCHER_BUILD);
            ExitCode::SUCCESS
        }
        Some(other) => fail(&format!("unknown command '{other}' (install, status, ensure-host, stop-host, uninstall, version, --doctor, serve, or none to open Genie)")),
    }
}

/// Open Genie. A launcher already running is asked for a window; otherwise this one becomes the launcher, starts the host
/// when this computer has one (profile both), then opens a client window. A host that cannot start is said in the client
/// log's words and the window still opens (it shows the host as stopped: L4).
/// The packages the NSIS installer left beside the launcher for its first run.
fn packages_beside_me() -> Option<PathBuf> {
    let dir = std::env::current_exe().ok()?.parent()?.join("packages");
    dir.is_dir().then_some(dir)
}

/// The setup window (`ui`), or without one the default profile installed bare. On Linux the program running it is the
/// downloaded launcher, so once installed it hands over to the installed one (its own track's folder) and exits.
fn cmd_setup(roots: &Roots, from: PathBuf, channel: String, beside: bool) -> Result<(), String> {
    std::fs::create_dir_all(&roots.code).map_err(|e| format!("the programs folder {} could not be made: {e}", roots.code.display()))?;
    secure::check_private(&roots.code)?;
    let keys = keys::trusted_keys(roots);
    let options = install::InstallOptions { from: from.clone(), profile: install::Profile::Both, channel, launcher_build: LAUNCHER_BUILD.to_string() };
    #[cfg(feature = "ui")]
    let shown: Result<bool, String> = genie_launcher::ui::run_setup(roots, options.clone(), keys.clone()).map(|o| matches!(o, genie_launcher::ui::SetupOutcome::Opened(_)));
    #[cfg(not(feature = "ui"))]
    let shown: Result<bool, String> = Err("this launcher was built without its window".to_string());
    match shown {
        Ok(true) => {}
        Ok(false) => return Err("Genie was not set up: the setup window was closed before Genie was installed.".to_string()),
        Err(why) => {
            eprintln!("genie: {why}; installing Genie with this computer as a host, without the window");
            for d in install::install_from(roots, &options, &keys)? {
                println!("installed {} {}", d.track.as_str(), d.build);
            }
        }
    }
    if beside {
        let _ = std::fs::remove_dir_all(&from);
    }
    genie_launcher::migrate::carry_over_here(roots);
    Ok(())
}

/// On Linux the setup ran in the downloaded launcher: the installed one (in its own track's folder) takes over and opens
/// Genie, and this one exits. `true` when it handed over.
fn hand_over_to_installed(roots: &Roots) -> Result<bool, String> {
    if !cfg!(unix) {
        return Ok(false);
    }
    let me = std::env::current_exe().map_err(|e| e.to_string())?;
    if me.starts_with(&roots.code) {
        return Ok(false);
    }
    let st = genie_launcher::state::read(&roots.state_file())?;
    let Some(build) = st.track("launcher").and_then(|t| t.current.clone()) else { return Ok(false) };
    let program = roots.program(genie_launcher::layout::Track::Launcher, &build).ok_or("not a track build")?;
    genie_launcher::spawn::start_window(&program, &[], &[], &roots.logs_dir().join("genie-launcher.log"))?;
    Ok(true)
}

/// What the logon entry runs (Tynn #1058 L5): `logonEntry`'s table (logon.rs) decides whether the host starts and a window
/// opens; with neither, the launcher removes a stale entry and exits, so Genie stays down until it is opened.
fn cmd_logon(roots: Roots) -> ExitCode {
    use genie_launcher::logon;
    if let Err(why) = private_code_root(&roots) {
        return fail(&why);
    }
    let input = logon::input(&roots);
    let plan = logon::at_logon(logon::logon_entry(input));
    eprintln!("genie: at logon: left running {}, start on logon {}, start minimised {}: {}", input.left_running, input.setting, input.start_minimized,
        if !plan.start_host { "Genie stays down until it is opened" } else if plan.open_window { "the host starts and a window opens" } else { "the host starts; Genie stays in the tray" });
    if !plan.start_host && !plan.open_window {
        logon::apply_here(&roots);
        return ExitCode::SUCCESS;
    }
    let served = control::serve_then(roots, None, move |roots| {
        let has_host = genie_launcher::state::read(&roots.state_file()).ok().and_then(|s| s.track("host").and_then(|t| t.current.clone())).is_some();
        if plan.start_host && has_host {
            if let Err(why) = host::ensure_host(roots, &keys::trusted_keys(roots)) {
                eprintln!("genie: {why}");
            }
        }
        if plan.open_window {
            if let Err(why) = genie_launcher::components::component("client").ok_or_else(|| "no client component".to_string()).and_then(|c| control::start_component(roots, c, vec!["--open-window".to_string()])) {
                eprintln!("genie: {why}");
            }
        }
    });
    match served {
        Ok(()) => ExitCode::SUCCESS,
        Err(why) => fail(&why),
    }
}

fn cmd_open(roots: Roots) -> ExitCode {
    let installed = genie_launcher::state::read(&roots.state_file()).ok().and_then(|s| s.track("client").and_then(|t| t.current.clone())).is_some();
    if !installed {
        let Some(from) = packages_beside_me() else {
            return fail("Genie is not installed on this computer: run its installer, or `genie setup --from <packages>`.");
        };
        if let Err(why) = cmd_setup(&roots, from, "stable".to_string(), true) {
            return fail(&why);
        }
    }
    match control::call_running(&roots, "launcher.openWindow", serde_json::json!([])) {
        Ok(Some(_)) => return ExitCode::SUCCESS,
        Ok(None) => {}
        Err(why) => return fail(&why),
    }
    if let Err(why) = private_code_root(&roots) {
        return fail(&why);
    }
    let opened = control::serve_then(roots, None, |roots| {
        control::opened(roots);
        let has_host = genie_launcher::state::read(&roots.state_file()).ok().and_then(|s| s.track("host").and_then(|t| t.current.clone())).is_some();
        if has_host {
            if let Err(why) = host::ensure_host(roots, &keys::trusted_keys(roots)) {
                eprintln!("genie: {why}");
            }
        }
        if let Err(why) = genie_launcher::components::component("client").ok_or_else(|| "no client component".to_string()).and_then(|c| control::start_component(roots, c, vec!["--open-window".to_string()])) {
            eprintln!("genie: {why}");
        }
    });
    match opened {
        Ok(()) => ExitCode::SUCCESS,
        Err(why) => fail(&why),
    }
}

/// The NSIS uninstaller's (and Linux's) way out: the host stopped gracefully, then the running launcher ended (on Windows
/// it serves from the Genie.exe the uninstaller removes next), then what the launcher installed removed and nothing else
/// (uninstall.rs; the programs folder itself only when that leaves it empty). The data root
/// (`~/.genie`) is kept, as it always was (`deleteAppDataOnUninstall: false`).
fn cmd_uninstall(roots: &Roots) -> ExitCode {
    // NOTHING BUT WHAT THE LAUNCHER OWNS (Tynn #1058 L4): a code root that is a drive root, or is or holds the home folder
    // or the data root, is refused before anything is stopped or removed.
    if let Some(why) = genie_launcher::uninstall::refusal(&roots.code, &roots.data, genie_launcher::uninstall::home_from_env().as_deref()) {
        return fail(&why);
    }
    if let Err(why) = host::stop_host(roots) {
        return fail(&why);
    }
    if let Err(why) = end_running_launcher(roots) {
        return fail(&why);
    }
    #[cfg(unix)]
    genie_launcher::desktop::remove_entries(roots);
    match genie_launcher::uninstall::remove_owned(roots) {
        Ok(removed) => {
            for path in &removed {
                println!("removed {}", path.display());
            }
        }
        Err(why) => return fail(&format!("the programs folder {} was not fully removed: {why}", roots.code.display())),
    }
    if roots.code.exists() {
        println!("kept {}: it holds files Genie did not install", roots.code.display());
    }
    println!("uninstalled: {}", roots.code.display());
    ExitCode::SUCCESS
}

/// The launcher running for this user, ended (it holds no state: the host is stopped first). Only the pid launcher.json
/// names, never this process.
fn end_running_launcher(roots: &Roots) -> Result<(), String> {
    use genie_launcher::spawn::{end, pid_alive, wait_gone};
    let Some(pid) = std::fs::read_to_string(roots.runtime_dir().join("launcher.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v["pid"].as_u64())
        .map(|p| p as u32)
    else {
        return Ok(());
    };
    if pid == std::process::id() || !pid_alive(pid) {
        return Ok(());
    }
    end(pid);
    if wait_gone(pid, std::time::Duration::from_secs(10)) {
        Ok(())
    } else {
        Err(format!("Genie's launcher (pid {pid}) did not end, so its programs could not be removed."))
    }
}

/// One call to the running launcher, its answer printed.
fn print_call(roots: &Roots, method: &str, args: serde_json::Value) -> ExitCode {
    match control::call_running(roots, method, args) {
        Ok(Some(v)) => {
            println!("{v}");
            ExitCode::SUCCESS
        }
        Ok(None) => fail("Genie's launcher is not running."),
        Err(why) => fail(&why),
    }
}

/// "Shut down everything" from outside (an uninstaller, a script): asked of the running launcher, then waited for until it
/// has exited (it exits only after the host's graceful stop).
fn cmd_shut_down(roots: &Roots) -> ExitCode {
    let pid = std::fs::read_to_string(roots.runtime_dir().join("launcher.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v["pid"].as_u64())
        .map(|p| p as u32);
    match control::call_running(roots, "launcher.shutDown", serde_json::json!([])) {
        Ok(Some(_)) => {}
        Ok(None) => return fail("Genie's launcher is not running."),
        Err(why) => return fail(&why),
    }
    let Some(pid) = pid else { return ExitCode::SUCCESS };
    if genie_launcher::spawn::wait_gone(pid, std::time::Duration::from_secs(16 * 60)) {
        println!("shut down: the launcher (pid {pid}) has exited");
        ExitCode::SUCCESS
    } else {
        fail(&format!("the launcher (pid {pid}) is still running"))
    }
}

fn private_code_root(roots: &Roots) -> Result<(), String> {
    if roots.code.exists() {
        secure::check_private(&roots.code)
    } else {
        Ok(())
    }
}

fn cmd_install(roots: &Roots, rest: &[String]) -> ExitCode {
    let mut from: Option<PathBuf> = None;
    let mut profile = install::Profile::Both;
    let mut channel = "stable".to_string();
    let mut i = 0;
    while i < rest.len() {
        let value = rest.get(i + 1).cloned();
        match rest[i].as_str() {
            "--from" => {
                from = value.map(PathBuf::from);
                i += 2;
            }
            "--profile" => {
                match value.as_deref().and_then(install::Profile::parse) {
                    Some(p) => profile = p,
                    None => return fail("--profile is both or client"),
                }
                i += 2;
            }
            "--channel" => {
                match value.as_deref() {
                    Some(c @ ("stable" | "dev")) => channel = c.to_string(),
                    _ => return fail("--channel is stable or dev"),
                }
                i += 2;
            }
            "--yes" => i += 1,
            other => return fail(&format!("install: unknown option '{other}'")),
        }
    }
    let Some(from) = from else {
        return fail("install needs --from <folder> (downloads arrive with L6)");
    };
    if let Err(why) = std::fs::create_dir_all(&roots.code) {
        return fail(&format!("the programs folder {} could not be made: {why}", roots.code.display()));
    }
    if let Err(why) = secure::check_private(&roots.code) {
        return fail(&why);
    }
    let keys = keys::trusted_keys(roots);
    let options = install::InstallOptions { from, profile, channel, launcher_build: LAUNCHER_BUILD.to_string() };
    match install::install_from(roots, &options, &keys) {
        Ok(done) => {
            for d in done {
                println!("installed {} {}", d.track.as_str(), d.build);
            }
            // THE BRIDGE (L9): the bridge's installer runs this over the single-app install; its logon entry is replaced
            // by the launcher's and its two settings carried over. On any other install there is nothing to replace.
            genie_launcher::migrate::carry_over_here(roots);
            ExitCode::SUCCESS
        }
        Err(why) => fail(&why),
    }
}

/// The packages the bridge AppImage carries, when this launcher runs from its mount: `$APPDIR/packages` beside this
/// program, with `$APPIMAGE` set by the AppImage's runtime.
#[cfg(unix)]
fn bridge_packages() -> Option<PathBuf> {
    let appdir = PathBuf::from(std::env::var_os("APPDIR").filter(|v| !v.is_empty())?);
    std::env::var_os("APPIMAGE").filter(|v| !v.is_empty())?;
    let me = std::env::current_exe().ok()?;
    if !me.starts_with(&appdir) {
        return None;
    }
    packages_beside_me()
}

/// THE BRIDGE APPIMAGE (Tynn #1058 L9). electron-updater replaces the single app's AppImage with this one at the same
/// path, so a pinned or remembered path keeps working, and runs it (`APPIMAGE_SILENT_INSTALL=true`). Its first act is the
/// install of what it carries, the launcher included, as `genie install --from <its packages>` does: silent where Genie
/// was already here (the update, or the data root there), the setup window for a person running it fresh. Then the
/// installed launcher takes over with the same arguments; from then on this AppImage only starts it.
#[cfg(unix)]
fn cmd_bridge(roots: Roots, packages: PathBuf, text: Vec<String>) -> ExitCode {
    let installed = |r: &Roots| genie_launcher::state::read(&r.state_file()).ok().and_then(|s| s.track("launcher").and_then(|t| t.current.clone()));
    if installed(&roots).is_none() {
        let silent = std::env::var("APPIMAGE_SILENT_INSTALL").as_deref() == Ok("true") || roots.runtime_dir().is_dir();
        eprintln!("genie: the bridge AppImage installs Genie's programs from {} ({})", packages.display(), if silent { "Genie was here: silently" } else { "the setup window" });
        let done = if silent {
            cmd_install(&roots, &["--from".to_string(), packages.display().to_string(), "--profile".to_string(), "both".to_string(), "--yes".to_string()])
        } else {
            match cmd_setup(&roots, packages, "stable".to_string(), false) {
                Ok(()) => ExitCode::SUCCESS,
                Err(why) => fail(&why),
            }
        };
        if installed(&roots).is_none() {
            return done;
        }
    }
    if std::env::var("APPIMAGE_EXIT_AFTER_INSTALL").as_deref() == Ok("true") {
        return ExitCode::SUCCESS;
    }
    let Some(build) = installed(&roots) else { return fail("the bridge installed no launcher") };
    let Some(program) = roots.program(genie_launcher::layout::Track::Launcher, &build) else { return fail("not a track build") };
    // What the old updater and the AppImage's desktop entry add for an Electron app (`--updated`, `--no-sandbox`) means
    // nothing to the launcher.
    let args: Vec<String> = text.into_iter().filter(|a| a != "--updated" && a != "--no-sandbox").collect();
    match genie_launcher::spawn::start_window(&program, &args, &[], &roots.logs_dir().join("genie-launcher.log")) {
        Ok(pid) => {
            eprintln!("genie: the bridge AppImage handed over to the installed launcher {build} (pid {pid})");
            ExitCode::SUCCESS
        }
        Err(why) => fail(&why),
    }
}

#[cfg(windows)]
fn compat(mode: &str, args: &[OsString]) -> i32 {
    match mode {
        "detach" => genie_launcher::win::detach_main(args),
        "job" => genie_launcher::win::job_main(args),
        _ => genie_launcher::win::pipe_owner_only_main(args),
    }
}

#[cfg(not(windows))]
fn compat(mode: &str, _args: &[OsString]) -> i32 {
    eprintln!("genie: {mode} is a Windows mode (genie-launch.exe's)");
    LAUNCH_FAILED
}

fn code(n: i32) -> ExitCode {
    // The child's own code, as genie-launch.exe returned it (job): the low byte is what an exit status can carry
    // everywhere; Windows keeps the whole value through std::process::exit.
    #[cfg(windows)]
    {
        std::process::exit(n);
    }
    #[cfg(not(windows))]
    {
        ExitCode::from((n & 0xff) as u8)
    }
}

fn fail(why: &str) -> ExitCode {
    eprintln!("genie: {why}");
    ExitCode::from(LAUNCH_FAILED as u8)
}

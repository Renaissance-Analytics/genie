//! `Genie.exe` / `genie`: the launcher's command line (Tynn #1058 L2).
//!
//!   genie                         open Genie, as the Start menu and the desktop entry run it: with a launcher already
//!                                 running, ask it for a window and exit; else run the launcher (one per user), start
//!                                 the host (profile both) and open a client window
//!   genie serve | --logon | --hidden   run the launcher alone: its control wire, until it is ended (L5 adds logon)
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
    match text.first().map(String::as_str) {
        None => cmd_open(roots),
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
        Some("serve") | Some("--logon") | Some("--hidden") => {
            if let Err(why) = private_code_root(&roots) {
                return fail(&why);
            }
            match control::serve(roots) {
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
    let opened = control::serve_then(roots, |roots| {
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

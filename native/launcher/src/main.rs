//! `Genie.exe` / `genie`: the launcher's command line (Tynn #1058 L2).
//!
//!   genie                         open Genie, as the Start menu and the desktop entry run it: with a launcher already
//!                                 running, ask it for a window and exit; else run the launcher (one per user), start
//!                                 the host (profile both) and open a client window
//!   genie serve | --logon | --hidden   run the launcher alone: its control wire, until it is ended (L5 adds logon)
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
fn cmd_open(roots: Roots) -> ExitCode {
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

/// The NSIS uninstaller's (and Linux's) way out: the host stopped gracefully, then the programs folder removed. The data
/// root (`~/.genie`) is kept, as it always was (`deleteAppDataOnUninstall: false`).
fn cmd_uninstall(roots: &Roots) -> ExitCode {
    if let Err(why) = host::stop_host(roots) {
        return fail(&why);
    }
    #[cfg(unix)]
    genie_launcher::desktop::remove_entries(roots);
    if roots.code.exists() {
        if let Err(e) = std::fs::remove_dir_all(&roots.code) {
            return fail(&format!("the programs folder {} could not be removed: {e}", roots.code.display()));
        }
    }
    println!("uninstalled: {}", roots.code.display());
    ExitCode::SUCCESS
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

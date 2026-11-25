//! `Genie.exe` / `genie`: the launcher's command line (Tynn #1058 L2).
//!
//!   genie                         run the launcher (one per user): its control wire, until it is ended
//!   genie --logon                 the same, as the logon entry starts it (L5 adds what logon does)
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
        None | Some("serve") | Some("--logon") | Some("--hidden") => {
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
        Some(other) => fail(&format!("unknown command '{other}' (install, status, ensure-host, stop-host, version, or none to run)")),
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

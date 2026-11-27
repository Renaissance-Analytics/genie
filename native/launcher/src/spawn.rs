//! THE ONLY PLACE A PROGRAM IS STARTED (a source guard holds it: tests/source_guard.rs). It takes a `layout::Program`
//! alone: an absolute path inside a build folder, started with that folder as its working folder, never through a shell
//! or a search of PATH or the working folder (`lpApplicationName` on Windows). The child inherits ONLY its standard
//! handles: NUL as input, the log file as output and error (on Windows a handle list, genie-launch.c's `detach`; on
//! Linux every other descriptor is close-on-exec). It runs detached in its own session or process group.

use crate::layout::Program;
use std::path::Path;
use std::time::{Duration, Instant};

/// Detached and hidden (the host).
pub fn start_detached(program: &Program, args: &[String], env: &[(String, String)], log: &Path) -> Result<u32, String> {
    start(program, args, env, log, true)
}

/// Detached, with its windows shown as it shows them (the client).
/// What an AppImage's runtime (and electron-updater's AppImage install) set: the bridge AppImage's alone (L9).
pub const APPIMAGE_ENV: [&str; 6] = ["APPIMAGE", "APPDIR", "ARGV0", "OWD", "APPIMAGE_SILENT_INSTALL", "APPIMAGE_EXIT_AFTER_INSTALL"];

pub fn start_window(program: &Program, args: &[String], env: &[(String, String)], log: &Path) -> Result<u32, String> {
    start(program, args, env, log, false)
}

#[cfg(unix)]
fn start(program: &Program, args: &[String], env: &[(String, String)], log: &Path, _hidden: bool) -> Result<u32, String> {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    if !program.path().is_absolute() {
        return Err(format!("{} is not an absolute path", program.path().display()));
    }
    if let Some(dir) = log.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{} could not be made: {e}", dir.display()))?;
    }
    // std opens every file close-on-exec; only what is dup'd onto 0, 1 and 2 reaches the child.
    let out = std::fs::OpenOptions::new().create(true).append(true).open(log).map_err(|e| format!("{} could not be opened: {e}", log.display()))?;
    let err = out.try_clone().map_err(|e| e.to_string())?;
    let mut cmd = Command::new(program.path());
    cmd.args(args).current_dir(program.folder()).stdin(Stdio::null()).stdout(Stdio::from(out)).stderr(Stdio::from(err));
    // Nothing the launcher starts runs "inside" the bridge AppImage that may have started it (L9): its variables stay
    // with it.
    for k in APPIMAGE_ENV {
        cmd.env_remove(k);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    unsafe {
        cmd.pre_exec(|| {
            // Its own session: no terminal, no process group of ours to be ended with.
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = cmd.spawn().map_err(|e| format!("{} could not be started: {e}", program.path().display()))?;
    let pid = child.id();
    // Reaped when it ends, so a pid that has gone reads as gone while this process lives on.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(pid)
}

#[cfg(windows)]
fn start(program: &Program, args: &[String], env: &[(String, String)], log: &Path, hidden: bool) -> Result<u32, String> {
    use crate::win;
    if !program.path().is_absolute() {
        return Err(format!("{} is not an absolute path", program.path().display()));
    }
    if let Some(dir) = log.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{} could not be made: {e}", dir.display()))?;
    }
    let log_h = win::open_log(log).map_err(|e| format!("{} could not be opened (error {e})", log.display()))?;
    let nul = win::open_nul();
    let app = win::wide(program.path().as_os_str());
    let cwd = win::wide(program.folder().as_os_str());
    let mut line = vec![program.path().display().to_string()];
    line.extend(args.iter().cloned());
    let command = crate::argquote::command_line(&line);
    let r = win::start_detached_raw(&app, command, Some(cwd.as_slice()), Some(environment_block(env)), [nul, log_h, log_h], hidden);
    win::close(nul);
    win::close(log_h);
    match r {
        Ok(pi) => {
            win::close(pi.hThread);
            win::close(pi.hProcess);
            Ok(pi.dwProcessId)
        }
        Err(e) => Err(format!("{} could not be started (error {e})", program.path().display())),
    }
}

/// This process's environment with `env` over it, as CreateProcessW reads it: `NAME=value` NUL ... NUL, sorted by name
/// without case.
#[cfg(windows)]
fn environment_block(env: &[(String, String)]) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    let mut vars: std::collections::BTreeMap<String, (std::ffi::OsString, std::ffi::OsString)> = std::collections::BTreeMap::new();
    for (k, v) in std::env::vars_os() {
        vars.insert(k.to_string_lossy().to_uppercase(), (k, v));
    }
    for (k, v) in env {
        vars.insert(k.to_uppercase(), (k.into(), v.into()));
    }
    let mut block: Vec<u16> = Vec::new();
    for (_, (k, v)) in vars {
        block.extend(k.encode_wide());
        block.push('=' as u16);
        block.extend(v.encode_wide());
        block.push(0);
    }
    block.push(0);
    block
}

#[cfg(unix)]
pub fn pid_alive(pid: u32) -> bool {
    if pid == 0 || pid > i32::MAX as u32 {
        return false;
    }
    let r = unsafe { libc::kill(pid as i32, 0) };
    let exists = r == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
    // A zombie has ended (it is waiting to be reaped by its parent): not alive. Its state is the field after the
    // parenthesised name in /proc/<pid>/stat.
    exists && !is_zombie(pid)
}

#[cfg(unix)]
fn is_zombie(pid: u32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .ok()
        .and_then(|s| s.rfind(')').map(|at| s[at + 1..].trim_start().starts_with('Z')))
        .unwrap_or(false)
}

#[cfg(windows)]
pub fn pid_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return false;
        }
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(h, &mut code);
        CloseHandle(h);
        ok != 0 && code == 259 // STILL_ACTIVE
    }
}

/// True once `pid` has gone, false when it is still there after `timeout`.
pub fn wait_gone(pid: u32, timeout: Duration) -> bool {
    let t = Instant::now();
    while pid_alive(pid) {
        if t.elapsed() >= timeout {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    true
}

/// Ends `pid` at once (a host that never answered).
pub fn end(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
        let h = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if !h.is_null() {
            TerminateProcess(h, 1);
            CloseHandle(h);
        }
    }
}

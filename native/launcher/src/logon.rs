//! LOGON (Tynn #1058 L5; the host split P6, decision 5 and O4). What runs at logon is the launcher (`Genie.exe --logon`,
//! `genie --logon`), never the host directly, and the launcher writes that entry: the HKCU `Run` value on Windows, the
//! freedesktop autostart file `~/.config/autostart/genie.desktop` on Linux.
//!
//! The decision is `logonEntry` (src/core/logon.ts), unchanged, written again here and held to the same table
//! (test/fixtures/logon-table.json, read by both languages' tests):
//!
//!   left running + setting on   start            shut down + setting on   start
//!   left running + setting off  start            shut down + setting off  stays down until Genie is opened
//!
//! The entry is there only when Genie should start (`launch_at_login`). The run it makes starts the host, and opens a
//! window only when "start minimised" is off and the host was not left running; otherwise the launcher sits in the tray.
//!
//! Its inputs: the person's two settings ("start on logon", "start minimised"), which the client says to the launcher
//! (`launcher.logon`) when they change, kept in `<data root>/runtime/logon.json`; and the mark that the host was left
//! running, `<data root>/runtime/left-running` (the same file the client kept in P6), set at "Just close the UI" and
//! cleared when Genie is opened again or everything is shut down.

use crate::layout::Roots;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct LogonInput {
    pub left_running: bool,
    pub setting: bool,
    pub start_minimized: bool,
}

/// `logonEntry`'s answer: whether the entry is at the OS, and whether its run keeps the window closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct LogonEntry {
    pub launch_at_login: bool,
    pub start_minimized: bool,
}

/// What `--logon` does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct AtLogon {
    pub start_host: bool,
    pub open_window: bool,
}

/// `logonEntry` (src/core/logon.ts), unchanged.
pub fn logon_entry(input: LogonInput) -> LogonEntry {
    LogonEntry { launch_at_login: input.left_running || input.setting, start_minimized: input.left_running || input.start_minimized }
}

/// The run the entry makes: the host whenever the entry is due, a window only when not start-minimised. With no entry due
/// (a stale one ran it), nothing: Genie stays down until it is opened.
pub fn at_logon(entry: LogonEntry) -> AtLogon {
    AtLogon { start_host: entry.launch_at_login, open_window: entry.launch_at_login && !entry.start_minimized }
}

/// The person's two settings, as the client last said them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct LogonSettings {
    pub setting: bool,
    pub start_minimized: bool,
}

pub fn settings_file(roots: &Roots) -> PathBuf {
    roots.runtime_dir().join("logon.json")
}

pub fn left_running_file(roots: &Roots) -> PathBuf {
    roots.runtime_dir().join("left-running")
}

/// Off when never said (a fresh install: the settings' defaults).
pub fn read_settings(roots: &Roots) -> LogonSettings {
    let v: serde_json::Value = std::fs::read_to_string(settings_file(roots)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    LogonSettings { setting: v["setting"].as_bool() == Some(true), start_minimized: v["startMinimized"].as_bool() == Some(true) }
}

pub fn write_settings(roots: &Roots, settings: LogonSettings) -> Result<(), String> {
    let text = serde_json::json!({"setting": settings.setting, "startMinimized": settings.start_minimized}).to_string();
    write_whole(&settings_file(roots), text.as_bytes())
}

fn write_whole(file: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{} could not be made: {e}", dir.display()))?;
    }
    let tmp = file.with_extension(format!("{}.tmp", std::process::id()));
    std::fs::write(&tmp, bytes).and_then(|_| std::fs::rename(&tmp, file)).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("{} could not be written: {e}", file.display())
    })
}

fn remove_if_there(file: &Path) -> Result<(), String> {
    match std::fs::remove_file(file) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("{} could not be removed: {e}", file.display())),
    }
}

pub fn left_running(roots: &Roots) -> bool {
    left_running_file(roots).exists()
}

pub fn set_left_running(roots: &Roots, value: bool) -> Result<(), String> {
    let file = left_running_file(roots);
    if value { write_whole(&file, b"") } else { remove_if_there(&file) }
}

/// The inputs as they are on disk now.
pub fn input(roots: &Roots) -> LogonInput {
    let s = read_settings(roots);
    LogonInput { left_running: left_running(roots), setting: s.setting, start_minimized: s.start_minimized }
}

/// The argument the entry runs the launcher with.
pub const LOGON_ARG: &str = "--logon";

/// The Run value's name (Windows).
pub const RUN_VALUE: &str = "Genie";
/// The key the Run value is in, under HKCU.
pub const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

/// The Windows Run value's data: the launcher, quoted, then `--logon`.
pub fn run_command(exe: &str) -> String {
    format!("\"{exe}\" {LOGON_ARG}")
}

/// The Linux autostart file's text for this launcher (the desktop entry spec's Exec quoting: a double quote, a backtick,
/// a dollar and a backslash are escaped with a backslash).
pub fn desktop_entry(exe: &str) -> String {
    let mut quoted = String::new();
    for c in exe.chars() {
        if matches!(c, '"' | '`' | '$' | '\\') {
            quoted.push('\\');
        }
        quoted.push(c);
    }
    let exec = format!("Exec=\"{quoted}\" {LOGON_ARG}");
    ["[Desktop Entry]", "Type=Application", "Name=Genie", "Comment=Genie", exec.as_str(), "Hidden=false", "NoDisplay=false", "X-GNOME-Autostart-enabled=true", ""].join("\n")
}

/// Where the entry is: the Run value, or the autostart file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Place {
    WindowsRun { key: String, value: String },
    Autostart { file: PathBuf },
}

/// This user's place. A test build (`test-keys`) may name another Run key (GENIE_LOGON_RUN_KEY); the autostart file
/// follows XDG_CONFIG_HOME, else `~/.config`.
pub fn place() -> Place {
    #[cfg(windows)]
    {
        #[cfg(feature = "test-keys")]
        if let Ok(key) = std::env::var("GENIE_LOGON_RUN_KEY") {
            if !key.is_empty() {
                return Place::WindowsRun { key, value: RUN_VALUE.to_string() };
            }
        }
        Place::WindowsRun { key: RUN_KEY.to_string(), value: RUN_VALUE.to_string() }
    }
    #[cfg(not(windows))]
    {
        let config = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".config"));
        Place::Autostart { file: config.join("autostart").join("genie.desktop") }
    }
}

/// What is at the place now: the Run value's data or the file's text; `None` when there is no entry.
pub fn read_entry(place: &Place) -> Option<String> {
    match place {
        Place::Autostart { file } => std::fs::read_to_string(file).ok(),
        #[cfg(windows)]
        Place::WindowsRun { key, value } => reg::read(key, value),
        #[cfg(not(windows))]
        Place::WindowsRun { .. } => None,
    }
}

fn write_entry(place: &Place, exe: &str) -> Result<(), String> {
    match place {
        Place::Autostart { file } => write_whole(file, desktop_entry(exe).as_bytes()),
        #[cfg(windows)]
        Place::WindowsRun { key, value } => reg::write(key, value, &run_command(exe)),
        #[cfg(not(windows))]
        Place::WindowsRun { .. } => Err("a Run value is Windows' only".to_string()),
    }
}

fn remove_entry(place: &Place) -> Result<(), String> {
    match place {
        Place::Autostart { file } => remove_if_there(file),
        #[cfg(windows)]
        Place::WindowsRun { key, value } => reg::remove(key, value),
        #[cfg(not(windows))]
        Place::WindowsRun { .. } => Ok(()),
    }
}

/// The entry made to match the inputs on disk: written for this launcher when Genie should start at logon, removed when
/// not. What was done, in words (the launcher's log).
pub fn apply(roots: &Roots, place: &Place, exe: &str) -> Result<String, String> {
    let input = input(roots);
    let entry = logon_entry(input);
    let said = format!("setting {}, start minimised {}, left running {}", on(input.setting), on(input.start_minimized), if input.left_running { "yes" } else { "no" });
    if entry.launch_at_login {
        write_entry(place, exe)?;
        Ok(format!("logon entry written ({said})"))
    } else {
        remove_entry(place)?;
        Ok(format!("logon entry removed ({said})"))
    }
}

/// The program the entry runs: this launcher, or on Linux the `~/.local/bin/genie` link when it leads here, so the entry
/// keeps working when an update points the link at another build.
pub fn entry_exe() -> Result<String, String> {
    let me = crate::control::launcher_exe()?;
    #[cfg(unix)]
    if let Some(link) = crate::desktop::link_path() {
        let leads_here = std::fs::canonicalize(&link).ok().zip(std::fs::canonicalize(&me).ok()).map(|(a, b)| a == b).unwrap_or(false);
        if leads_here {
            return Ok(link.display().to_string());
        }
    }
    Ok(me)
}

/// `apply` at this user's place for this launcher, said on stderr (the launcher's log); a failure is said, never fatal.
pub fn apply_here(roots: &Roots) {
    let said = match entry_exe() {
        Ok(exe) => apply(roots, &place(), &exe).unwrap_or_else(|why| format!("the logon entry could not be made: {why}")),
        Err(why) => format!("the logon entry could not be made: {why}"),
    };
    eprintln!("genie: {said}");
}

fn on(b: bool) -> &'static str {
    if b {
        "on"
    } else {
        "off"
    }
}

#[cfg(windows)]
mod reg {
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_SZ};

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    pub fn read(key: &str, value: &str) -> Option<String> {
        let (k, v) = (wide(key), wide(value));
        let mut size: u32 = 0;
        let r = unsafe { RegGetValueW(HKEY_CURRENT_USER, k.as_ptr(), v.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), std::ptr::null_mut(), &mut size) };
        if r != ERROR_SUCCESS || size == 0 {
            return None;
        }
        let mut buf = vec![0u16; (size as usize + 1) / 2];
        let r = unsafe { RegGetValueW(HKEY_CURRENT_USER, k.as_ptr(), v.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), buf.as_mut_ptr().cast(), &mut size) };
        if r != ERROR_SUCCESS {
            return None;
        }
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..end]))
    }

    pub fn write(key: &str, value: &str, data: &str) -> Result<(), String> {
        let (k, v, d) = (wide(key), wide(value), wide(data));
        let r = unsafe { RegSetKeyValueW(HKEY_CURRENT_USER, k.as_ptr(), v.as_ptr(), REG_SZ, d.as_ptr().cast(), (d.len() * 2) as u32) };
        if r == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(format!("HKCU\\{key}\\{value} could not be written (error {r})"))
        }
    }

    pub fn remove(key: &str, value: &str) -> Result<(), String> {
        let (k, v) = (wide(key), wide(value));
        let r = unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, k.as_ptr(), v.as_ptr()) };
        if r == ERROR_SUCCESS || r == ERROR_FILE_NOT_FOUND {
            Ok(())
        } else {
            Err(format!("HKCU\\{key}\\{value} could not be removed (error {r})"))
        }
    }
}

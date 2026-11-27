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
use std::path::PathBuf;

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
pub fn logon_entry(_input: LogonInput) -> LogonEntry {
    LogonEntry::default()
}

/// The run the entry makes.
pub fn at_logon(_entry: LogonEntry) -> AtLogon {
    AtLogon::default()
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

pub fn read_settings(_roots: &Roots) -> LogonSettings {
    LogonSettings::default()
}

pub fn write_settings(_roots: &Roots, _settings: LogonSettings) -> Result<(), String> {
    Ok(())
}

pub fn left_running(_roots: &Roots) -> bool {
    false
}

pub fn set_left_running(_roots: &Roots, _value: bool) -> Result<(), String> {
    Ok(())
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
pub fn run_command(_exe: &str) -> String {
    String::new()
}

/// The Linux autostart file's text for this launcher.
pub fn desktop_entry(_exe: &str) -> String {
    String::new()
}

/// Where the entry is: the Run value, or the autostart file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Place {
    WindowsRun { key: String, value: String },
    Autostart { file: PathBuf },
}

/// This user's place. A test build (`test-keys`) may name another Run key (GENIE_LOGON_RUN_KEY); the autostart file
/// follows XDG_CONFIG_HOME.
pub fn place() -> Place {
    #[cfg(windows)]
    {
        Place::WindowsRun { key: RUN_KEY.to_string(), value: RUN_VALUE.to_string() }
    }
    #[cfg(not(windows))]
    {
        Place::Autostart { file: PathBuf::from("/nonexistent/genie.desktop") }
    }
}

/// What is at the place now: the Run value's data or the file's text; `None` when there is no entry.
pub fn read_entry(_place: &Place) -> Option<String> {
    None
}

/// The entry made to match the inputs on disk: written for this launcher when Genie should start at logon, removed when
/// not. What was done, in words (the launcher's log).
pub fn apply(_roots: &Roots, _place: &Place, _exe: &str) -> Result<String, String> {
    Ok(String::new())
}

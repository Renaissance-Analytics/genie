//! THE MIGRATION FROM THE SINGLE-APP INSTALL (Tynn #1058 L9, the bridge): the logon entry the single app wrote is replaced
//! by the launcher's, and the person's two settings ("start on logon", "start minimised") are carried over from it.
//!
//! What the single app wrote (src/core/tray-resident.ts `loginItemPlan`): on Windows Electron's `setLoginItemSettings`, an
//! HKCU Run value named by the app's id whose data runs `Genie.exe` (the path the bridge's installer has made the
//! launcher's), with `--hidden` when start minimised; Genie 1 wrote one with `--autostart`. On Linux the autostart file
//! `genie.desktop`, the same file the launcher writes, running the AppImage. Each is found by the program it runs, as
//! `v1LoginItemQuery` found Genie 1's, never by its name alone, and only Genie's are touched.
//!
//! The settings: the client says them to the launcher at its every start (`launcher.logon`), and those win. Until it has,
//! the single app's entry is the record of them, as Genie 2 read Genie 1's: an entry there means start on logon, its
//! `--hidden` start minimised. "The host was left running" is the P6 file both use, so it carries over as it is.
//!
//! Then `logon::apply` writes the launcher's entry, or none: one entry, never two, however often this runs.

use crate::layout::Roots;
use crate::logon::{self, LogonSettings, Place};

/// What the migration did: the settings it carried over (`None` when the client had already said them), and the old
/// entries it removed, in words.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Carried {
    pub settings: Option<LogonSettings>,
    pub removed: Vec<String>,
}

/// One logon entry the single app (or Genie 1) wrote: where it is, whether it was on, and whether it started Genie hidden.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OldEntry {
    pub name: String,
    pub enabled: bool,
    pub start_minimized: bool,
}

/// The program a command line runs (quoted, or up to the first space) and the rest.
fn split_command(command: &str) -> (String, String) {
    let c = command.trim();
    if let Some(rest) = c.strip_prefix('"') {
        if let Some(end) = rest.find('"') {
            return (rest[..end].to_string(), rest[end + 1..].trim().to_string());
        }
    }
    match c.find(' ') {
        Some(i) => (c[..i].to_string(), c[i + 1..].trim().to_string()),
        None => (c.to_string(), String::new()),
    }
}

/// Windows paths compare without case and either slash.
fn same_program(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        let n = |p: &str| p.trim().replace('/', "\\").to_lowercase();
        n(a) == n(b)
    } else {
        a.trim() == b.trim()
    }
}

fn has_arg(args: &str, arg: &str) -> bool {
    args.split_whitespace().any(|a| a == arg)
}

/// The launcher's own entry for `exe` (what `logon::run_command` and `logon::desktop_entry` write).
fn is_launchers(command: &str, exe: &str) -> bool {
    let (program, args) = split_command(command);
    same_program(&program, exe) && has_arg(&args, logon::LOGON_ARG)
}

/// The Exec line of a desktop entry, with the spec's backslash escapes undone.
fn desktop_exec(text: &str) -> Option<String> {
    let line = text.lines().find_map(|l| l.strip_prefix("Exec="))?;
    let mut out = String::new();
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(n) = chars.next() {
                out.push(n);
            }
        } else {
            out.push(c);
        }
    }
    Some(out)
}

fn desktop_key(text: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}=");
    text.lines().find_map(|l| l.strip_prefix(prefix.as_str()).map(|v| v.trim().to_string()))
}

/// The single app's entries at `place`: what runs Genie at logon and is not the launcher's own entry for `exe`.
pub fn old_entries(place: &Place, exe: &str) -> Vec<OldEntry> {
    match place {
        Place::Autostart { file } => {
            let Ok(text) = std::fs::read_to_string(file) else { return Vec::new() };
            let Some(exec) = desktop_exec(&text) else { return Vec::new() };
            if is_launchers(&exec, exe) {
                return Vec::new();
            }
            let off = desktop_key(&text, "Hidden").as_deref() == Some("true") || desktop_key(&text, "X-GNOME-Autostart-enabled").as_deref() == Some("false");
            let (_, args) = split_command(&exec);
            vec![OldEntry { name: file.display().to_string(), enabled: !off, start_minimized: has_arg(&args, "--hidden") }]
        }
        #[cfg(windows)]
        Place::WindowsRun { key, .. } => run_values(key)
            .into_iter()
            .filter(|(_, data)| same_program(&split_command(data).0, exe) && !is_launchers(data, exe))
            .map(|(name, data)| {
                let (_, args) = split_command(&data);
                OldEntry { name: format!(r"HKCU\{key}\{name}"), enabled: true, start_minimized: has_arg(&args, "--hidden") }
            })
            .collect(),
        #[cfg(not(windows))]
        Place::WindowsRun { .. } => Vec::new(),
    }
}

fn remove_old(place: &Place, entry: &OldEntry) -> Result<(), String> {
    match place {
        // The autostart file is the launcher's own place: `logon::apply` writes it over, or removes it.
        Place::Autostart { .. } => Ok(()),
        #[cfg(windows)]
        Place::WindowsRun { key, .. } => {
            let prefix = format!(r"HKCU\{key}\");
            logon::reg::remove(key, entry.name.strip_prefix(prefix.as_str()).unwrap_or(&entry.name))
        }
        #[cfg(not(windows))]
        Place::WindowsRun { .. } => {
            let _ = entry;
            Ok(())
        }
    }
}

/// The migration at `place` for the launcher `exe`. Run by every install and setup (the bridge's included), and again at
/// no cost: with the single app's entries gone it only applies the entry.
pub fn carry_over(roots: &Roots, place: &Place, exe: &str) -> Result<Carried, String> {
    let old = old_entries(place, exe);
    let settings = if logon::settings_file(roots).exists() {
        None
    } else {
        let s = match old.iter().find(|e| e.enabled) {
            Some(e) => LogonSettings { setting: true, start_minimized: e.start_minimized },
            None => LogonSettings::default(),
        };
        logon::write_settings(roots, s)?;
        Some(s)
    };
    let mut removed = Vec::new();
    for e in &old {
        remove_old(place, e)?;
        removed.push(e.name.clone());
    }
    logon::apply(roots, place, exe)?;
    Ok(Carried { settings, removed })
}

/// `carry_over` at this user's place for the installed launcher, said on stderr (the install's log); never fatal.
pub fn carry_over_here(roots: &Roots) {
    let said = match installed_entry_exe(roots).and_then(|exe| carry_over(roots, &logon::place(), &exe)) {
        Ok(c) => format!(
            "the single app's logon entry: {}; the settings {}",
            if c.removed.is_empty() { "none was there".to_string() } else { format!("replaced ({})", c.removed.join(", ")) },
            match c.settings {
                Some(s) => format!("carried over (start on logon {}, start minimised {})", on(s.setting), on(s.start_minimized)),
                None => "as the client said them".to_string(),
            }
        ),
        Err(why) => format!("the logon entry could not be migrated: {why}"),
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

/// The program the logon entry runs once installed: on Linux the `~/.local/bin/genie` link to the installed launcher (the
/// bridge AppImage runs a launcher from its own mount, which goes when it exits); otherwise this launcher.
fn installed_entry_exe(roots: &Roots) -> Result<String, String> {
    #[cfg(unix)]
    if let Some(link) = crate::desktop::link_path() {
        if std::fs::read_link(&link).map(|t| t.starts_with(roots.track_dir(crate::layout::Track::Launcher))).unwrap_or(false) {
            return Ok(link.display().to_string());
        }
    }
    let _ = roots;
    logon::entry_exe()
}

/// Every value of the HKCU key `key`: its name and its data (REG_SZ / REG_EXPAND_SZ only).
#[cfg(windows)]
pub fn run_values(key: &str) -> Vec<(String, String)> {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{RegCloseKey, RegEnumValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_READ, REG_EXPAND_SZ, REG_SZ};
    let k: Vec<u16> = key.encode_utf16().chain(Some(0)).collect();
    let mut h: HKEY = std::ptr::null_mut();
    if unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, k.as_ptr(), 0, KEY_READ, &mut h) } != ERROR_SUCCESS {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut i = 0u32;
    loop {
        let mut name = vec![0u16; 16384];
        let mut name_len = name.len() as u32;
        let mut data = vec![0u8; 65536];
        let mut data_len = data.len() as u32;
        let mut kind = 0u32;
        let r = unsafe { RegEnumValueW(h, i, name.as_mut_ptr(), &mut name_len, std::ptr::null_mut(), &mut kind, data.as_mut_ptr(), &mut data_len) };
        if r != ERROR_SUCCESS {
            break;
        }
        i += 1;
        if kind != REG_SZ && kind != REG_EXPAND_SZ {
            continue;
        }
        let wide: Vec<u16> = data[..data_len as usize].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        let end = wide.iter().position(|&c| c == 0).unwrap_or(wide.len());
        out.push((String::from_utf16_lossy(&name[..name_len as usize]), String::from_utf16_lossy(&wide[..end])));
    }
    unsafe { RegCloseKey(h) };
    out
}

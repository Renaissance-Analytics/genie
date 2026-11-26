//! LINUX: THE LAUNCHER'S OWN PLACE AND THE DESKTOP ENTRY (the spec's layout table). Once `install --from` has put a
//! launcher build at `<code root>/launcher/<build>/genie`:
//!
//! - `~/.local/bin/genie` is a link to it (replaced whole: a new link renamed over the old one);
//! - `~/.local/share/applications/genie.desktop` runs the link: Genie, and Genie in doctor mode as its action, with the
//!   `genie` scheme (`MimeType=x-scheme-handler/genie;`), so a sign-in's `genie://` link reaches the launcher;
//! - the entry never names a client build's path, which changes with every client update.
//!
//! `remove_entries` takes them away again (`genie uninstall`), and only when they are the launcher's: a link that points
//! elsewhere, or an entry that does not run the link, is someone else's and is left alone. The autostart entry is L5's.

use crate::layout::{launcher_executable_name, Roots, Track};
use std::path::PathBuf;

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").filter(|h| !h.is_empty()).map(PathBuf::from).filter(|p| p.is_absolute())
}

fn data_home() -> Option<PathBuf> {
    match std::env::var_os("XDG_DATA_HOME").filter(|h| !h.is_empty()).map(PathBuf::from).filter(|p| p.is_absolute()) {
        Some(d) => Some(d),
        None => home().map(|h| h.join(".local").join("share")),
    }
}

pub fn link_path() -> Option<PathBuf> {
    home().map(|h| h.join(".local").join("bin").join("genie"))
}

pub fn entry_path() -> Option<PathBuf> {
    data_home().map(|d| d.join("applications").join("genie.desktop"))
}

/// The desktop entry's text for a launcher reached at `link`.
pub fn entry_text(link: &std::path::Path) -> String {
    let exec = link.display().to_string();
    format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=Genie\n\
         Comment=Agents, terminals and sites, on this computer and your others\n\
         Exec={exec} %u\n\
         Terminal=false\n\
         Categories=Development;\n\
         MimeType=x-scheme-handler/genie;\n\
         StartupWMClass=Genie\n\
         Actions=doctor;\n\
         \n\
         [Desktop Action doctor]\n\
         Name=Genie (doctor mode)\n\
         Exec={exec} --doctor\n"
    )
}

fn write_whole(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or("no folder")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("{} could not be made: {e}", dir.display()))?;
    let tmp = dir.join(format!(".genie.{}.tmp", std::process::id()));
    std::fs::write(&tmp, bytes).and_then(|_| std::fs::rename(&tmp, path)).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("{} could not be written: {e}", path.display())
    })
}

pub fn write_entries(roots: &Roots, launcher_build: &str) -> Result<(), String> {
    let program = roots.build_dir(Track::Launcher, launcher_build).ok_or("not a track build")?.join(launcher_executable_name());
    if !program.is_file() {
        return Err(format!("the launcher is not at {}", program.display()));
    }
    let link = link_path().ok_or("HOME is not set: no ~/.local/bin for the launcher's link")?;
    let dir = link.parent().ok_or("no folder")?.to_path_buf();
    std::fs::create_dir_all(&dir).map_err(|e| format!("{} could not be made: {e}", dir.display()))?;
    let tmp = dir.join(format!(".genie.{}.link", std::process::id()));
    let _ = std::fs::remove_file(&tmp);
    std::os::unix::fs::symlink(&program, &tmp)
        .and_then(|_| std::fs::rename(&tmp, &link))
        .map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("{} could not be linked to {}: {e}", link.display(), program.display())
        })?;
    let entry = entry_path().ok_or("HOME is not set: no place for the desktop entry")?;
    write_whole(&entry, entry_text(&link).as_bytes())
}

pub fn remove_entries(roots: &Roots) {
    let launchers = roots.track_dir(Track::Launcher);
    if let Some(link) = link_path() {
        if std::fs::read_link(&link).map(|t| t.starts_with(&launchers)).unwrap_or(false) {
            let _ = std::fs::remove_file(&link);
        }
        if let Some(entry) = entry_path() {
            let ours = std::fs::read_to_string(&entry).map(|t| t.contains(&format!("\nExec={} %u\n", link.display()))).unwrap_or(false);
            if ours {
                let _ = std::fs::remove_file(&entry);
            }
        }
    }
}

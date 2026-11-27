//! `genie uninstall` REMOVES ONLY WHAT THE LAUNCHER OWNS (Tynn #1058 L4). The code root can come from GENIE_CODE_ROOT, and
//! a wrong value (a home folder, the data root, a drive root) must never be wiped. So:
//!
//! - `refusal`: the code root may not be a filesystem root, nor be or hold the home folder or the data root. Checked
//!   before anything is stopped or removed.
//! - `remove_owned`: the track builds state.json names (current and previous) and every `<build>.partial` (names that are
//!   track builds: only the launcher makes them), the trusted keys and state.json; then a track folder, and the code root
//!   itself, only when nothing else is left in it. Anything else in the code root is kept.

use crate::keys::TRUSTED_KEYS_FILE;
use crate::layout::{Roots, Track};
use crate::{folder::PARTIAL_SUFFIX, state, version};
use std::path::{Component, Path, PathBuf};

/// The path as compared: resolved when it exists, else taken apart lexically; on Windows without the verbatim prefix and
/// in lower case (its file system ignores case).
fn key(p: &Path) -> PathBuf {
    let resolved = std::fs::canonicalize(p).unwrap_or_else(|_| lexical(p));
    let text = resolved.to_string_lossy().to_string();
    #[cfg(windows)]
    {
        let plain = text.strip_prefix(r"\\?\UNC\").map(|t| format!(r"\\{t}")).or_else(|| text.strip_prefix(r"\\?\").map(str::to_string)).unwrap_or(text);
        PathBuf::from(plain.to_lowercase())
    }
    #[cfg(not(windows))]
    {
        PathBuf::from(text)
    }
}

fn lexical(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// `outer` is `inner` or one of its folders.
fn holds(outer: &Path, inner: &Path) -> bool {
    key(inner).starts_with(key(outer))
}

/// Why the launcher will not uninstall from `code`, or `None`.
pub fn refusal(code: &Path, data: &Path, home: Option<&Path>) -> Option<String> {
    let at = code.display();
    if key(code).parent().is_none() {
        return Some(format!("Genie will not uninstall from {at}: it is the root of a drive or filesystem."));
    }
    if let Some(h) = home {
        if holds(code, h) {
            return Some(format!("Genie will not uninstall from {at}: it is or holds your home folder ({}).", h.display()));
        }
    }
    if holds(code, data) {
        return Some(format!("Genie will not uninstall from {at}: it is or holds Genie's data root ({}).", data.display()));
    }
    None
}

/// This user's home folder from the environment, if it says one.
pub fn home_from_env() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var).filter(|v| !v.is_empty()).map(PathBuf::from).filter(|p| p.is_absolute())
}

fn remove_dir(path: &Path, removed: &mut Vec<PathBuf>) -> Result<(), String> {
    match std::fs::remove_dir_all(path) {
        Ok(()) => {
            removed.push(path.to_path_buf());
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("{} could not be removed: {e}", path.display())),
    }
}

fn remove_file(path: &Path, removed: &mut Vec<PathBuf>) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => {
            removed.push(path.to_path_buf());
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("{} could not be removed: {e}", path.display())),
    }
}

/// A folder removed only when it is empty (anything left in it is not the launcher's).
fn remove_if_empty(path: &Path, removed: &mut Vec<PathBuf>) {
    if std::fs::read_dir(path).map(|mut d| d.next().is_none()).unwrap_or(false) && std::fs::remove_dir(path).is_ok() {
        removed.push(path.to_path_buf());
    }
}

/// What the launcher installed, removed; everything else kept. What was removed.
pub fn remove_owned(roots: &Roots) -> Result<Vec<PathBuf>, String> {
    let mut removed = Vec::new();
    if !roots.code.exists() {
        return Ok(removed);
    }
    let st = state::read(&roots.state_file())?;
    for track in Track::ALL {
        let dir = roots.track_dir(track);
        if let Some(t) = st.track(track.as_str()) {
            for build in [t.current.as_deref(), t.previous.as_deref()].into_iter().flatten() {
                if let Some(folder) = roots.build_dir(track, build) {
                    remove_dir(&folder, &mut removed)?;
                }
            }
        }
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                let is_partial = name.strip_suffix(PARTIAL_SUFFIX).is_some_and(|b| !b.contains('+') && version::parse_track_build(b).is_some());
                if is_partial && entry.path().is_dir() {
                    remove_dir(&entry.path(), &mut removed)?;
                }
            }
        }
        remove_if_empty(&dir, &mut removed);
    }
    remove_file(&roots.code.join(TRUSTED_KEYS_FILE), &mut removed)?;
    remove_file(&roots.state_file(), &mut removed)?;
    remove_if_empty(&roots.code, &mut removed);
    Ok(removed)
}

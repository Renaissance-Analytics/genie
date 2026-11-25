//! VERIFY BEFORE RUN. A build folder is run only when its `.complete` marker is there (written last), its manifest's
//! signature is good, it names this track, build, platform and architecture, every listed file is there at its size,
//! nothing unlisted is beside them, and the files it hashes match. A folder without the marker is never run, and is
//! deleted at the next start (`sweep`), with every `<build>.partial`.

use crate::layout::{Roots, Track};
use crate::manifest::Manifest;
use ed25519_dalek::VerifyingKey;
use std::path::PathBuf;

pub const COMPLETE: &str = ".complete";
pub const MANIFEST: &str = "manifest.json";
pub const SIGNATURE: &str = "manifest.json.sig";
pub const PARTIAL_SUFFIX: &str = ".partial";

/// What is hashed: everything (after an install), or the executables (before each start: `.exe`, `.dll`, `.node`,
/// `.so`, the program and the host's entry).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HashScope {
    All,
    Executables,
}

use crate::layout::{client_executable_name, host_executable_name, HOST_ENTRY};
use crate::manifest::{parse_manifest, sha256_hex, this_arch, this_platform, verify_signature};
use std::collections::BTreeMap;
use std::path::Path;

/// A name compared as the OS compares file names: without case on Windows.
pub fn name_key(path: &str) -> String {
    if cfg!(windows) { path.to_ascii_lowercase() } else { path.to_string() }
}

fn is_executable(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    let file = lower.rsplit('/').next().unwrap_or("");
    lower.ends_with(".exe") || lower.ends_with(".dll") || lower.ends_with(".node") || lower.ends_with(".so") || file.contains(".so.")
        || path == host_executable_name() || path == client_executable_name() || path == HOST_ENTRY
}

/// Every file under `dir`, by its '/'-joined relative path. A link refuses (nothing in a build folder is one).
pub fn walk(dir: &Path) -> Result<Vec<String>, String> {
    fn go(base: &Path, dir: &Path, out: &mut Vec<String>) -> Result<(), String> {
        let entries = std::fs::read_dir(dir).map_err(|e| format!("{} could not be read: {e}", dir.display()))?;
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            let meta = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
            let rel = path.strip_prefix(base).map_err(|e| e.to_string())?;
            let rel = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/");
            if meta.file_type().is_symlink() {
                return Err(format!("{rel} is a link"));
            } else if meta.is_dir() {
                go(base, &path, out)?;
            } else {
                out.push(rel);
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    go(dir, dir, &mut out)?;
    Ok(out)
}

pub fn verify_build(roots: &Roots, track: Track, build: &str, keys: &[VerifyingKey], scope: HashScope) -> Result<Manifest, String> {
    let dir = roots.build_dir(track, build).ok_or_else(|| format!("'{build}' is not a {} build", track.as_str()))?;
    if !dir.join(COMPLETE).is_file() {
        return Err(format!("{} has no {COMPLETE} marker: an install that did not finish is never run", dir.display()));
    }
    let bytes = std::fs::read(dir.join(MANIFEST)).map_err(|e| format!("{}: no manifest ({e})", dir.display()))?;
    let sig = std::fs::read(dir.join(SIGNATURE)).map_err(|e| format!("{}: no signature ({e})", dir.display()))?;
    verify_signature(&bytes, &sig, keys).map_err(|r| r.to_string())?;
    let m = parse_manifest(&bytes).map_err(|r| r.to_string())?;
    if m.track != track.as_str() || m.build != build || m.platform != this_platform() || m.arch != this_arch() {
        return Err(format!("{}: its manifest names {} {} {} {}", dir.display(), m.track, m.build, m.platform, m.arch));
    }
    verify_tree(&m, &dir, scope).map_err(|r| format!("{}: {}", dir.display(), r.reason))?;
    Ok(m)
}

/// Why a build folder does not hold what its manifest lists, by the code `verifyTree` gives it in
/// src/core/track-manifest.ts (held by the shared table, test/fixtures/track-manifest-cases.json).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeRefusal {
    /// `missing-file`, `unlisted-file`, `not-a-file`, `size` or `sha256`.
    pub code: &'static str,
    pub path: String,
    pub reason: String,
}

fn tree_refusal(code: &'static str, path: &str, reason: String) -> TreeRefusal {
    TreeRefusal { code, path: path.to_string(), reason }
}

/// Every file `m` lists is in `dir` at its size (and, in `scope`, its sha256), and nothing else is but the folder's own
/// manifest, signature and marker.
pub fn verify_tree(m: &Manifest, dir: &Path, scope: HashScope) -> Result<(), TreeRefusal> {
    let listed: BTreeMap<String, &crate::manifest::ManifestFile> = m.files.iter().map(|f| (name_key(&f.path), f)).collect();
    let own = [name_key(MANIFEST), name_key(SIGNATURE), name_key(COMPLETE)];
    let mut found = std::collections::BTreeSet::new();
    let all = walk(dir).map_err(|why| tree_refusal("not-a-file", "", why))?;
    for rel in all {
        let key = name_key(&rel);
        if own.contains(&key) {
            continue;
        }
        if !listed.contains_key(&key) {
            return Err(tree_refusal("unlisted-file", &rel, format!("{rel} is not in its signed manifest, so this build is not run")));
        }
        found.insert(key);
    }
    for (key, f) in &listed {
        if !found.contains(key) {
            return Err(tree_refusal("missing-file", &f.path, format!("{} is missing", f.path)));
        }
        let path = dir.join(&f.path);
        let size = std::fs::metadata(&path).map_err(|e| tree_refusal("missing-file", &f.path, e.to_string()))?.len();
        if size != f.size {
            return Err(tree_refusal("size", &f.path, format!("{} is {size} bytes, its manifest says {}", f.path, f.size)));
        }
        if scope == HashScope::All || is_executable(&f.path) {
            let data = std::fs::read(&path).map_err(|e| tree_refusal("missing-file", &f.path, format!("{}: {e}", path.display())))?;
            if sha256_hex(&data) != f.sha256 {
                return Err(tree_refusal("sha256", &f.path, format!("{} is not the file its signed manifest names", f.path)));
            }
        }
    }
    Ok(())
}

/// Every `<build>.partial` and every build folder with no `.complete` is deleted. What was deleted.
pub fn sweep(roots: &Roots) -> Vec<PathBuf> {
    let mut gone = Vec::new();
    for track in Track::ALL {
        let Ok(entries) = std::fs::read_dir(roots.track_dir(track)) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let (build, partial) = match name.strip_suffix(PARTIAL_SUFFIX) {
                Some(b) => (b.to_string(), true),
                None => (name.clone(), false),
            };
            if roots.build_dir(track, &build).is_none() {
                continue; // not a folder the launcher made: never touched
            }
            if (partial || !path.join(COMPLETE).is_file()) && std::fs::remove_dir_all(&path).is_ok() {
                gone.push(path);
            }
        }
    }
    gone
}

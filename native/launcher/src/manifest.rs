//! THE TRACK MANIFEST (`contracts/track-manifest.schema.json`, format 1; `src/core/track-manifest.ts` on the TypeScript
//! side). Ed25519 over the exact bytes of manifest.json; manifest.json.sig is the signature in padded base64.
//!
//! CHECKS, IN ORDER: the signature; the shape (an unknown field refuses); track, platform, arch and channel are the ones
//! asked for (stable takes stable only; dev takes dev and stable); the build is newer than the installed one (equal
//! refuses); minLauncher is not newer than the running launcher. The files are checked as they are unpacked
//! (`install`) and before each run (`folder`).

use crate::version::{compare_track_builds, parse_track_build};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use ed25519_dalek::{Signature, VerifyingKey};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::fmt;

pub const FORMAT: u64 = 1;
pub const MAX_PATH_CHARS: usize = 1024;
pub const MAX_NOTES_CHARS: usize = 65536;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestFile {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Manifest {
    pub track: String,
    pub build: String,
    pub schema: String,
    pub channel: String,
    pub platform: String,
    pub arch: String,
    pub min_launcher: Option<String>,
    pub files: Vec<ManifestFile>,
    pub notes: String,
    pub next_key: Option<String>,
}

/// What an install asks for.
#[derive(Debug, Clone)]
pub struct Wanted<'a> {
    pub track: &'a str,
    pub platform: &'a str,
    pub arch: &'a str,
    /// The channel this install reads: `stable` takes stable only, `dev` takes dev and stable.
    pub channel: &'a str,
    /// The installed `current` build of the track, if any: the manifest's must be strictly newer.
    pub current: Option<&'a str>,
    /// The running launcher's build, for `minLauncher`; `None` when the reader is not the launcher (nothing to compare,
    /// as `ManifestExpect.launcher: null` on the TypeScript side).
    pub launcher: Option<&'a str>,
}

/// Why a manifest is refused, by the check that refused it (in the order they run).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    Signature(String),
    Shape(String),
    Wrong(String),
    NotNewer(String),
    LauncherTooOld(String),
    Files(String),
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Refusal::Signature(why) => write!(f, "This update's signature is not Genie's. Nothing was installed. ({why})"),
            Refusal::Shape(why) => write!(f, "This package's manifest is not one Genie reads ({why}). Nothing was installed."),
            Refusal::Wrong(why) => write!(f, "This package is not the one asked for ({why}). Nothing was installed."),
            Refusal::NotNewer(why) => write!(f, "This package is not newer than the one installed ({why}). Nothing was installed."),
            Refusal::LauncherTooOld(why) => write!(f, "This package needs a newer launcher ({why}). Nothing was installed."),
            Refusal::Files(why) => write!(f, "This package's files do not match its signed manifest ({why}). Nothing was installed."),
        }
    }
}

impl Refusal {
    /// The check that refused, by the code `verifyManifest` gives it in src/core/track-manifest.ts (held by the shared
    /// table, test/fixtures/track-manifest-cases.json).
    pub fn code(&self) -> &'static str {
        match self {
            Refusal::Signature(_) => "signature",
            Refusal::Shape(_) => "format",
            Refusal::Wrong(_) => "wrong",
            Refusal::NotNewer(_) => "downgrade",
            Refusal::LauncherTooOld(_) => "launcher-too-old",
            Refusal::Files(_) => "files",
        }
    }
}

/// This machine, as manifests name it.
pub fn this_platform() -> &'static str {
    if cfg!(windows) { "win32" } else { "linux" }
}
pub fn this_arch() -> &'static str {
    if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" }
}

/// A public key: raw 32 bytes in standard padded base64.
pub fn parse_public_key(text: &str) -> Result<VerifyingKey, String> {
    let t = text.trim();
    if t.len() != 44 || !t.ends_with('=') {
        return Err("a public key is 32 bytes in padded base64 (44 characters)".into());
    }
    let raw = STANDARD.decode(t).map_err(|e| format!("not base64: {e}"))?;
    let bytes: [u8; 32] = raw.try_into().map_err(|_| "not 32 bytes".to_string())?;
    VerifyingKey::from_bytes(&bytes).map_err(|e| format!("not an Ed25519 key: {e}"))
}

/// The signature over these exact bytes, by any of `keys`. `sig_text` is manifest.json.sig as read (trailing ASCII
/// whitespace ignored, anything else refused).
pub fn verify_signature(bytes: &[u8], sig_text: &[u8], keys: &[VerifyingKey]) -> Result<(), Refusal> {
    let mut end = sig_text.len();
    while end > 0 && matches!(sig_text[end - 1], b'\r' | b'\n' | b' ' | b'\t') {
        end -= 1;
    }
    let text = &sig_text[..end];
    if text.len() != 88 {
        return Err(Refusal::Signature("the signature is not 88 characters of base64".into()));
    }
    let raw = STANDARD.decode(text).map_err(|_| Refusal::Signature("the signature is not base64".into()))?;
    let raw: [u8; 64] = raw.try_into().map_err(|_| Refusal::Signature("the signature is not 64 bytes".into()))?;
    let sig = Signature::from_bytes(&raw);
    if keys.is_empty() {
        return Err(Refusal::Signature("this launcher trusts no key".into()));
    }
    if keys.iter().any(|k| k.verify_strict(bytes, &sig).is_ok()) {
        Ok(())
    } else {
        Err(Refusal::Signature("no trusted key signed it".into()))
    }
}

fn shape(why: impl Into<String>) -> Refusal {
    Refusal::Shape(why.into())
}

fn string_field<'a>(o: &'a Map<String, Value>, key: &str) -> Result<&'a str, Refusal> {
    o.get(key).and_then(Value::as_str).ok_or_else(|| shape(format!("{key} is not a string")))
}

/// A track build as a manifest writes it: no `+meta`, no space.
fn is_manifest_build(b: &str) -> bool {
    !b.contains('+') && b.trim() == b && parse_track_build(b).is_some()
}

/// The shape alone (no signature): every rule of the schema.
pub fn parse_manifest(bytes: &[u8]) -> Result<Manifest, Refusal> {
    let v: Value = serde_json::from_slice(bytes).map_err(|e| shape(format!("not JSON: {e}")))?;
    let o = v.as_object().ok_or_else(|| shape("not an object"))?;
    const FIELDS: [&str; 11] = ["format", "track", "build", "schema", "channel", "platform", "arch", "minLauncher", "files", "notes", "nextKey"];
    if let Some(k) = o.keys().find(|k| !FIELDS.contains(&k.as_str())) {
        return Err(shape(format!("an unknown field '{k}' (a new field is a new format)")));
    }
    for k in &FIELDS[..10] {
        if !o.contains_key(*k) {
            return Err(shape(format!("no {k}")));
        }
    }
    if !o["format"].is_u64() || o["format"].as_u64() != Some(FORMAT) {
        return Err(shape("format is not 1"));
    }
    let track = string_field(o, "track")?;
    if !["client", "host", "launcher"].contains(&track) {
        return Err(shape(format!("track '{track}'")));
    }
    let build = string_field(o, "build")?;
    if !is_manifest_build(build) {
        return Err(shape(format!("build '{build}' is not a track build")));
    }
    let schema = string_field(o, "schema")?;
    if schema.len() != 10 || build.get(..10) != Some(schema) {
        return Err(shape(format!("schema '{schema}' is not the build's")));
    }
    let channel = string_field(o, "channel")?;
    if !["stable", "dev"].contains(&channel) {
        return Err(shape(format!("channel '{channel}'")));
    }
    let platform = string_field(o, "platform")?;
    if !["win32", "linux"].contains(&platform) {
        return Err(shape(format!("platform '{platform}'")));
    }
    let arch = string_field(o, "arch")?;
    if !["x64", "arm64"].contains(&arch) {
        return Err(shape(format!("arch '{arch}'")));
    }
    let min_launcher = match &o["minLauncher"] {
        Value::Null => None,
        Value::String(m) if is_manifest_build(m) => Some(m.clone()),
        _ => return Err(shape("minLauncher is not a track build or null")),
    };
    let notes = string_field(o, "notes")?;
    if notes.chars().count() > MAX_NOTES_CHARS {
        return Err(shape("notes are too long"));
    }
    let next_key = match o.get("nextKey") {
        None => None,
        Some(Value::String(k)) if k.len() == 44 && k.ends_with('=') && k[..43].bytes().all(|c| c.is_ascii_alphanumeric() || c == b'+' || c == b'/') => Some(k.clone()),
        Some(_) => return Err(shape("nextKey is not a padded base64 key")),
    };
    let list = o["files"].as_array().ok_or_else(|| shape("files is not a list"))?;
    if list.is_empty() {
        return Err(shape("files is empty"));
    }
    let mut files: Vec<ManifestFile> = Vec::with_capacity(list.len());
    let mut seen_lower = std::collections::HashSet::new();
    for f in list {
        let fo = f.as_object().ok_or_else(|| shape("a file is not an object"))?;
        if fo.len() != 3 || !fo.contains_key("path") || !fo.contains_key("size") || !fo.contains_key("sha256") {
            return Err(shape("a file has exactly path, size and sha256"));
        }
        let path = string_field(fo, "path")?;
        if !safe_path(path) {
            return Err(shape(format!("the path '{path}' is not a plain relative path")));
        }
        let size = fo["size"].as_u64().filter(|n| *n <= 9_007_199_254_740_991).ok_or_else(|| shape(format!("{path}: size is not a whole number")))?;
        let sha = string_field(fo, "sha256")?;
        if sha.len() != 64 || !sha.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) {
            return Err(shape(format!("{path}: sha256 is not 64 lower-case hex digits")));
        }
        if let Some(prev) = files.last() {
            if prev.path.as_bytes() >= path.as_bytes() {
                return Err(shape(format!("files are not in strictly ascending byte order at '{path}'")));
            }
        }
        if !seen_lower.insert(path.to_ascii_lowercase()) {
            return Err(shape(format!("two paths are the same ignoring case ('{path}')")));
        }
        files.push(ManifestFile { path: path.to_string(), size, sha256: sha.to_string() });
    }
    Ok(Manifest {
        track: track.into(),
        build: build.into(),
        schema: schema.into(),
        channel: channel.into(),
        platform: platform.into(),
        arch: arch.into(),
        min_launcher,
        files,
        notes: notes.into(),
        next_key,
    })
}

/// Signature, shape, what was asked, newer, minLauncher: in that order.
pub fn check(bytes: &[u8], sig_text: &[u8], keys: &[VerifyingKey], wanted: &Wanted) -> Result<Manifest, Refusal> {
    verify_signature(bytes, sig_text, keys)?;
    let m = parse_manifest(bytes)?;
    if m.track != wanted.track {
        return Err(Refusal::Wrong(format!("track {}, asked for {}", m.track, wanted.track)));
    }
    if m.platform != wanted.platform || m.arch != wanted.arch {
        return Err(Refusal::Wrong(format!("{} {}, this is {} {}", m.platform, m.arch, wanted.platform, wanted.arch)));
    }
    let channel_ok = match wanted.channel {
        "dev" => m.channel == "dev" || m.channel == "stable",
        other => m.channel == other,
    };
    if !channel_ok {
        return Err(Refusal::Wrong(format!("channel {}, this install reads {}", m.channel, wanted.channel)));
    }
    if let Some(current) = wanted.current {
        if compare_track_builds(&m.build, current) != Ordering::Greater {
            return Err(Refusal::NotNewer(format!("{} is not newer than {}", m.build, current)));
        }
    }
    if let (Some(min), Some(launcher)) = (&m.min_launcher, wanted.launcher) {
        if compare_track_builds(min, launcher) == Ordering::Greater {
            return Err(Refusal::LauncherTooOld(format!("it needs launcher {min}, this is {launcher}")));
        }
    }
    Ok(m)
}

/// A manifest path is relative and '/'-separated, with no empty, '.' or '..' segment, no backslash, ':' or control
/// character, at most MAX_PATH_CHARS characters.
pub fn safe_path(path: &str) -> bool {
    if path.is_empty() || path.chars().count() > MAX_PATH_CHARS {
        return false;
    }
    if path.chars().any(|c| c == '\\' || c == ':' || c.is_control()) {
        return false;
    }
    path.split('/').all(|seg| !seg.is_empty() && seg != "." && seg != "..")
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

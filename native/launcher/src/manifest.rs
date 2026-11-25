//! THE TRACK MANIFEST (`contracts/track-manifest.schema.json`, format 1; `src/core/track-manifest.ts` on the TypeScript
//! side). Ed25519 over the exact bytes of manifest.json; manifest.json.sig is the signature in padded base64.
//!
//! CHECKS, IN ORDER: the signature; the shape (an unknown field refuses); track, platform, arch and channel are the ones
//! asked for (stable takes stable only; dev takes dev and stable); the build is newer than the installed one (equal
//! refuses); minLauncher is not newer than the running launcher. The files are checked as they are unpacked
//! (`install`) and before each run (`folder`).

use ed25519_dalek::VerifyingKey;
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
    /// The running launcher's build, for `minLauncher`.
    pub launcher: &'a str,
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

/// This machine, as manifests name it.
pub fn this_platform() -> &'static str {
    if cfg!(windows) { "win32" } else { "linux" }
}
pub fn this_arch() -> &'static str {
    if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" }
}

/// A public key: raw 32 bytes in standard padded base64.
pub fn parse_public_key(text: &str) -> Result<VerifyingKey, String> {
    let _ = text;
    todo!("L2")
}

/// The signature over these exact bytes, by any of `keys`. `sig_text` is manifest.json.sig as read (trailing ASCII
/// whitespace ignored, anything else refused).
pub fn verify_signature(bytes: &[u8], sig_text: &[u8], keys: &[VerifyingKey]) -> Result<(), Refusal> {
    let _ = (bytes, sig_text, keys);
    todo!("L2")
}

/// The shape alone (no signature): every rule of the schema.
pub fn parse_manifest(bytes: &[u8]) -> Result<Manifest, Refusal> {
    let _ = bytes;
    todo!("L2")
}

/// Signature, shape, what was asked, newer, minLauncher: in that order.
pub fn check(bytes: &[u8], sig_text: &[u8], keys: &[VerifyingKey], wanted: &Wanted) -> Result<Manifest, Refusal> {
    let _ = (bytes, sig_text, keys, wanted);
    todo!("L2")
}

/// A manifest path is relative and '/'-separated, with no empty, '.' or '..' segment, no backslash, ':' or control
/// character, at most MAX_PATH_CHARS characters.
pub fn safe_path(path: &str) -> bool {
    let _ = path;
    todo!("L2")
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let _ = bytes;
    todo!("L2")
}

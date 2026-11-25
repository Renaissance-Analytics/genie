//! `install --from <folder>`: the packages and signed manifests on disk (CI bundling, a machine with no internet, the
//! NSIS installer's own packages), checked exactly as a download is. Per track the folder holds
//! `<track>-<build>-<platform>-<arch>.zip|.tar.zst` with `.manifest.json` and `.manifest.json.sig` beside it.
//!
//! Each file is checked (listed, size, sha256) as it is unpacked into `<build>.partial`; then the folder is renamed to
//! `<build>`, its manifest and signature are written in, `.complete` LAST, and `state.json` points at it. Any failure
//! deletes the partial folder and says why in words.

use crate::layout::{Roots, Track};
use ed25519_dalek::VerifyingKey;
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Profile {
    /// The launcher, the client and a local host (the default; the owner, 2026-11-25).
    Both,
    /// The launcher and the client: no host folder, no host at logon.
    Client,
}

impl Profile {
    pub fn parse(text: &str) -> Option<Profile> {
        match text {
            "both" => Some(Profile::Both),
            "client" => Some(Profile::Client),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Profile::Both => "both",
            Profile::Client => "client",
        }
    }
    pub fn tracks(self) -> &'static [Track] {
        match self {
            Profile::Both => &[Track::Client, Track::Host],
            Profile::Client => &[Track::Client],
        }
    }
}

#[derive(Debug, Clone)]
pub struct InstallOptions {
    pub from: PathBuf,
    pub profile: Profile,
    pub channel: String,
    pub launcher_build: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Installed {
    pub track: Track,
    pub build: String,
}

pub fn install_from(roots: &Roots, options: &InstallOptions, keys: &[VerifyingKey]) -> Result<Vec<Installed>, String> {
    let _ = (roots, options, keys);
    todo!("L2")
}

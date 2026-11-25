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

pub fn verify_build(roots: &Roots, track: Track, build: &str, keys: &[VerifyingKey], scope: HashScope) -> Result<Manifest, String> {
    let _ = (roots, track, build, keys, scope);
    todo!("L2")
}

/// Every `<build>.partial` and every build folder with no `.complete` is deleted. What was deleted.
pub fn sweep(roots: &Roots) -> Vec<PathBuf> {
    let _ = roots;
    todo!("L2")
}

//! THE KEYS A MANIFEST IS CHECKED WITH. The public keys built into the launcher (GENIE_MANIFEST_PUBLIC_KEYS at build
//! time, comma-separated, from the protected release environment), plus every `nextKey` a trusted manifest has named
//! (rotation without a launcher update), kept in `<code root>/trusted-keys.json`. Under the `test-keys` feature only
//! (cargo test), GENIE_LAUNCHER_TEST_PUBLIC_KEY adds a throwaway key; a release build never reads it.

use crate::layout::Roots;
use crate::manifest::Manifest;
use ed25519_dalek::VerifyingKey;

pub const TRUSTED_KEYS_FILE: &str = "trusted-keys.json";

pub fn trusted_keys(roots: &Roots) -> Vec<VerifyingKey> {
    let _ = roots;
    todo!("L2")
}

/// A manifest verified with a trusted key vouches for its `nextKey`: kept for the next check.
pub fn learn_next_key(roots: &Roots, manifest: &Manifest) -> Result<(), String> {
    let _ = (roots, manifest);
    todo!("L2")
}

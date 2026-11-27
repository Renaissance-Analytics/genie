//! THE KEYS A MANIFEST IS CHECKED WITH. The public keys built into the launcher (GENIE_MANIFEST_PUBLIC_KEYS at build
//! time, comma-separated, from the protected release environment), plus every `nextKey` a trusted manifest has named
//! (rotation without a launcher update), kept in `<code root>/trusted-keys.json`. Under the `test-keys` feature only
//! (cargo test), GENIE_LAUNCHER_TEST_PUBLIC_KEY adds a throwaway key; a release build never reads it.

use crate::layout::Roots;
use crate::manifest::{parse_public_key, Manifest};
use ed25519_dalek::VerifyingKey;

pub const TRUSTED_KEYS_FILE: &str = "trusted-keys.json";

const BUILT_IN: Option<&str> = option_env!("GENIE_MANIFEST_PUBLIC_KEYS");

fn learned(roots: &Roots) -> Vec<String> {
    std::fs::read(roots.code.join(TRUSTED_KEYS_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice::<Vec<String>>(&b).ok())
        .unwrap_or_default()
}

pub fn trusted_keys(roots: &Roots) -> Vec<VerifyingKey> {
    let mut texts: Vec<String> = BUILT_IN.unwrap_or("").split(',').map(str::trim).filter(|s| !s.is_empty()).map(str::to_string).collect();
    texts.extend(learned(roots));
    #[cfg(feature = "test-keys")]
    {
        if let Ok(k) = std::env::var("GENIE_LAUNCHER_TEST_PUBLIC_KEY") {
            texts.push(k);
        }
    }
    let mut keys: Vec<VerifyingKey> = Vec::new();
    for t in texts {
        if let Ok(k) = parse_public_key(&t) {
            if !keys.contains(&k) {
                keys.push(k);
            }
        }
    }
    keys
}

/// A manifest verified with a trusted key vouches for its `nextKey`: kept for the next check.
pub fn learn_next_key(roots: &Roots, manifest: &Manifest) -> Result<(), String> {
    let Some(next) = &manifest.next_key else { return Ok(()) };
    parse_public_key(next)?;
    let mut all = learned(roots);
    if all.iter().any(|k| k == next) {
        return Ok(());
    }
    all.push(next.clone());
    let file = roots.code.join(TRUSTED_KEYS_FILE);
    let tmp = roots.code.join(format!(".{TRUSTED_KEYS_FILE}.{}.tmp", std::process::id()));
    let bytes = serde_json::to_vec_pretty(&all).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, bytes).and_then(|_| std::fs::rename(&tmp, &file)).map_err(|e| format!("{} could not be written: {e}", file.display()))
}

#[cfg(test)]
mod release_key_tests {
    use super::{trusted_keys, RELEASE_PUBLIC_KEY};
    use crate::layout::Roots;
    use crate::manifest::parse_public_key;

    /// The owner's release key (the `release` environment's GENIE_MANIFEST_PUBLIC_KEY, 2026-11-27), pinned: a launcher built
    /// anywhere, with or without GENIE_MANIFEST_PUBLIC_KEYS, trusts what the release job signs.
    #[test]
    fn the_release_key_is_built_in_and_trusted_with_nothing_else_given() {
        assert_eq!(RELEASE_PUBLIC_KEY, "ydpbhCd7vI9op9SIft6OaN3A8n9aMXjETzBjXRG/49s=");
        let release = parse_public_key(RELEASE_PUBLIC_KEY).expect("a 32-byte Ed25519 key");
        let dir = std::env::temp_dir().join(format!("genie-keys-{}", std::process::id()));
        let roots = Roots { code: dir.join("code"), data: dir.join("data") };
        let keys = trusted_keys(&roots);
        assert_eq!(keys.first(), Some(&release), "the release key comes first: {}", keys.len());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

//! THE SHARED VERIFY-BEFORE-RUN TABLE (test/fixtures/track-manifest-cases.json, Tynn #1058 L2). The TypeScript side
//! (src/core/track-manifest.ts) is held to it in test/track-manifest-table.test.ts; this holds the launcher's `check`
//! and `verify_tree` to the same file, so every case gets the same verdict code in both languages. The seeds in the
//! table are published throwaway test keys; Ed25519 is deterministic, so both sides sign each case to the same bytes.
mod common;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use genie_launcher::folder::{verify_tree, HashScope};
use genie_launcher::manifest::{check, sha256_hex, Manifest, ManifestFile, Wanted};
use serde_json::Value;
use std::path::PathBuf;

fn table() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/track-manifest-cases.json");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("the shared table {} could not be read: {e}", path.display()));
    serde_json::from_str(&text).expect("the shared table is JSON")
}

fn seed_key(hex: &str) -> SigningKey {
    assert_eq!(hex.len(), 64, "a seed is 32 bytes of hex");
    let mut seed = [0u8; 32];
    for (i, b) in seed.iter_mut().enumerate() {
        *b = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).expect("hex");
    }
    SigningKey::from_bytes(&seed)
}

fn key(t: &Value, name: &str) -> SigningKey {
    seed_key(t["seeds"][name].as_str().unwrap_or_else(|| panic!("no seed {name}")))
}

fn applied(text: &str, edits: &Value) -> String {
    let mut out = text.to_string();
    for e in edits.as_array().map(Vec::as_slice).unwrap_or_default() {
        let from = e[0].as_str().unwrap();
        let to = e[1].as_str().unwrap();
        assert!(out.contains(from), "the edit's text is not there: {}", from.chars().take(40).collect::<String>());
        out = out.replacen(from, to, 1);
    }
    out
}

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// The last data character of a padded 64-byte signature carries 2 bits and 4 zero bits: set the lowest.
fn non_canonical(sig: &str) -> String {
    let mut b = sig.as_bytes().to_vec();
    let at = b.len() - 3;
    let v = ALPHABET.iter().position(|c| *c == b[at]).expect("a base64 character");
    b[at] = ALPHABET[v | 1];
    String::from_utf8(b).unwrap()
}

fn s<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str)
}

/// The verdict as the table writes it: `{ok: true}` or `{ok: false, code}`.
fn verdict_of(r: &Result<Manifest, genie_launcher::manifest::Refusal>) -> Value {
    match r {
        Ok(_) => serde_json::json!({ "ok": true }),
        Err(refusal) => serde_json::json!({ "ok": false, "code": refusal.code() }),
    }
}

#[test]
fn the_table_is_format_1_and_its_seeds_sign_a_good_manifest() {
    let t = table();
    assert_eq!(t["format"], 1);
    let a = key(&t, "a");
    let b = key(&t, "b");
    assert_ne!(a.verifying_key(), b.verifying_key());
    // A positive control for every case below: the base, signed by a, verifies with a trusted.
    let base = t["base"].as_str().unwrap();
    let sig = STANDARD.encode(a.sign(base.as_bytes()).to_bytes());
    let e = &t["expectDefault"];
    let wanted = Wanted { track: "host", platform: "linux", arch: "x64", channel: "stable", current: None, launcher: None };
    assert_eq!(s(e, "track"), Some("host"));
    check(base.as_bytes(), sig.as_bytes(), &[a.verifying_key()], &wanted).expect("the base verifies");
}

#[test]
fn check_gives_every_manifest_cases_verdict() {
    let t = table();
    let cases = t["manifestCases"].as_array().expect("manifestCases");
    assert!(cases.len() >= 60);
    let mut wrong = Vec::new();
    for c in cases {
        let name = c["name"].as_str().unwrap();
        let signed_text = applied(s(c, "manifest").unwrap_or(t["base"].as_str().unwrap()), &c["edit"]);
        let delivered = applied(&signed_text, &c["tamper"]);
        let signer = key(&t, s(c, "signer").unwrap_or("a"));
        let signature = STANDARD.encode(signer.sign(signed_text.as_bytes()).to_bytes());
        let sig = match s(c, "sig") {
            Some(given) => given.to_string(),
            None => {
                let body = if s(c, "sigMode") == Some("noncanonical") { non_canonical(&signature) } else { signature };
                format!("{}{}{}", s(c, "sigPrefix").unwrap_or(""), body, s(c, "sigSuffix").unwrap_or(""))
            }
        };
        let trusted: Vec<VerifyingKey> = match c.get("keys").and_then(Value::as_array) {
            Some(ks) => ks.iter().map(|k| key(&t, k.as_str().unwrap()).verifying_key()).collect(),
            None => vec![key(&t, "a").verifying_key()],
        };
        let mut e = t["expectDefault"].clone();
        if let Some(over) = c.get("expect").and_then(Value::as_object) {
            for (k, v) in over {
                e[k.as_str()] = v.clone();
            }
        }
        let wanted = Wanted {
            track: s(&e, "track").unwrap(),
            platform: s(&e, "platform").unwrap(),
            arch: s(&e, "arch").unwrap(),
            channel: s(&e, "channel").unwrap(),
            current: s(&e, "current"),
            launcher: s(&e, "launcher"),
        };
        let got = verdict_of(&check(delivered.as_bytes(), sig.as_bytes(), &trusted, &wanted));
        if got != c["verdict"] {
            wrong.push(format!("{name}: the table says {}, the launcher {}", c["verdict"], got));
        }
    }
    assert!(wrong.is_empty(), "{} of {} cases differ:\n{}", wrong.len(), cases.len(), wrong.join("\n"));
}

#[test]
fn verify_tree_gives_every_tree_cases_verdict() {
    let t = table();
    let cases = t["treeCases"].as_array().expect("treeCases");
    assert!(!cases.is_empty());
    let mut wrong = Vec::new();
    for c in cases {
        let name = c["name"].as_str().unwrap();
        let dir = common::temp_dir("tree-table");
        for f in c["tree"].as_array().unwrap() {
            let path = dir.join(f[0].as_str().unwrap());
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, f[1].as_str().unwrap()).unwrap();
        }
        for d in c.get("dirs").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default() {
            std::fs::create_dir_all(dir.join(d.as_str().unwrap())).unwrap();
        }
        let mut files: Vec<ManifestFile> = c["listed"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| {
                let text = f[1].as_str().unwrap();
                ManifestFile { path: f[0].as_str().unwrap().to_string(), size: text.len() as u64, sha256: sha256_hex(text.as_bytes()) }
            })
            .collect();
        files.sort_by(|x, y| x.path.as_bytes().cmp(y.path.as_bytes()));
        let manifest = Manifest {
            track: "host".into(),
            build: "2026.11.25-1".into(),
            schema: "2026.11.25".into(),
            channel: "stable".into(),
            platform: "linux".into(),
            arch: "x64".into(),
            min_launcher: None,
            files,
            notes: String::new(),
            next_key: None,
        };
        let got = match verify_tree(&manifest, &dir, HashScope::All) {
            Ok(()) => serde_json::json!({ "ok": true }),
            Err(r) => serde_json::json!({ "ok": false, "code": r.code, "path": r.path }),
        };
        if got != c["verdict"] {
            wrong.push(format!("{name}: the table says {}, the launcher {}", c["verdict"], got));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
    assert!(wrong.is_empty(), "{} of {} cases differ:\n{}", wrong.len(), cases.len(), wrong.join("\n"));
}

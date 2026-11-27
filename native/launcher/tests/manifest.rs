//! THE SIGNED MANIFEST (contracts/track-manifest.schema.json): every check, in its order, refuses what it must.
mod common;

use common::*;
use genie_launcher::manifest::{check, parse_manifest, parse_public_key, safe_path, verify_signature, this_arch, this_platform, Refusal, Wanted};
use serde_json::Value;

fn wanted<'a>(track: &'a str, channel: &'a str, current: Option<&'a str>) -> Wanted<'a> {
    Wanted { track, platform: this_platform(), arch: this_arch(), channel, current, launcher: Some("2026.11.25-1") }
}

fn pkg(build: &str) -> Package<'_> {
    Package::new("host", build, vec![("genie-host".into(), b"#!host".to_vec()), ("app/dist/main/host.js".into(), b"host()".to_vec())])
}

fn edit(bytes: &[u8], f: impl FnOnce(&mut Value)) -> Vec<u8> {
    let mut v: Value = serde_json::from_slice(bytes).unwrap();
    f(&mut v);
    serde_json::to_vec(&v).unwrap()
}

#[test]
fn a_signed_manifest_round_trips() {
    let key = throwaway_key();
    let bytes = manifest_bytes(&pkg("2026.11.25-1"));
    let sig = sign_b64(&key, &bytes);
    let m = check(&bytes, sig.as_bytes(), &[verifying(&key)], &wanted("host", "stable", None)).expect("verifies");
    assert_eq!(m.track, "host");
    assert_eq!(m.build, "2026.11.25-1");
    assert_eq!(m.files.len(), 2);
    assert_eq!(m.files[0].path, "app/dist/main/host.js", "sorted by byte order");
}

#[test]
fn the_signature_file_may_end_in_ascii_whitespace_and_nothing_else() {
    let key = throwaway_key();
    let bytes = manifest_bytes(&pkg("2026.11.25-1"));
    let sig = sign_b64(&key, &bytes);
    let keys = [verifying(&key)];
    assert!(verify_signature(&bytes, format!("{sig}\r\n \t").as_bytes(), &keys).is_ok());
    assert!(matches!(verify_signature(&bytes, format!("{sig}x").as_bytes(), &keys), Err(Refusal::Signature(_))));
    assert!(matches!(verify_signature(&bytes, format!(" {sig}").as_bytes(), &keys), Err(Refusal::Signature(_))));
}

#[test]
fn one_flipped_byte_in_the_manifest_or_the_signature_refuses() {
    let key = throwaway_key();
    let bytes = manifest_bytes(&pkg("2026.11.25-1"));
    let sig = sign_b64(&key, &bytes);
    let keys = [verifying(&key)];
    let mut flipped = bytes.clone();
    let at = flipped.len() / 2;
    flipped[at] ^= 0x01;
    assert!(matches!(check(&flipped, sig.as_bytes(), &keys, &wanted("host", "stable", None)), Err(Refusal::Signature(_))));
    let mut raw = base64_decode(&sig);
    raw[10] ^= 0x01;
    let bad = base64_encode(&raw);
    assert!(matches!(check(&bytes, bad.as_bytes(), &keys, &wanted("host", "stable", None)), Err(Refusal::Signature(_))));
}

#[test]
fn a_key_that_is_not_trusted_refuses_and_no_key_refuses() {
    let key = throwaway_key();
    let other = throwaway_key();
    let bytes = manifest_bytes(&pkg("2026.11.25-1"));
    let sig = sign_b64(&key, &bytes);
    assert!(matches!(check(&bytes, sig.as_bytes(), &[verifying(&other)], &wanted("host", "stable", None)), Err(Refusal::Signature(_))));
    assert!(matches!(check(&bytes, sig.as_bytes(), &[], &wanted("host", "stable", None)), Err(Refusal::Signature(_))));
    // The words the person reads.
    let words = check(&bytes, sig.as_bytes(), &[], &wanted("host", "stable", None)).unwrap_err().to_string();
    assert!(words.starts_with("This update's signature is not Genie's. Nothing was installed."), "{words}");
}

#[test]
fn the_wrong_track_platform_arch_or_channel_refuses() {
    let key = throwaway_key();
    let keys = [verifying(&key)];
    let bytes = manifest_bytes(&pkg("2026.11.25-1"));
    let sig = sign_b64(&key, &bytes);
    assert!(matches!(check(&bytes, sig.as_bytes(), &keys, &wanted("client", "stable", None)), Err(Refusal::Wrong(..))));
    let mut w = wanted("host", "stable", None);
    let other_platform = if this_platform() == "win32" { "linux" } else { "win32" };
    w.platform = other_platform;
    assert!(matches!(check(&bytes, sig.as_bytes(), &keys, &w), Err(Refusal::Wrong(..))));
    let mut w = wanted("host", "stable", None);
    let other_arch = if this_arch() == "x64" { "arm64" } else { "x64" };
    w.arch = other_arch;
    assert!(matches!(check(&bytes, sig.as_bytes(), &keys, &w), Err(Refusal::Wrong(..))));
    // stable takes stable only; dev takes dev and stable.
    let mut dev = pkg("2026.11.25-1");
    dev.channel = "dev";
    let dev_bytes = manifest_bytes(&dev);
    let dev_sig = sign_b64(&key, &dev_bytes);
    assert!(matches!(check(&dev_bytes, dev_sig.as_bytes(), &keys, &wanted("host", "stable", None)), Err(Refusal::Wrong(..))));
    assert!(check(&dev_bytes, dev_sig.as_bytes(), &keys, &wanted("host", "dev", None)).is_ok());
    assert!(check(&bytes, sig.as_bytes(), &keys, &wanted("host", "dev", None)).is_ok());
}

#[test]
fn a_downgrade_or_the_same_build_refuses() {
    let key = throwaway_key();
    let keys = [verifying(&key)];
    let bytes = manifest_bytes(&pkg("2026.11.25-1"));
    let sig = sign_b64(&key, &bytes);
    assert!(matches!(check(&bytes, sig.as_bytes(), &keys, &wanted("host", "stable", Some("2026.11.25-1"))), Err(Refusal::NotNewer(_))));
    assert!(matches!(check(&bytes, sig.as_bytes(), &keys, &wanted("host", "stable", Some("2026.11.25-2"))), Err(Refusal::NotNewer(_))));
    assert!(matches!(check(&bytes, sig.as_bytes(), &keys, &wanted("host", "stable", Some("2026.12.01-1"))), Err(Refusal::NotNewer(_))));
    assert!(check(&bytes, sig.as_bytes(), &keys, &wanted("host", "stable", Some("2026.11.18-1.1"))).is_ok());
    // An install that was not a track build (the bridge's 2.0.0) is older than any track build.
    assert!(check(&bytes, sig.as_bytes(), &keys, &wanted("host", "stable", Some("2.0.0"))).is_ok());
}

#[test]
fn min_launcher_newer_than_the_running_launcher_refuses() {
    let key = throwaway_key();
    let keys = [verifying(&key)];
    let mut p = pkg("2026.11.25-1");
    p.min_launcher = Some("2026.11.26-1");
    let bytes = manifest_bytes(&p);
    let sig = sign_b64(&key, &bytes);
    assert!(matches!(check(&bytes, sig.as_bytes(), &keys, &wanted("host", "stable", None)), Err(Refusal::LauncherTooOld(_))));
    p.min_launcher = Some("2026.11.25-1");
    let bytes = manifest_bytes(&p);
    let sig = sign_b64(&key, &bytes);
    assert!(check(&bytes, sig.as_bytes(), &keys, &wanted("host", "stable", None)).is_ok());
}

#[test]
fn the_signature_is_checked_before_the_shape() {
    // A badly shaped manifest with no good signature says signature, not shape: nothing unsigned is even read.
    let bytes = br#"{"format": 2}"#;
    assert!(matches!(check(bytes, b"AAAA", &[verifying(&throwaway_key())], &wanted("host", "stable", None)), Err(Refusal::Signature(_))));
}

#[test]
fn the_shape_refuses_what_the_schema_refuses() {
    let good = manifest_bytes(&pkg("2026.11.25-1"));
    assert!(parse_manifest(&good).is_ok());
    let bad: Vec<(&str, Vec<u8>)> = vec![
        ("an unknown field", edit(&good, |v| v["extra"] = Value::Bool(true))),
        ("format 1 (never published)", edit(&good, |v| v["format"] = 1.into())),
        ("a missing field", edit(&good, |v| { v.as_object_mut().unwrap().remove("notes"); })),
        ("a +meta build", edit(&good, |v| v["build"] = "2026.11.25-1+ci.7".into())),
        ("a schema that is not the build's", edit(&good, |v| v["schema"] = "2026.11.24".into())),
        ("a date that is not a date", edit(&good, |v| { v["build"] = "2026.02.30-1".into(); v["schema"] = "2026.02.30".into(); })),
        ("an unknown track (a GApp joins in a later format)", edit(&good, |v| v["track"] = "gapp".into())),
        ("a browser that names no client", edit(&good, |v| { v["track"] = "browser".into(); v.as_object_mut().unwrap().remove("withClient"); })),
        ("a client that names a client", edit(&good, |v| v["track"] = "client".into())),
        ("an unknown channel", edit(&good, |v| v["channel"] = "beta".into())),
        ("no files", edit(&good, |v| v["files"] = Value::Array(vec![]))),
        ("files out of order", edit(&good, |v| v["files"].as_array_mut().unwrap().reverse())),
        ("a file with an extra field", edit(&good, |v| v["files"][0]["mode"] = 0o755.into())),
        ("an upper-case hash", edit(&good, |v| { let h = v["files"][0]["sha256"].as_str().unwrap().to_uppercase(); v["files"][0]["sha256"] = h.into(); })),
        ("a negative size", edit(&good, |v| v["files"][0]["size"] = (-1).into())),
        ("a bad minLauncher", edit(&good, |v| v["minLauncher"] = "soon".into())),
        ("a bad nextKey", edit(&good, |v| v["nextKey"] = "abc".into())),
        ("not JSON", b"{".to_vec()),
    ];
    for (name, bytes) in bad {
        assert!(matches!(parse_manifest(&bytes), Err(Refusal::Shape(_))), "{name} must refuse");
    }
}

#[test]
fn two_paths_equal_ignoring_case_refuse() {
    let p = Package::new("host", "2026.11.25-1", vec![("A.dll".into(), b"1".to_vec()), ("a.dll".into(), b"2".to_vec())]);
    assert!(matches!(parse_manifest(&manifest_bytes(&p)), Err(Refusal::Shape(_))));
}

#[test]
fn a_manifest_path_is_relative_and_plain() {
    for ok in ["a", "app/dist/main/host.js", "resources/x.node", "a b/c"] {
        assert!(safe_path(ok), "{ok}");
    }
    for bad in ["", "/a", "a/", "a//b", "./a", "a/./b", "../a", "a/../b", "a\\b", "C:/a", "a:b", "a\u{0}b", "a\nb", "a\u{7f}"] {
        assert!(!safe_path(bad), "{bad:?}");
    }
    assert!(!safe_path(&"a".repeat(1025)));
}

#[test]
fn public_keys_are_32_bytes_in_padded_base64() {
    let key = throwaway_key();
    assert_eq!(parse_public_key(&public_b64(&key)).unwrap(), verifying(&key));
    assert!(parse_public_key("AAAA").is_err());
    assert!(parse_public_key(&public_b64(&key).trim_end_matches('=').to_string()).is_err());
}

fn base64_decode(s: &str) -> Vec<u8> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    STANDARD.decode(s).unwrap()
}
fn base64_encode(b: &[u8]) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    STANDARD.encode(b)
}

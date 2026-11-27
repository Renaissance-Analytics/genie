//! What the launcher's tests share: a throwaway signing key (made per run, never kept), temporary roots, and packages
//! built here the way L1's scripts/pack-track.mjs lays them out (`<track>-<build>-<platform>-<arch>.zip|.tar.zst`, with
//! `.manifest.json` and `.manifest.json.sig` beside it).
#![allow(dead_code)]

use base64::{engine::general_purpose::STANDARD, Engine as _};
use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use genie_launcher::layout::Roots;
use genie_launcher::manifest::{sha256_hex, this_arch, this_platform};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU32, Ordering};

pub fn throwaway_key() -> SigningKey {
    let mut seed = [0u8; 32];
    getrandom::getrandom(&mut seed).expect("random bytes");
    SigningKey::from_bytes(&seed)
}

pub fn public_b64(key: &SigningKey) -> String {
    STANDARD.encode(key.verifying_key().to_bytes())
}

pub fn verifying(key: &SigningKey) -> VerifyingKey {
    key.verifying_key()
}

pub fn sign_b64(key: &SigningKey, bytes: &[u8]) -> String {
    STANDARD.encode(key.sign(bytes).to_bytes())
}

static N: AtomicU32 = AtomicU32::new(0);

/// A fresh folder under the system's temp folder, made private to this user (as a real code root is).
pub fn temp_dir(name: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join(format!("genie-l2-{name}-{}-{nanos}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
    std::fs::create_dir_all(&dir).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    #[cfg(windows)]
    make_private_windows(&dir);
    dir
}

/// A protected DACL, this user and SYSTEM only, inherited by everything below: what %LOCALAPPDATA% gives a real code
/// root. The system's temp folder may not (the Azure VM's D:\genie\tmp inherits BUILTIN\Users' create rights from the
/// drive's root, and the launcher rightly refuses a code root there: run 1125-060418-1c2da8).
#[cfg(windows)]
fn make_private_windows(dir: &Path) {
    let sid = genie_launcher::win::current_user_sid().expect("this user's SID");
    let out = Command::new(r"C:\Windows\System32\icacls.exe")
        .arg(dir)
        .args(["/inheritance:r", "/grant:r", &format!("*{sid}:(OI)(CI)F"), "/grant:r", "*S-1-5-18:(OI)(CI)F"])
        .output()
        .expect("icacls ran");
    assert!(out.status.success(), "icacls: {}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    let others = genie_launcher::win::other_writers(dir).expect("the DACL reads back");
    assert!(others.is_empty(), "the test folder is private: {others:?}");
}

pub fn roots(base: &Path) -> Roots {
    let code = base.join("code");
    let data = base.join("data");
    std::fs::create_dir_all(&code).unwrap();
    std::fs::create_dir_all(&data).unwrap();
    Roots { code, data }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Format {
    Zip,
    TarZst,
}

pub fn native_format() -> Format {
    if cfg!(windows) { Format::Zip } else { Format::TarZst }
}

pub struct Package<'a> {
    pub track: &'a str,
    pub build: &'a str,
    pub channel: &'a str,
    pub files: Vec<(String, Vec<u8>)>,
    pub format: Format,
    pub min_launcher: Option<&'a str>,
    pub next_key: Option<String>,
    /// A host's or a browser's client build (format 2's `withClient`): the build itself unless a test says otherwise.
    pub with_client: Option<&'a str>,
}

impl<'a> Package<'a> {
    pub fn new(track: &'a str, build: &'a str, files: Vec<(String, Vec<u8>)>) -> Package<'a> {
        let with_client = if track == "host" || track == "browser" { Some(build) } else { None };
        Package { track, build, channel: "stable", files, format: native_format(), min_launcher: None, next_key: None, with_client }
    }
    pub fn stem(&self) -> String {
        format!("{}-{}-{}-{}", self.track, self.build, this_platform(), this_arch())
    }
}

/// The manifest's bytes for `files` (sorted by path, byte order), as L1 writes them.
pub fn manifest_bytes(p: &Package) -> Vec<u8> {
    let mut files = p.files.clone();
    files.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    let mut m = json!({
        "format": 2,
        "track": p.track,
        "build": p.build,
        "schema": &p.build[..10],
        "channel": p.channel,
        "platform": this_platform(),
        "arch": this_arch(),
        "minLauncher": p.min_launcher,
        "files": files.iter().map(|(path, bytes)| json!({"path": path, "size": bytes.len(), "sha256": sha256_hex(bytes)})).collect::<Vec<_>>(),
        "notes": "a test package",
    });
    if let Some(c) = p.with_client {
        m["withClient"] = Value::String(c.to_string());
    }
    if let Some(k) = &p.next_key {
        m["nextKey"] = Value::String(k.clone());
    }
    serde_json::to_vec_pretty(&m).unwrap()
}

/// Writes the package's asset, manifest and signature into `dir`; the asset's path.
pub fn write_package(dir: &Path, key: &SigningKey, p: &Package) -> PathBuf {
    let manifest = manifest_bytes(p);
    write_package_with(dir, key, p, &manifest, &p.files)
}

/// The same, with the manifest's bytes and the archived files given (to tamper with one of them).
pub fn write_package_with(dir: &Path, key: &SigningKey, p: &Package, manifest: &[u8], archived: &[(String, Vec<u8>)]) -> PathBuf {
    std::fs::create_dir_all(dir).unwrap();
    let stem = p.stem();
    std::fs::write(dir.join(format!("{stem}.manifest.json")), manifest).unwrap();
    std::fs::write(dir.join(format!("{stem}.manifest.json.sig")), sign_b64(key, manifest)).unwrap();
    let (name, bytes) = match p.format {
        Format::Zip => (format!("{stem}.zip"), zip(archived, true)),
        Format::TarZst => (format!("{stem}.tar.zst"), zstd_raw(&tar(archived))),
    };
    let asset = dir.join(name);
    std::fs::write(&asset, bytes).unwrap();
    asset
}

// --- a zip writer (stored or deflated entries; enough for the reader's tests) -----------------------------------------
pub fn zip(files: &[(String, Vec<u8>)], deflate: bool) -> Vec<u8> {
    let mut out = Vec::new();
    let mut central = Vec::new();
    for (i, (name, data)) in files.iter().enumerate() {
        let compress = deflate && i % 2 == 0;
        let body = if compress { miniz_oxide::deflate::compress_to_vec(data, 6) } else { data.clone() };
        let method: u16 = if compress { 8 } else { 0 };
        let offset = out.len() as u32;
        let crc = 0u32; // the reader checks sha256 against the signed manifest, not the CRC
        out.extend_from_slice(&0x04034b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&0x0800u16.to_le_bytes()); // UTF-8 names
        out.extend_from_slice(&method.to_le_bytes());
        out.extend_from_slice(&[0, 0, 0, 0]);
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&(body.len() as u32).to_le_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(&body);
        central.extend_from_slice(&0x02014b50u32.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&0x0800u16.to_le_bytes());
        central.extend_from_slice(&method.to_le_bytes());
        central.extend_from_slice(&[0, 0, 0, 0]);
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&(body.len() as u32).to_le_bytes());
        central.extend_from_slice(&(data.len() as u32).to_le_bytes());
        central.extend_from_slice(&(name.len() as u16).to_le_bytes());
        central.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 0]); // extra, comment, disk, internal attributes
        central.extend_from_slice(&[0, 0, 0, 0]); // external attributes
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name.as_bytes());
    }
    let cd_offset = out.len() as u32;
    out.extend_from_slice(&central);
    out.extend_from_slice(&0x06054b50u32.to_le_bytes());
    out.extend_from_slice(&[0, 0, 0, 0]);
    out.extend_from_slice(&(files.len() as u16).to_le_bytes());
    out.extend_from_slice(&(files.len() as u16).to_le_bytes());
    out.extend_from_slice(&(central.len() as u32).to_le_bytes());
    out.extend_from_slice(&cd_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

// --- a ustar writer, with an entry type for links -------------------------------------------------------------------
pub fn tar(files: &[(String, Vec<u8>)]) -> Vec<u8> {
    tar_entries(&files.iter().map(|(n, d)| (n.clone(), b'0', d.clone())).collect::<Vec<_>>())
}

pub fn tar_entries(entries: &[(String, u8, Vec<u8>)]) -> Vec<u8> {
    let mut out = Vec::new();
    for (name, kind, data) in entries {
        let mut h = [0u8; 512];
        h[..name.len()].copy_from_slice(name.as_bytes());
        h[100..107].copy_from_slice(b"0000644");
        h[108..115].copy_from_slice(b"0000000");
        h[116..123].copy_from_slice(b"0000000");
        h[124..135].copy_from_slice(format!("{:011o}", data.len()).as_bytes());
        h[136..147].copy_from_slice(b"00000000000");
        h[156] = *kind;
        h[257..263].copy_from_slice(b"ustar\0");
        h[263..265].copy_from_slice(b"00");
        h[148..156].copy_from_slice(b"        ");
        let sum: u32 = h.iter().map(|b| *b as u32).sum();
        h[148..155].copy_from_slice(format!("{:06o}\0", sum).as_bytes());
        out.extend_from_slice(&h);
        out.extend_from_slice(data);
        out.resize(out.len().div_ceil(512) * 512, 0);
    }
    out.extend_from_slice(&[0u8; 1024]);
    out
}

/// A zstd frame of raw (stored) blocks: a real .zst any decoder reads.
pub fn zstd_raw(data: &[u8]) -> Vec<u8> {
    let mut out = vec![0x28, 0xB5, 0x2F, 0xFD, 0x00, 0x38]; // magic; no checksum, no size; window 2^17
    let chunks: Vec<&[u8]> = if data.is_empty() { vec![&[][..]] } else { data.chunks(128 * 1024).collect() };
    for (i, chunk) in chunks.iter().enumerate() {
        let last = if i + 1 == chunks.len() { 1u32 } else { 0 };
        let header = last | (0 << 1) | ((chunk.len() as u32) << 3);
        out.extend_from_slice(&header.to_le_bytes()[..3]);
        out.extend_from_slice(chunk);
    }
    out
}

// --- the launcher binary ----------------------------------------------------------------------------------------------
pub fn genie() -> Command {
    Command::new(env!("CARGO_BIN_EXE_genie"))
}

/// A launcher in these roots. Its logon entry (L5) goes to a place of the test's own, never the VM's real Run value or
/// autostart file, and it shows no tray icon: a test makes dozens of launchers.
pub fn genie_in(roots: &Roots, key: &SigningKey) -> Command {
    let mut c = genie();
    c.env("GENIE_CODE_ROOT", &roots.code).env("GENIE_HOME", &roots.data).env("GENIE_LAUNCHER_TEST_PUBLIC_KEY", public_b64(key));
    c.env("XDG_CONFIG_HOME", roots.data.join("xdg-config")).env("GENIE_LOGON_RUN_KEY", test_run_key(roots)).env("GENIE_LAUNCHER_NO_TRAY", "1");
    c
}

/// The HKCU key a test launcher's Run value goes in: one per test's roots.
pub fn test_run_key(roots: &Roots) -> String {
    let id = roots.data.parent().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "x".to_string());
    format!(r"Software\GenieLauncherTest\{id}")
}

/// Where `genie_in`'s launcher writes its logon entry.
pub fn test_logon_place(roots: &Roots) -> genie_launcher::logon::Place {
    if cfg!(windows) {
        genie_launcher::logon::Place::WindowsRun { key: test_run_key(roots), value: genie_launcher::logon::RUN_VALUE.to_string() }
    } else {
        genie_launcher::logon::Place::Autostart { file: roots.data.join("xdg-config").join("autostart").join("genie.desktop") }
    }
}

pub fn run(c: &mut Command) -> Output {
    c.output().expect("the launcher ran")
}

pub fn text(o: &Output) -> String {
    format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr))
}

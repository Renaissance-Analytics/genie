//! `install --from <folder>`: the packages and signed manifests on disk (CI bundling, a machine with no internet, the
//! NSIS installer's own packages), checked exactly as a download is. Per track the folder holds
//! `<track>-<build>-<platform>-<arch>.zip|.tar.zst` with `.manifest.json` and `.manifest.json.sig` beside it.
//!
//! Each file is checked (listed, size, sha256) as it is unpacked into `<build>.partial`; then the folder is renamed to
//! `<build>`, its manifest and signature are written in, `.complete` LAST, and `state.json` points at it. Any failure
//! deletes the partial folder and says why in words.
//!
//! Every profile installs the client and the browser (each its own track); `both` adds the host. A host installs only
//! beside the client build it ships with (its manifest's `withClient`): the one installed in the same pass, or the client
//! already current. A client or browser package alone never touches the host (the owner, 2026-11-26).
//!
//! On Linux a launcher package in the folder installs the launcher itself, at `<code root>/launcher/<build>/genie`, with
//! `~/.local/bin/genie` and the desktop entry pointing at it (`desktop`). On Windows the NSIS installer puts the launcher
//! at the Genie.exe path every shortcut already uses, so a launcher package is not read there.

use crate::layout::{Roots, Track};
use ed25519_dalek::VerifyingKey;
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Profile {
    /// The launcher, the client, the browser and a local host (the default; the owner, 2026-11-25).
    Both,
    /// The launcher, the client and the browser: no host folder, no host at logon.
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
            Profile::Both => &[Track::Client, Track::Browser, Track::Host],
            Profile::Client => &[Track::Client, Track::Browser],
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

use crate::archive::for_each_file;
use crate::folder::{name_key, sweep, COMPLETE, MANIFEST, PARTIAL_SUFFIX, SIGNATURE};
use crate::manifest::{check, sha256_hex, this_arch, this_platform, Manifest, Refusal, Wanted};
use crate::version::compare_track_builds;
use crate::{keys, state};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;

/// One track's package found in the `--from` folder, checked, and unpacked into its partial folder.
struct Staged {
    track: Track,
    manifest: Manifest,
    manifest_bytes: Vec<u8>,
    sig: Vec<u8>,
    partial: PathBuf,
    target: PathBuf,
}

/// The newest `<track>-<build>-<platform>-<arch>.manifest.json` in `from`: its build and its file stem.
fn find_package(from: &Path, track: Track) -> Result<(String, String), String> {
    let prefix = format!("{}-", track.as_str());
    let suffix = format!("-{}-{}.manifest.json", this_platform(), this_arch());
    let entries = std::fs::read_dir(from).map_err(|e| format!("{} could not be read: {e}", from.display()))?;
    let mut best: Option<String> = None;
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(build) = name.strip_prefix(&prefix).and_then(|r| r.strip_suffix(&suffix)) else { continue };
        if crate::version::parse_track_build(build).is_none() {
            continue;
        }
        if best.as_deref().map_or(true, |b| compare_track_builds(build, b) == std::cmp::Ordering::Greater) {
            best = Some(build.to_string());
        }
    }
    let build = best.ok_or_else(|| format!("there is no {} package for {} {} in {}", track.as_str(), this_platform(), this_arch(), from.display()))?;
    let stem = format!("{}{}-{}-{}", prefix, build, this_platform(), this_arch());
    Ok((build, stem))
}

/// Executables keep their execute bit on Linux: a file that starts as an ELF binary or a script.
#[cfg(unix)]
fn mode_for(data: &[u8]) -> u32 {
    if data.starts_with(b"\x7fELF") || data.starts_with(b"#!") { 0o755 } else { 0o644 }
}

fn write_file(path: &Path, data: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode_for(data));
    }
    let mut f = options.open(path)?;
    f.write_all(data)?;
    f.sync_all()
}

fn files_refusal(why: impl Into<String>) -> String {
    Refusal::Files(why.into()).to_string()
}

/// One track's package found in the `--from` folder with its manifest checked (signature, shape, the package asked for,
/// newer, minLauncher), not yet unpacked.
struct Checked {
    track: Track,
    manifest: Manifest,
    manifest_bytes: Vec<u8>,
    sig: Vec<u8>,
    archive: PathBuf,
    partial: PathBuf,
    target: PathBuf,
}

/// What an install has done so far, for the setup window (`ui`): every manifest checked, then each file unpacked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Progress {
    Checked { files: usize },
    File { track: Track, done: usize, of: usize },
}

fn check_package(roots: &Roots, options: &InstallOptions, keys: &[VerifyingKey], current: &state::State, track: Track) -> Result<Checked, String> {
    let (build, stem) = find_package(&options.from, track)?;
    let manifest_bytes = std::fs::read(options.from.join(format!("{stem}.manifest.json"))).map_err(|e| format!("{stem}.manifest.json: {e}"))?;
    let sig = std::fs::read(options.from.join(format!("{stem}.manifest.json.sig"))).map_err(|e| format!("{stem}.manifest.json.sig: {e}"))?;
    let wanted = Wanted {
        track: track.as_str(),
        platform: this_platform(),
        arch: this_arch(),
        channel: &options.channel,
        current: current.track(track.as_str()).and_then(|t| t.current.as_deref()),
        launcher: Some(&options.launcher_build),
    };
    let manifest = check(&manifest_bytes, &sig, keys, &wanted).map_err(|r| r.to_string())?;
    if manifest.build != build {
        return Err(Refusal::Wrong("build", format!("the file says {build}, its manifest {}", manifest.build)).to_string());
    }
    let archive = [".zip", ".tar.zst"].iter().map(|ext| options.from.join(format!("{stem}{ext}"))).find(|p| p.is_file()).ok_or_else(|| format!("{stem}: no .zip or .tar.zst beside its manifest"))?;
    let target = roots.build_dir(track, &build).ok_or("not a track build")?;
    let partial = roots.track_dir(track).join(format!("{build}{PARTIAL_SUFFIX}"));
    Ok(Checked { track, manifest, manifest_bytes, sig, archive, partial, target })
}

/// Unpacks a checked package into its partial folder, each file checked (listed, size, sha256) as it lands.
fn unpack(c: Checked, progress: &mut dyn FnMut(Progress)) -> Result<Staged, String> {
    let partial = c.partial.clone();
    if partial.exists() {
        std::fs::remove_dir_all(&partial).map_err(|e| format!("{} could not be cleared: {e}", partial.display()))?;
    }
    std::fs::create_dir_all(&partial).map_err(|e| format!("{} could not be made: {e}", partial.display()))?;
    let listed: BTreeMap<String, &crate::manifest::ManifestFile> = c.manifest.files.iter().map(|f| (name_key(&f.path), f)).collect();
    let of = listed.len();
    let mut seen = std::collections::BTreeSet::new();
    let unpacked = for_each_file(&c.archive, &mut |name, data| {
        let key = name_key(name);
        let f = listed.get(&key).ok_or_else(|| files_refusal(format!("{name} is in the package but not in its manifest")))?;
        if !seen.insert(key) {
            return Err(files_refusal(format!("{name} is in the package twice")));
        }
        if data.len() as u64 != f.size || sha256_hex(data) != f.sha256 {
            return Err(files_refusal(format!("{name} is not the file its manifest names")));
        }
        write_file(&partial.join(&f.path), data).map_err(|e| format!("{name} could not be written: {e}"))?;
        progress(Progress::File { track: c.track, done: seen.len(), of });
        Ok(())
    });
    let unpacked = unpacked.and_then(|_| match listed.iter().find(|(k, _)| !seen.contains(*k)) {
        Some((_, f)) => Err(files_refusal(format!("{} is missing from the package", f.path))),
        None => Ok(()),
    });
    if let Err(why) = unpacked {
        let _ = std::fs::remove_dir_all(&partial);
        return Err(why);
    }
    Ok(Staged { track: c.track, manifest: c.manifest, manifest_bytes: c.manifest_bytes, sig: c.sig, partial: c.partial, target: c.target })
}

fn commit(s: &Staged) -> std::io::Result<()> {
    if s.target.exists() {
        std::fs::remove_dir_all(&s.target)?;
    }
    std::fs::rename(&s.partial, &s.target)?;
    write_file(&s.target.join(MANIFEST), &s.manifest_bytes)?;
    write_file(&s.target.join(SIGNATURE), &s.sig)?;
    // LAST: a folder with this marker is one whose every file landed.
    write_file(&s.target.join(COMPLETE), s.manifest.build.as_bytes())
}

/// A host's or a browser's `withClient` is the client checked beside it, or else the client already current. Before
/// anything unpacks: a host ships with its client, and a browser runs on it.
fn host_ships_with_its_client(checked: &[Checked], st: &state::State) -> Result<(), String> {
    let client = checked
        .iter()
        .find(|s| s.track == Track::Client)
        .map(|s| s.manifest.build.clone())
        .or_else(|| st.track(Track::Client.as_str()).and_then(|t| t.current.clone()));
    for c in checked.iter().filter(|c| c.track == Track::Host || c.track == Track::Browser) {
        let (name, verb) = if c.track == Track::Host { ("host", "ships with") } else { ("browser", "runs on") };
        let Some(wanted) = c.manifest.with_client.as_deref() else {
            return Err(format!("The {name} {} names no client build. Nothing was installed.", c.manifest.build));
        };
        match &client {
            Some(have) if have == wanted => {}
            Some(have) => return Err(format!("The {name} {} {verb} client {wanted}, and the client here is {have}: it is installed only with that client. Nothing was installed.", c.manifest.build)),
            None => return Err(format!("The {name} {} {verb} client {wanted}, and there is no client here. Nothing was installed.", c.manifest.build)),
        }
    }
    Ok(())
}

pub fn install_from(roots: &Roots, options: &InstallOptions, keys: &[VerifyingKey]) -> Result<Vec<Installed>, String> {
    install_from_with(roots, options, keys, &mut |_| {})
}

/// `install_from`, saying how far it is: every manifest is checked first, then each package unpacks.
pub fn install_from_with(roots: &Roots, options: &InstallOptions, keys: &[VerifyingKey], progress: &mut dyn FnMut(Progress)) -> Result<Vec<Installed>, String> {
    sweep(roots);
    let mut st = state::read(&roots.state_file())?;
    let mut tracks: Vec<Track> = options.profile.tracks().to_vec();
    if cfg!(unix) && find_package(&options.from, Track::Launcher).is_ok() {
        tracks.push(Track::Launcher);
    }
    let mut checked: Vec<Checked> = Vec::new();
    for track in &tracks {
        checked.push(check_package(roots, options, keys, &st, *track)?);
    }
    host_ships_with_its_client(&checked, &st)?;
    progress(Progress::Checked { files: checked.iter().map(|c| c.manifest.files.len()).sum() });
    let mut staged: Vec<Staged> = Vec::new();
    for c in checked {
        match unpack(c, progress) {
            Ok(s) => staged.push(s),
            Err(why) => {
                for s in &staged {
                    let _ = std::fs::remove_dir_all(&s.partial);
                }
                return Err(why);
            }
        }
    }
    let mut done = Vec::new();
    for s in &staged {
        if let Err(e) = commit(s) {
            let _ = std::fs::remove_dir_all(&s.partial);
            let _ = std::fs::remove_dir_all(&s.target);
            for later in staged.iter().filter(|l| l.target != s.target) {
                let _ = std::fs::remove_dir_all(&later.partial);
            }
            return Err(format!("{} {} could not be put in place: {e}", s.track.as_str(), s.manifest.build));
        }
        st.point(s.track.as_str(), &s.manifest.build, &options.channel);
        keys::learn_next_key(roots, &s.manifest)?;
        done.push(Installed { track: s.track, build: s.manifest.build.clone() });
    }
    st.profile = Some(options.profile.as_str().to_string());
    state::write_atomic(&roots.state_file(), &st).map_err(|e| format!("state.json could not be written: {e}"))?;
    #[cfg(unix)]
    if let Some(l) = done.iter().find(|d| d.track == Track::Launcher) {
        crate::desktop::write_entries(roots, &l.build)?;
    }
    Ok(done)
}

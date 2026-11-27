//! THE FEED (Tynn #1058 L6; the spec's "Feed and channels"). Each track releases on its own tag in Genie's repository
//! (`client-v<build>`, `host-v<build>`, `browser-v<build>`, `launcher-v<build>`), each release carrying one package per
//! OS and architecture with its `manifest.json` and `manifest.json.sig`, named as `install --from` reads them
//! (`<track>-<build>-<platform>-<arch>.zip|.tar.zst`, `.manifest.json`, `.manifest.json.sig`).
//!
//! The launcher lists the releases through GitHub's REST API with an ETag: the answer is kept with its ETag in
//! `<data root>/launcher/feed.json`, and the next list sends `If-None-Match`, so a `304 Not Modified` costs nothing
//! against the unauthenticated limit. A draft is invisible (GitHub lists drafts only to a token, and the launcher has
//! none); `stable` reads full releases, `dev` prereleases too. GENIE_LAUNCHER_FEED names another list (a CI bundle, a
//! VM row's local feed of throwaway-signed packages). Only https is read, or http to this machine.
//!
//! Nothing here trusts what it reads: a download is unverified bytes until `updates` has checked its signed manifest.

use crate::layout::{Roots, Track};
use crate::manifest::{this_arch, this_platform};
use serde_json::{json, Value};
use std::io::Read;
use std::path::Path;
use std::time::Duration;

/// Genie's releases (the repository every installed Genie already trusts).
pub const DEFAULT_FEED: &str = "https://api.github.com/repos/Renaissance-Analytics/genie/releases?per_page=100";

/// The largest file the launcher downloads: a package is well under this (the host's is ~100 MB).
pub const MAX_DOWNLOAD: u64 = 1 << 31;
/// The largest release list it reads.
const MAX_LIST: u64 = 16 << 20;

/// One track's release in the feed, for this platform and architecture.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Offer {
    pub track: Track,
    pub build: String,
    pub prerelease: bool,
    pub notes: String,
    pub manifest_url: String,
    pub signature_url: String,
    pub archive_url: String,
    /// The archive's file name (`.zip` or `.tar.zst`), as `install --from` finds it.
    pub archive_name: String,
}

impl Offer {
    /// The file stem every asset of this package shares.
    pub fn stem(&self) -> String {
        format!("{}-{}-{}-{}", self.track.as_str(), self.build, this_platform(), this_arch())
    }
}

/// The list's address: GENIE_LAUNCHER_FEED, else Genie's releases.
pub fn feed_url() -> String {
    std::env::var("GENIE_LAUNCHER_FEED").ok().filter(|u| !u.trim().is_empty()).unwrap_or_else(|| DEFAULT_FEED.to_string())
}

/// https anywhere; plain http only to this machine (a local feed). Anything else is never fetched.
pub fn url_allowed(url: &str) -> bool {
    if url.starts_with("https://") {
        return true;
    }
    let Some(rest) = url.strip_prefix("http://") else { return false };
    let host = rest.split(['/', '?']).next().unwrap_or("");
    let host = host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host);
    matches!(host, "127.0.0.1" | "localhost" | "[::1]")
}

/// Every release of `track` in a REST list (newest first, as GitHub lists them) whose assets hold this machine's
/// package: drafts never, prereleases only on `dev`. A release of another track, or one missing an asset, is skipped.
pub fn offers(list: &Value, track: Track, channel: &str) -> Vec<Offer> {
    let prefix = format!("{}-v", track.as_str());
    let mut out = Vec::new();
    for r in list.as_array().map(Vec::as_slice).unwrap_or(&[]) {
        if r["draft"].as_bool() != Some(false) {
            continue;
        }
        let prerelease = r["prerelease"].as_bool().unwrap_or(true);
        if prerelease && channel != "dev" {
            continue;
        }
        let Some(build) = r["tag_name"].as_str().and_then(|t| t.strip_prefix(&prefix)) else { continue };
        if build.contains('+') || crate::version::parse_track_build(build).is_none() {
            continue;
        }
        let stem = format!("{}-{build}-{}-{}", track.as_str(), this_platform(), this_arch());
        let url_of = |name: &str| -> Option<String> {
            r["assets"].as_array()?.iter().find(|a| a["name"] == name).and_then(|a| a["browser_download_url"].as_str()).map(str::to_string)
        };
        let (Some(manifest_url), Some(signature_url)) = (url_of(&format!("{stem}.manifest.json")), url_of(&format!("{stem}.manifest.json.sig"))) else { continue };
        let Some((archive_name, archive_url)) = [".zip", ".tar.zst"].iter().find_map(|ext| url_of(&format!("{stem}{ext}")).map(|u| (format!("{stem}{ext}"), u))) else { continue };
        out.push(Offer {
            track,
            build: build.to_string(),
            prerelease,
            notes: r["body"].as_str().unwrap_or("").to_string(),
            manifest_url,
            signature_url,
            archive_url,
            archive_name,
        });
    }
    out
}

/// The newest offer of `track` on `channel`, newer than `current` (any, with no current).
pub fn newest(list: &Value, track: Track, channel: &str, current: Option<&str>) -> Option<Offer> {
    offers(list, track, channel)
        .into_iter()
        .filter(|o| current.map_or(true, |c| crate::version::compare_track_builds(&o.build, c) == std::cmp::Ordering::Greater))
        .max_by(|a, b| crate::version::compare_track_builds(&a.build, &b.build))
}

/// The release of `track` at exactly `build` (a host's client), on `channel`.
pub fn exact(list: &Value, track: Track, channel: &str, build: &str) -> Option<Offer> {
    offers(list, track, channel).into_iter().find(|o| o.build == build)
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .timeout_read(Duration::from_secs(60))
        .redirects(5)
        .user_agent(&format!("genie-launcher/{}", crate::LAUNCHER_BUILD))
        .build()
}

fn cache_file(roots: &Roots) -> std::path::PathBuf {
    roots.data.join("launcher").join("feed.json")
}

/// The release list, read with the ETag of the last answer: a 304 answers from the kept copy.
pub fn fetch_list(roots: &Roots) -> Result<Value, String> {
    let url = feed_url();
    if !url_allowed(&url) {
        return Err(format!("Genie reads updates over https only, not from {url}"));
    }
    let cached: Option<Value> = std::fs::read_to_string(cache_file(roots)).ok().and_then(|t| serde_json::from_str(&t).ok()).filter(|c: &Value| c["url"] == url.as_str());
    let mut request = agent().get(&url).set("Accept", "application/vnd.github+json").set("X-GitHub-Api-Version", "2022-11-28");
    if let Some(etag) = cached.as_ref().and_then(|c| c["etag"].as_str()) {
        request = request.set("If-None-Match", etag);
    }
    match request.call() {
        Ok(resp) if resp.status() == 304 => cached.map(|c| c["body"].clone()).ok_or_else(|| "the feed said nothing changed, and no copy is kept".to_string()),
        Ok(resp) => {
            let etag = resp.header("ETag").map(str::to_string);
            let mut text = String::new();
            resp.into_reader().take(MAX_LIST).read_to_string(&mut text).map_err(|e| format!("the feed could not be read: {e}"))?;
            let body: Value = serde_json::from_str(&text).map_err(|e| format!("the feed is not a release list ({e})"))?;
            if !body.is_array() {
                return Err("the feed is not a release list".to_string());
            }
            if let Some(etag) = etag {
                let file = cache_file(roots);
                if let Some(dir) = file.parent() {
                    let _ = std::fs::create_dir_all(dir);
                }
                let _ = std::fs::write(&file, json!({"url": url, "etag": etag, "body": body}).to_string());
            }
            Ok(body)
        }
        Err(ureq::Error::Status(304, _)) => cached.map(|c| c["body"].clone()).ok_or_else(|| "the feed said nothing changed, and no copy is kept".to_string()),
        Err(ureq::Error::Status(code, _)) => Err(format!("the feed answered {code}")),
        Err(e) => Err(format!("the feed could not be reached ({e})")),
    }
}

/// A small file (a manifest, a signature), whole, in memory.
pub fn fetch_small(url: &str) -> Result<Vec<u8>, String> {
    if !url_allowed(url) {
        return Err(format!("Genie downloads over https only, not from {url}"));
    }
    let resp = agent().get(url).call().map_err(|e| format!("{url} could not be downloaded ({e})"))?;
    let mut bytes = Vec::new();
    resp.into_reader().take(1 << 20).read_to_end(&mut bytes).map_err(|e| format!("{url} could not be read: {e}"))?;
    Ok(bytes)
}

/// `url` downloaded to `to`: written to `<to>.partial` and renamed when whole, so a file at `to` is a whole download.
pub fn download(url: &str, to: &Path) -> Result<(), String> {
    if !url_allowed(url) {
        return Err(format!("Genie downloads over https only, not from {url}"));
    }
    let partial = to.with_file_name(format!("{}.partial", to.file_name().and_then(|n| n.to_str()).unwrap_or("download")));
    if let Some(dir) = to.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{} could not be made: {e}", dir.display()))?;
    }
    let result = (|| {
        let resp = agent().get(url).call().map_err(|e| format!("{url} could not be downloaded ({e})"))?;
        let mut out = std::fs::File::create(&partial).map_err(|e| format!("{} could not be written: {e}", partial.display()))?;
        let copied = std::io::copy(&mut resp.into_reader().take(MAX_DOWNLOAD + 1), &mut out).map_err(|e| format!("{url} could not be downloaded whole: {e}"))?;
        if copied > MAX_DOWNLOAD {
            return Err(format!("{url} is larger than any Genie package"));
        }
        out.sync_all().map_err(|e| e.to_string())?;
        drop(out);
        std::fs::rename(&partial, to).map_err(|e| format!("{} could not be put in place: {e}", to.display()))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&partial);
    }
    result
}

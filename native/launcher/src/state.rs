//! `state.json`: per track `{current, previous, channel}`, and the install profile. Written to a temporary file in the
//! same folder and renamed over the old one, so a reader sees the old file or the new one, never a torn one.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;

pub const FORMAT: u32 = 1;

/// `host.current` for a host the launcher adopted but did not start: the single-app install's, at the bridge (L9).
pub const ADOPTED: &str = "adopted";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrackState {
    pub current: Option<String>,
    pub previous: Option<String>,
    pub channel: String,
    /// L6: the client build was just applied by an update and has not yet come up (`updates::watch_client`).
    #[serde(default, skip_serializing_if = "is_false")]
    pub trial: bool,
    /// L6: how many starts of the build on trial ended before it came up, in a row.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub quick_exits: u32,
}

fn is_false(b: &bool) -> bool {
    !*b
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct State {
    pub format: u32,
    pub profile: Option<String>,
    pub tracks: BTreeMap<String, TrackState>,
}

impl State {
    pub fn track(&self, track: &str) -> Option<&TrackState> {
        self.tracks.get(track)
    }
    /// `current` becomes `build`, and the old current becomes `previous`.
    pub fn point(&mut self, track: &str, build: &str, channel: &str) {
        self.format = FORMAT;
        let t = self.tracks.entry(track.to_string()).or_default();
        if t.current.as_deref() != Some(build) {
            t.previous = t.current.take();
            t.trial = false;
            t.quick_exits = 0;
        }
        t.current = Some(build.to_string());
        t.channel = channel.to_string();
    }
}

/// The state, or the empty state when there is no file yet. A file that is not a state refuses.
pub fn read(path: &Path) -> Result<State, String> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("{} is not Genie's state ({e})", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(State { format: FORMAT, ..State::default() }),
        Err(e) => Err(format!("{} could not be read: {e}", path.display())),
    }
}

pub fn write_atomic(path: &Path, state: &State) -> std::io::Result<()> {
    let dir = path.parent().ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "no folder"))?;
    std::fs::create_dir_all(dir)?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("state.json");
    let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    let bytes = serde_json::to_vec_pretty(state).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let result = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(&bytes)?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

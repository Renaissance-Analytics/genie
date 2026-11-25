//! `state.json`: per track `{current, previous, channel}`, and the install profile. Written to a temporary file in the
//! same folder and renamed over the old one, so a reader sees the old file or the new one, never a torn one.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrackState {
    pub current: Option<String>,
    pub previous: Option<String>,
    pub channel: String,
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
        let _ = (track, build, channel);
        todo!("L2")
    }
}

/// The state, or the empty state when there is no file yet. A file that is not a state refuses.
pub fn read(path: &Path) -> Result<State, String> {
    let _ = path;
    todo!("L2")
}

pub fn write_atomic(path: &Path, state: &State) -> std::io::Result<()> {
    let _ = (path, state);
    todo!("L2")
}

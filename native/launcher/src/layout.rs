//! THE INSTALL LAYOUT (the spec's table).
//!
//! | | Windows | Linux |
//! |---|---|---|
//! | code root | `%LOCALAPPDATA%\Genie\` | `$XDG_DATA_HOME/genie` (`~/.local/share/genie`) |
//! | a build | `<code root>\<track>\<build>\` | the same |
//! | pointers | `<code root>\state.json` | the same |
//! | data root | `~/.genie` (`GENIE_HOME`), unchanged | the same |
//!
//! `GENIE_CODE_ROOT` names another code root (a test, a CI bundle), absolute only. Every program the launcher starts is
//! a `Program`, and a `Program` is made here and nowhere else: always an absolute path inside a verified build folder of
//! the code root, with that folder as its working folder. Never a workspace, never `PATH`.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Track {
    Client,
    Host,
    Launcher,
}

impl Track {
    pub const ALL: [Track; 3] = [Track::Client, Track::Host, Track::Launcher];
    pub fn as_str(self) -> &'static str {
        match self {
            Track::Client => "client",
            Track::Host => "host",
            Track::Launcher => "launcher",
        }
    }
    pub fn parse(text: &str) -> Option<Track> {
        Track::ALL.into_iter().find(|t| t.as_str() == text)
    }
}

/// The host's program and its entry inside a host build (P6-1's copy layout, made at build time by L3).
pub fn host_executable_name() -> &'static str {
    if cfg!(windows) { "genie-host.exe" } else { "genie-host" }
}
pub const HOST_ENTRY: &str = "app/dist/main/host.js";
/// The client's program inside a client build: never `Genie`, which names the launcher (the installer ends by name).
pub fn client_executable_name() -> &'static str {
    if cfg!(windows) { "genie-client.exe" } else { "genie-client" }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Roots {
    pub code: PathBuf,
    pub data: PathBuf,
}

/// A program the launcher may start: an absolute path inside a build folder, and that folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Program {
    path: PathBuf,
    folder: PathBuf,
}

impl Program {
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn folder(&self) -> &Path {
        &self.folder
    }
}

impl Roots {
    /// From the environment: GENIE_CODE_ROOT and GENIE_HOME when set (absolute), else this OS's defaults.
    pub fn from_env() -> Result<Roots, String> {
        todo!("L2")
    }
    pub fn track_dir(&self, track: Track) -> PathBuf {
        let _ = track;
        todo!("L2")
    }
    /// `None` when `build` is not a track build (a folder name is never taken from anything else).
    pub fn build_dir(&self, track: Track, build: &str) -> Option<PathBuf> {
        let _ = (track, build);
        todo!("L2")
    }
    pub fn state_file(&self) -> PathBuf {
        todo!("L2")
    }
    pub fn runtime_dir(&self) -> PathBuf {
        todo!("L2")
    }
    pub fn logs_dir(&self) -> PathBuf {
        todo!("L2")
    }
    pub fn host_program(&self, build: &str) -> Option<Program> {
        let _ = build;
        todo!("L2")
    }
    pub fn client_program(&self, build: &str) -> Option<Program> {
        let _ = build;
        todo!("L2")
    }
}

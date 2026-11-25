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

fn absolute_env(name: &str) -> Result<Option<PathBuf>, String> {
    match std::env::var_os(name) {
        Some(v) if !v.is_empty() => {
            let p = PathBuf::from(v);
            if p.is_absolute() { Ok(Some(p)) } else { Err(format!("{name} must be an absolute path ({})", p.display())) }
        }
        _ => Ok(None),
    }
}

fn home() -> Result<PathBuf, String> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    absolute_env(var)?.ok_or_else(|| format!("{var} is not set: no home folder"))
}

impl Roots {
    /// From the environment: GENIE_CODE_ROOT and GENIE_HOME when set (absolute), else this OS's defaults.
    pub fn from_env() -> Result<Roots, String> {
        let code = match absolute_env("GENIE_CODE_ROOT")? {
            Some(p) => p,
            None if cfg!(windows) => absolute_env("LOCALAPPDATA")?.ok_or("LOCALAPPDATA is not set")?.join("Genie"),
            None => match absolute_env("XDG_DATA_HOME")? {
                Some(x) => x.join("genie"),
                None => home()?.join(".local").join("share").join("genie"),
            },
        };
        let data = match absolute_env("GENIE_HOME")? {
            Some(p) => p,
            None => home()?.join(".genie"),
        };
        Ok(Roots { code, data })
    }
    pub fn track_dir(&self, track: Track) -> PathBuf {
        self.code.join(track.as_str())
    }
    /// `None` when `build` is not a track build (a folder name is never taken from anything else).
    pub fn build_dir(&self, track: Track, build: &str) -> Option<PathBuf> {
        let plain = !build.contains('+') && build.trim() == build;
        if plain && crate::version::parse_track_build(build).is_some() { Some(self.track_dir(track).join(build)) } else { None }
    }
    pub fn state_file(&self) -> PathBuf {
        self.code.join("state.json")
    }
    pub fn runtime_dir(&self) -> PathBuf {
        self.data.join("runtime")
    }
    pub fn logs_dir(&self) -> PathBuf {
        self.data.join("logs")
    }
    pub fn host_program(&self, build: &str) -> Option<Program> {
        let folder = self.build_dir(Track::Host, build)?;
        Some(Program { path: folder.join(host_executable_name()), folder })
    }
    pub fn client_program(&self, build: &str) -> Option<Program> {
        let folder = self.build_dir(Track::Client, build)?;
        Some(Program { path: folder.join(client_executable_name()), folder })
    }
}

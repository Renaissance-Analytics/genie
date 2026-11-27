//! THE LAUNCHER (Tynn #1058, slice L2). One process per user that installs, verifies, starts and stops Genie's programs.
//! The spec is the envelope's `.ai/plans/genie-2-host-split-2026-10-31.md`, "Launcher build spec".
//!
//! - `version`, `negotiate`: track builds and the protocol's negotiation, held to `test/fixtures/protocol-negotiation.json`
//!   with the TypeScript side (`src/core/protocol-version.ts`), so the two languages cannot drift.
//! - `manifest`, `keys`: the Ed25519-signed track manifest (`contracts/track-manifest.schema.json`).
//! - `layout`, `state`, `folder`, `install`, `archive`: the install layout per OS, `state.json`, verify-before-run and
//!   `install --from`.
//! - `secure`: the code root is the user's only.
//! - `spawn`: the ONLY place a program is started, and only a `layout::Program` (a path inside the code root).
//! - `components`: the registry of what the launcher starts (the host, the client, the browser; GApps later).
//! - `local`, `control`, `host`: the owner-only control wire, and starting and stopping the host.
//! - `logon`: the logon entry the launcher writes, and what its run does (`logonEntry`'s table, held with the TypeScript).
//! - `ui`: the setup window (direction C) in the platform webview, from assets bundled in `ui/`.
//! - `win`: genie-launch.exe's three modes (`detach`, `job`, `pipe-owner-only`), folded in (Windows).

pub mod archive;
pub mod argquote;
pub mod components;
pub mod control;
#[cfg(unix)]
pub mod desktop;
pub mod folder;
pub mod host;
pub mod install;
pub mod keys;
pub mod layout;
pub mod local;
pub mod logon;
pub mod manifest;
pub mod negotiate;
pub mod secure;
pub mod spawn;
pub mod state;
pub mod uninstall;
pub mod version;
#[cfg(feature = "ui")]
pub mod ui;
#[cfg(windows)]
pub mod win;

/// The launcher's own track build, stamped from the release tag (`GENIE_TRACK_BUILD` at build time). A build with none
/// is a development build, which no package's `minLauncher` admits.
pub const LAUNCHER_BUILD: &str = match option_env!("GENIE_TRACK_BUILD") {
    Some(b) => b,
    None => "dev",
};

/// The control wire's schema (track `launcher`): the date its frames last changed.
pub const LAUNCHER_SCHEMA: &str = "2026.11.25";

/// The engine protocol genie-host speaks (`src/core/engine-protocol.ts` `ENGINE_PROTOCOL`). A host of another protocol
/// is not adopted.
pub const ENGINE_PROTOCOL: u64 = 4;

/// Exit code for "could not start the child, or set the pipe's DACL" (genie-launch.c's LAUNCH_FAILED, kept).
pub const LAUNCH_FAILED: i32 = 125;

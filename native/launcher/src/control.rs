//! THE CONTROL WIRE. JSON lines, the engine protocol's frames (`hello` -> `welcome` | `refused`, `call` -> `result`), on
//! the named pipe `genie-launcher-<user SID>` (protected DACL: the user and SYSTEM) or `<data root>/runtime/launcher.sock`
//! (0600), with the token in `<data root>/runtime/launcher.token` (0600) and `launcher.json` `{pid, endpoint, build,
//! schema}` beside `host.json`. The hello carries an offer on track `launcher` and both sides `negotiate`.
//!
//! Methods (L2): `launcher.status`, `launcher.ensureHost`, `launcher.stopHost`, `launcher.openWindow {host}`,
//! `launcher.startBrowser`. `launcher.updates`, `.check`, `.apply` and `.channel` answer `unsupported` until L6.

use crate::layout::Roots;
use serde_json::Value;

pub const METHODS: [&str; 9] = [
    "launcher.status",
    "launcher.ensureHost",
    "launcher.stopHost",
    "launcher.openWindow",
    "launcher.startBrowser",
    "launcher.updates",
    "launcher.check",
    "launcher.apply",
    "launcher.channel",
];

pub struct Context {
    pub roots: Roots,
    pub token: String,
}

#[derive(Debug, Default)]
pub struct Connection {
    pub welcomed: bool,
    /// Set when the connection must close after these frames are sent.
    pub closing: bool,
}

/// The frames that answer one line.
pub fn handle_line(ctx: &Context, conn: &mut Connection, line: &str) -> Vec<Value> {
    let _ = (ctx, conn, line);
    todo!("L2")
}

/// This user's endpoint.
pub fn endpoint(roots: &Roots) -> Result<String, String> {
    let _ = roots;
    todo!("L2")
}

/// Run the launcher: one per user (a second answers that one is running), the token and `launcher.json` written,
/// connections served until the process ends.
pub fn serve(roots: Roots) -> Result<(), String> {
    let _ = roots;
    todo!("L2")
}

/// What is installed and running (`genie status --json`, `launcher.status`): the build, the roots, the profile, each
/// track's pointers and whether its current folder verifies, the host and the launcher.
pub fn status(roots: &Roots) -> Value {
    let _ = roots;
    todo!("L2")
}

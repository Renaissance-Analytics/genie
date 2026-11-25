//! STARTING AND STOPPING THE HOST. `ensure_host`: adopt a live host that answers a `hello` on the engine protocol the
//! launcher speaks, else start `host.current` from its verified folder, detached, inheriting only its log, and wait for
//! it to write `host.json` and answer. `stop_host`: the graceful stop (`engine.shutdown`), then wait for its pid.

use crate::layout::Roots;
use ed25519_dalek::VerifyingKey;
use serde_json::Value;
use std::time::Duration;

/// How long a new host has to write host.json and answer a hello (the spec's rollback bound, 60 s).
pub const HOST_READY: Duration = Duration::from_secs(60);
/// How long a host has to go after `engine.shutdown` (INSTALL_WAIT_MS's order).
pub const HOST_GONE: Duration = Duration::from_secs(120);

/// `<data root>/runtime/host.json`, as genie-host writes it (`src/core/engine-protocol.ts` `HostRecord`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostRecord {
    pub pid: u32,
    pub endpoint: String,
    pub protocol: u64,
    pub build: String,
}

pub fn parse_record(text: &str) -> Option<HostRecord> {
    let _ = text;
    todo!("L2")
}

pub fn read_record(roots: &Roots) -> Option<HostRecord> {
    let _ = roots;
    todo!("L2")
}

/// `hello` with the host's token; its `welcome`, or why not.
pub fn hello(record: &HostRecord, token: &str, timeout: Duration) -> Result<Value, String> {
    let _ = (record, token, timeout);
    todo!("L2")
}

/// `{how: adopted|started, pid, build}`, or the person's words.
pub fn ensure_host(roots: &Roots, keys: &[VerifyingKey]) -> Result<Value, String> {
    let _ = (roots, keys);
    todo!("L2")
}

/// `{stopped: true, pid}` once the host has gone; `{stopped: false}` when none was running.
pub fn stop_host(roots: &Roots) -> Result<Value, String> {
    let _ = roots;
    todo!("L2")
}

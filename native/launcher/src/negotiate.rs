//! NEGOTIATION (`src/core/protocol-version.ts` `negotiate`, `windowFloor`, `offerOf`), the same answers in Rust. Pure.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_CAPABILITIES: usize = 256;
const MAX_CAPABILITY_LENGTH: usize = 128;
/// The wire as it was before Tynn #894: a peer that says no schema.
pub const LEGACY_SCHEMA: &str = "2026.11.01";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Offer {
    pub track: Option<String>,
    pub build: Option<String>,
    pub schema: String,
    #[serde(rename = "minSchema")]
    pub min_schema: String,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Negotiation {
    /// The older schema, and the shared capabilities at the lower level, sorted.
    Agreed { schema: String, capabilities: Vec<String> },
    /// `peer_too_old`: the other side is older than my window; otherwise mine is older than its window.
    Refused { peer_too_old: bool, reason: String },
}

/// The fixed window's floor for `schema`: SUPPORT_WINDOW_DAYS back, or the security floor when that is newer.
pub fn window_floor(schema: &str, security_floor: &str) -> String {
    let _ = (schema, security_floor);
    todo!("L2")
}

/// `name@level`, or `None`.
pub fn parse_capability(text: &str) -> Option<(String, u32)> {
    let _ = text;
    todo!("L2")
}

/// Inside both windows: the older schema and the shared capabilities; otherwise why. Symmetric.
pub fn negotiate(mine: &Offer, theirs: &Offer) -> Negotiation {
    let _ = (mine, theirs);
    todo!("L2")
}

/// An offer read from a `hello` or a `welcome`, defensively (offerOf). Never fails.
pub fn offer_of(frame: &Value) -> Offer {
    let _ = frame;
    todo!("L2")
}

/// The launcher's offer on its control wire: track `launcher`, its schema, the window's floor, `launcher@1`.
pub fn launcher_offer() -> Offer {
    todo!("L2")
}

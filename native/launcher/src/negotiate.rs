//! NEGOTIATION (`src/core/protocol-version.ts` `negotiate`, `windowFloor`, `offerOf`), the same answers in Rust. Pure.

use crate::version::{is_schema, schema_minus_days, SECURITY_FLOOR_SCHEMA, SUPPORT_WINDOW_DAYS};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub const MAX_CAPABILITIES: usize = 256;
const MAX_CAPABILITY_LENGTH: usize = 128;
/// The wire as it was before Tynn #894: a peer that says no schema.
pub const LEGACY_SCHEMA: &str = "2026.11.01";
pub const TRACKS: [&str; 4] = ["client", "host", "launcher", "browser"];
/// What the control wire offers: level 1 of the launcher's methods.
pub const CAP_LAUNCHER: &str = "launcher@1";

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
    let window = schema_minus_days(schema, SUPPORT_WINDOW_DAYS).unwrap_or_else(|| schema.to_string());
    if security_floor > window.as_str() { security_floor.to_string() } else { window }
}

/// `name@level`, or `None`.
pub fn parse_capability(text: &str) -> Option<(String, u32)> {
    if text.len() > MAX_CAPABILITY_LENGTH {
        return None;
    }
    let (name, level) = text.split_once('@')?;
    let mut chars = name.chars();
    let first = chars.next()?;
    if !first.is_ascii_alphanumeric() || !chars.all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-') {
        return None;
    }
    let lb = level.as_bytes();
    if lb.is_empty() || lb.len() > 6 || !lb.iter().all(u8::is_ascii_digit) || lb[0] == b'0' {
        return None;
    }
    Some((name.to_string(), level.parse().ok()?))
}

fn levels(offer: &Offer) -> Vec<(String, u32)> {
    // In the order first said (as a JS Map keeps it), each at its highest level.
    let mut out: Vec<(String, u32)> = Vec::new();
    for c in &offer.capabilities {
        if let Some((name, level)) = parse_capability(c) {
            match out.iter_mut().find(|(n, _)| *n == name) {
                Some(entry) => entry.1 = entry.1.max(level),
                None => out.push((name, level)),
            }
        }
    }
    out
}

/// Inside both windows: the older schema and the shared capabilities; otherwise why. Symmetric.
pub fn negotiate(mine: &Offer, theirs: &Offer) -> Negotiation {
    if theirs.schema < mine.min_schema {
        return Negotiation::Refused {
            peer_too_old: true,
            reason: format!("the other side speaks schema {}, older than this side's support window (from {}). Update it.", theirs.schema, mine.min_schema),
        };
    }
    if mine.schema < theirs.min_schema {
        return Negotiation::Refused {
            peer_too_old: false,
            reason: format!("this side speaks schema {}, older than the other side's support window (from {}). Update this side.", mine.schema, theirs.min_schema),
        };
    }
    let b: BTreeMap<String, u32> = levels(theirs).into_iter().collect();
    let mut both: Vec<String> = levels(mine).into_iter().filter_map(|(name, level)| b.get(&name).map(|other| format!("{}@{}", name, level.min(*other)))).collect();
    both.sort();
    let schema = if mine.schema < theirs.schema { mine.schema.clone() } else { theirs.schema.clone() };
    Negotiation::Agreed { schema, capabilities: both }
}

/// An offer read from a `hello` or a `welcome`, defensively (offerOf). Never fails.
pub fn offer_of(frame: &Value) -> Offer {
    let track = frame.get("track").and_then(Value::as_str).filter(|t| TRACKS.contains(t)).map(str::to_string);
    let build = frame.get("build").and_then(Value::as_str).filter(|b| !b.trim().is_empty()).map(str::to_string);
    let schema = frame.get("schema").and_then(Value::as_str).filter(|s| is_schema(s) && *s != SECURITY_FLOOR_SCHEMA);
    let Some(schema) = schema else {
        return Offer { track, build, schema: LEGACY_SCHEMA.to_string(), min_schema: SECURITY_FLOOR_SCHEMA.to_string(), capabilities: Vec::new() };
    };
    let min_schema = match frame.get("minSchema").and_then(Value::as_str).filter(|m| is_schema(m)) {
        Some(m) if m > schema => schema.to_string(),
        Some(m) => m.to_string(),
        None => SECURITY_FLOOR_SCHEMA.to_string(),
    };
    let mut capabilities = Vec::new();
    if let Some(list) = frame.get("capabilities").and_then(Value::as_array) {
        for c in list {
            if capabilities.len() >= MAX_CAPABILITIES {
                break;
            }
            if let Some(s) = c.as_str() {
                if parse_capability(s).is_some() {
                    capabilities.push(s.to_string());
                }
            }
        }
    }
    Offer { track, build, schema: schema.to_string(), min_schema, capabilities }
}

/// The launcher's offer on its control wire: track `launcher`, its schema, the window's floor, `launcher@1`.
pub fn launcher_offer() -> Offer {
    Offer {
        track: Some("launcher".to_string()),
        build: Some(crate::LAUNCHER_BUILD.to_string()),
        schema: crate::LAUNCHER_SCHEMA.to_string(),
        min_schema: window_floor(crate::LAUNCHER_SCHEMA, SECURITY_FLOOR_SCHEMA),
        capabilities: vec![CAP_LAUNCHER.to_string()],
    }
}

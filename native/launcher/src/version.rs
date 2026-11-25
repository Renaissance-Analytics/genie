//! TRACK BUILDS AND SCHEMAS (`src/core/protocol-version.ts`, `src/core/track-manifest.ts` `semverOf`). Pure.
//! A track build is `<schema>-<release>[.<hotfix>]`, the schema a real date `YYYY.MM.DD`; a `+meta` suffix is dropped.

use std::cmp::Ordering;

/// The fixed support window, in days of schema.
pub const SUPPORT_WINDOW_DAYS: i64 = 30;
/// No schema older than this is accepted; the epoch accepts everything the window does.
pub const SECURITY_FLOOR_SCHEMA: &str = "0000.01.01";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrackBuild {
    pub schema: String,
    pub release: u32,
    pub hotfix: u32,
}

/// A real calendar date written `YYYY.MM.DD` (year 2000 or later), or the epoch `0000.01.01`.
pub fn is_schema(text: &str) -> bool {
    let _ = text;
    todo!("L2")
}

/// `2026.11.18-1` → schema, release 1, hotfix 0; `-1.1` is hotfix 1; `None` for anything else.
pub fn parse_track_build(build: &str) -> Option<TrackBuild> {
    let _ = build;
    todo!("L2")
}

/// Schema, then release, then hotfix. A build that is not a track build sorts before every track build.
pub fn compare_track_builds(a: &str, b: &str) -> Ordering {
    let _ = (a, b);
    todo!("L2")
}

/// `schema` minus `days`, as a schema. `None` when `schema` is not one.
pub fn schema_minus_days(schema: &str, days: i64) -> Option<String> {
    let _ = (schema, days);
    todo!("L2")
}

/// The semver form electron-builder needs: no leading zeros (`2026.01.05-1` → `2026.1.5-1`).
pub fn semver_of(build: &str) -> Option<String> {
    let _ = build;
    todo!("L2")
}

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

/// `YYYY.MM.DD` with ASCII digits: (year, month, day), not yet checked as a date.
fn schema_parts(text: &str) -> Option<(i64, u32, u32)> {
    let b = text.as_bytes();
    if b.len() != 10 || b[4] != b'.' || b[7] != b'.' {
        return None;
    }
    let digits = |r: std::ops::Range<usize>| -> Option<u32> {
        let s = &text[r];
        if s.bytes().all(|c| c.is_ascii_digit()) { s.parse().ok() } else { None }
    };
    Some((digits(0..4)? as i64, digits(5..7)?, digits(8..10)?))
}

fn days_in_month(y: i64, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        2 => 28,
        _ => 0,
    }
}

/// A real calendar date written `YYYY.MM.DD` (year 2000 or later), or the epoch `0000.01.01`.
pub fn is_schema(text: &str) -> bool {
    if text == SECURITY_FLOOR_SCHEMA {
        return true;
    }
    match schema_parts(text) {
        Some((y, m, d)) => y >= 2000 && (1..=12).contains(&m) && d >= 1 && d <= days_in_month(y, m),
        None => false,
    }
}

/// `2026.11.18-1` → schema, release 1, hotfix 0; `-1.1` is hotfix 1; `None` for anything else.
pub fn parse_track_build(build: &str) -> Option<TrackBuild> {
    let core = build.split('+').next().unwrap_or("").trim();
    let (schema, rest) = core.split_once('-')?;
    if !is_schema(schema) || schema_parts(schema).is_none() {
        return None;
    }
    let (release, hotfix) = match rest.split_once('.') {
        Some((r, h)) => (r, Some(h)),
        None => (rest, None),
    };
    let digits = |s: &str, max: usize| !s.is_empty() && s.len() <= max && s.bytes().all(|c| c.is_ascii_digit());
    if !digits(release, 6) || release.starts_with('0') {
        return None;
    }
    let hotfix = match hotfix {
        Some(h) if digits(h, 6) => h.parse().ok()?,
        Some(_) => return None,
        None => 0,
    };
    Some(TrackBuild { schema: schema.to_string(), release: release.parse().ok()?, hotfix })
}

/// Schema, then release, then hotfix. A build that is not a track build sorts before every track build.
pub fn compare_track_builds(a: &str, b: &str) -> Ordering {
    match (parse_track_build(a), parse_track_build(b)) {
        (None, None) => Ordering::Equal,
        (Some(_), None) => Ordering::Greater,
        (None, Some(_)) => Ordering::Less,
        (Some(x), Some(y)) => x.schema.cmp(&y.schema).then(x.release.cmp(&y.release)).then(x.hotfix.cmp(&y.hotfix)),
    }
}

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's days_from_civil).
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let m = m as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = (if z >= 0 { z } else { z - 146096 }) / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `schema` minus `days`, as a schema. `None` when `schema` is not one.
pub fn schema_minus_days(schema: &str, days: i64) -> Option<String> {
    let (y, m, d) = schema_parts(schema)?;
    let (y, m, d) = civil_from_days(days_from_civil(y, m, d) - days);
    Some(format!("{:04}.{:02}.{:02}", y, m, d))
}

/// The semver form electron-builder needs: no leading zeros (`2026.01.05-1` → `2026.1.5-1`).
pub fn semver_of(build: &str) -> Option<String> {
    let p = parse_track_build(build)?;
    let (y, m, d) = schema_parts(&p.schema)?;
    let hotfix = if p.hotfix > 0 { format!(".{}", p.hotfix) } else { String::new() };
    Some(format!("{}.{}.{}-{}{}", y, m, d, p.release, hotfix))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dates_round_trip_across_years_and_leap_days() {
        assert_eq!(schema_minus_days("2026.03.01", 1).as_deref(), Some("2026.02.28"));
        assert_eq!(schema_minus_days("2024.03.01", 1).as_deref(), Some("2024.02.29"));
        assert_eq!(schema_minus_days("2026.01.15", 30).as_deref(), Some("2025.12.16"));
        assert!(is_schema("2024.02.29") && !is_schema("2026.02.29") && !is_schema("1999.12.31"));
    }
}

//! THE SHARED TABLE (test/fixtures/protocol-negotiation.json, L1): the TypeScript side reads it in
//! test/protocol-negotiation-table.test.ts, this reads the same file, so `negotiate`, `windowFloor`, the track builds and
//! their order cannot drift between the two languages.

use genie_launcher::negotiate::{negotiate, window_floor, Negotiation, Offer};
use genie_launcher::version::{compare_track_builds, parse_track_build, semver_of, SECURITY_FLOOR_SCHEMA, SUPPORT_WINDOW_DAYS};
use serde_json::Value;
use std::cmp::Ordering;
use std::path::PathBuf;

fn table() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/protocol-negotiation.json");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("the shared table {} could not be read: {e}", path.display()));
    serde_json::from_str(&text).expect("the shared table is JSON")
}

fn offer(v: &Value) -> Offer {
    serde_json::from_value(v.clone()).expect("an offer in the table")
}

#[test]
fn the_table_is_format_1_with_this_window_and_floor() {
    let t = table();
    assert_eq!(t["format"], 1);
    assert_eq!(t["supportWindowDays"].as_i64(), Some(SUPPORT_WINDOW_DAYS));
    assert_eq!(t["securityFloor"].as_str(), Some(SECURITY_FLOOR_SCHEMA));
}

#[test]
fn window_floor_gives_the_tables_floors() {
    let t = table();
    let rows = t["windowFloor"].as_array().expect("windowFloor rows");
    assert!(!rows.is_empty());
    for row in rows {
        let schema = row["schema"].as_str().unwrap();
        assert_eq!(window_floor(schema, SECURITY_FLOOR_SCHEMA), row["floor"].as_str().unwrap(), "windowFloor({schema})");
    }
}

#[test]
fn negotiate_gives_every_cases_answer() {
    let t = table();
    let cases = t["cases"].as_array().expect("cases");
    assert!(cases.len() >= 10);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let got = negotiate(&offer(&case["mine"]), &offer(&case["theirs"]));
        let answer = &case["answer"];
        if answer["ok"] == true {
            let schema = answer["negotiated"]["schema"].as_str().unwrap().to_string();
            let caps: Vec<String> = serde_json::from_value(answer["negotiated"]["capabilities"].clone()).unwrap();
            assert_eq!(got, Negotiation::Agreed { schema, capabilities: caps }, "{name}");
        } else {
            assert_eq!(answer["code"], "version", "{name}");
            match got {
                Negotiation::Refused { peer_too_old, reason } => {
                    assert_eq!(Some(peer_too_old), answer["peerTooOld"].as_bool(), "{name}");
                    assert!(!reason.is_empty(), "{name}: a refusal says why");
                }
                other => panic!("{name}: refused in the table, {other:?} here"),
            }
        }
    }
}

#[test]
fn track_builds_parse_and_take_their_semver_as_in_the_table() {
    let t = table();
    for row in t["trackBuilds"].as_array().expect("trackBuilds") {
        let build = row["build"].as_str().unwrap();
        let parsed = parse_track_build(build);
        if row["parsed"].is_null() {
            assert_eq!(parsed, None, "{build} is not a track build");
        } else {
            let p = parsed.unwrap_or_else(|| panic!("{build} is a track build"));
            assert_eq!(p.schema, row["parsed"]["schema"].as_str().unwrap(), "{build}");
            assert_eq!(p.release as u64, row["parsed"]["release"].as_u64().unwrap(), "{build}");
            assert_eq!(p.hotfix as u64, row["parsed"]["hotfix"].as_u64().unwrap(), "{build}");
        }
        assert_eq!(semver_of(build).as_deref(), row["semver"].as_str(), "semverOf({build})");
    }
}

#[test]
fn builds_order_as_in_the_table() {
    let t = table();
    for row in t["buildOrder"].as_array().expect("buildOrder") {
        let (a, b) = (row["a"].as_str().unwrap(), row["b"].as_str().unwrap());
        let want = match row["sign"].as_i64().unwrap() {
            n if n < 0 => Ordering::Less,
            0 => Ordering::Equal,
            _ => Ordering::Greater,
        };
        assert_eq!(compare_track_builds(a, b), want, "compare({a}, {b})");
    }
}

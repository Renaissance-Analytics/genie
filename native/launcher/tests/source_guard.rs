//! SOURCE GUARDS (the spec's Security section). The launcher starts programs only by absolute path inside its code root:
//! `Command::new` appears in src/spawn.rs alone and takes a `layout::Program`, which only src/layout.rs makes; a raw
//! CreateProcessW is only in spawn.rs and win.rs (genie-launch.exe's modes, whose program is the caller's absolute path);
//! no shell, no git, no PATH search. And the release build never turns on the test keys.

use std::path::{Path, PathBuf};

fn sources() -> Vec<(String, String)> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut out = Vec::new();
    for e in std::fs::read_dir(&dir).unwrap() {
        let p = e.unwrap().path();
        if p.extension().and_then(|x| x.to_str()) == Some("rs") {
            out.push((p.file_name().unwrap().to_str().unwrap().to_string(), strip_comments(&std::fs::read_to_string(&p).unwrap())));
        }
    }
    assert!(out.len() >= 10, "the sources were found");
    out
}

/// Code without its `//` comments (a comment may name what the code must not do).
fn strip_comments(text: &str) -> String {
    text.lines().map(|l| match l.find("//") { Some(i) if !l[..i].contains('"') => &l[..i], _ => l }).collect::<Vec<_>>().join("\n")
}

fn files_with(needle: &str) -> Vec<String> {
    sources().into_iter().filter(|(_, code)| code.contains(needle)).map(|(n, _)| n).collect()
}

#[test]
fn command_new_is_only_in_spawn_and_takes_a_program_path() {
    assert_eq!(files_with("Command::new"), vec!["spawn.rs".to_string()]);
    let (_, spawn) = sources().into_iter().find(|(n, _)| n == "spawn.rs").unwrap();
    for line in spawn.lines().filter(|l| l.contains("Command::new")) {
        assert!(line.contains("Command::new(program.path())"), "spawn.rs starts only a Program's path: {line}");
    }
}

#[test]
fn create_process_is_only_in_spawn_and_win() {
    let mut got = files_with("CreateProcessW(");
    got.sort();
    assert!(got.iter().all(|f| f == "spawn.rs" || f == "win.rs"), "{got:?}");
}

#[test]
fn a_program_is_made_only_by_the_layout() {
    let got = files_with("Program {");
    assert_eq!(got, vec!["layout.rs".to_string()], "only layout.rs builds a Program");
}

#[test]
fn no_shell_no_git_no_path_search() {
    for (name, code) in sources() {
        for bad in ["\"sh\"", "\"/bin/sh\"", "\"cmd.exe\"", "\"cmd\"", "\"powershell", "\"git\"", "\"bash\"", "SearchPathW", "which::"] {
            assert!(!code.contains(bad), "{name} names {bad}");
        }
    }
}

#[test]
fn every_start_sets_its_working_folder_from_the_program() {
    let (_, spawn) = sources().into_iter().find(|(n, _)| n == "spawn.rs").unwrap();
    assert!(spawn.contains(".current_dir(program.folder())"), "the child's working folder is its own build folder");
}

#[test]
fn the_release_build_never_has_the_test_keys() {
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/build-win-launcher.mjs");
    let text = std::fs::read_to_string(&script).unwrap();
    assert!(text.contains("cargo"), "the Windows build is cargo's");
    assert!(!text.contains("--features") && !text.contains("test-keys"), "no features in the release build");
    let (_, keys) = sources().into_iter().find(|(n, _)| n == "keys.rs").unwrap();
    assert!(keys.contains("#[cfg(feature = \"test-keys\")]"), "the test key is read only under the feature");
}

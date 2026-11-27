//! WHEN `genie uninstall` REFUSES (Tynn #1058 L4), as a pure rule: no folder is touched here, so a filesystem root can be
//! asked about safely. The code root may not be a filesystem root, the home folder or the data root, nor hold either.
use genie_launcher::uninstall::refusal;
use std::path::{Path, PathBuf};

fn root() -> PathBuf {
    if cfg!(windows) { PathBuf::from(r"C:\") } else { PathBuf::from("/") }
}
fn under(parts: &[&str]) -> PathBuf {
    parts.iter().fold(root(), |p, s| p.join(s))
}

#[test]
fn a_filesystem_root_is_refused() {
    let why = refusal(&root(), &under(&["u", ".genie"]), Some(&under(&["u"]))).expect("refused");
    assert!(why.contains("root of a drive or filesystem"), "{why}");
}

#[test]
fn the_home_folder_or_one_holding_it_is_refused() {
    let home = under(&["home", "a"]);
    assert!(refusal(&home, &under(&["x", ".genie"]), Some(&home)).expect("refused").contains("home folder"));
    assert!(refusal(&under(&["home"]), &under(&["x", ".genie"]), Some(&home)).expect("refused").contains("home folder"));
}

#[test]
fn the_data_root_or_one_holding_it_is_refused() {
    let data = under(&["home", "a", ".genie"]);
    assert!(refusal(&data, &data, Some(&under(&["elsewhere"]))).expect("refused").contains("data root"));
    assert!(refusal(&under(&["home", "a"]), &data, None).expect("refused").contains("data root"));
}

#[test]
fn control_a_code_root_of_its_own_is_allowed() {
    let home = under(&["home", "a"]);
    let code = home.join(".local").join("share").join("genie");
    assert_eq!(refusal(&code, &home.join(".genie"), Some(&home)), None);
    // A code root beside the data root, sharing a prefix of its name, is not inside it.
    assert_eq!(refusal(&under(&["home", "a", ".genie-code"]), &home.join(".genie"), Some(Path::new(&home))), None);
}

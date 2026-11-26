//! LINUX: THE LAUNCHER'S OWN PLACE AND THE DESKTOP ENTRY. Not yet written (the red step of tests/desktop.rs).

use crate::layout::Roots;

pub fn write_entries(_roots: &Roots, _launcher_build: &str) -> Result<(), String> {
    Err("the desktop entries are not written yet".to_string())
}

pub fn remove_entries(_roots: &Roots) {}

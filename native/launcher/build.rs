//! GENIE'S ICON IN GENIE.EXE (Tynn #1058 L9; the coordinator, 2026-11-27). Every Start-menu entry, desktop shortcut and
//! pinned taskbar item names Genie.exe, which since the bridge is this launcher: without an icon of its own each showed a
//! blank page (the migrated install, during-06-windows.png). The repository's build/icon.ico is compiled into a resource
//! (icon group 1, the one Explorer shows) by the Windows SDK's resource compiler and linked into the `genie` program.
//!
//! No crate: rc.exe is part of the Windows SDK that the MSVC linker this build already needs comes with. It is found as
//! RC_EXE names it, else the newest `Windows Kits\10\bin\<version>\<host arch>\rc.exe`. A Windows build that cannot find
//! it fails and says so: Genie.exe never ships without its icon.

use std::path::{Path, PathBuf};

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=RC_EXE");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let icon = manifest.join("..").join("..").join("build").join("icon.ico");
    let icon = icon.canonicalize().unwrap_or_else(|e| panic!("Genie's icon is not at {}: {e}", icon.display()));
    println!("cargo:rerun-if-changed={}", icon.display());
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
    let rc = out.join("genie.rc");
    let res = out.join("genie.res");
    // The .rc names the icon by its full path, its backslashes doubled (a C string), without the \\?\ prefix.
    let icon_text = icon.display().to_string();
    let icon_text = icon_text.strip_prefix(r"\\?\").unwrap_or(&icon_text).replace('\\', "\\\\");
    std::fs::write(&rc, format!("1 ICON \"{icon_text}\"\n")).expect("the .rc could be written");
    let compiler = rc_exe().unwrap_or_else(|| panic!("the Windows SDK's rc.exe was not found (set RC_EXE): Genie.exe is never built without its icon"));
    let status = std::process::Command::new(&compiler).arg("/nologo").arg("/fo").arg(&res).arg(&rc).status().unwrap_or_else(|e| panic!("{} could not run: {e}", compiler.display()));
    assert!(status.success(), "{} could not compile Genie's icon ({status})", compiler.display());
    println!("cargo:rustc-link-arg-bin=genie={}", res.display());
}

fn rc_exe() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("RC_EXE").map(PathBuf::from).filter(|p| p.is_file()) {
        return Some(p);
    }
    let arch = match std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("aarch64") => "arm64",
        _ => "x64",
    };
    let mut found: Vec<(Vec<u32>, PathBuf)> = Vec::new();
    for root in ["ProgramFiles(x86)", "ProgramFiles"].iter().filter_map(std::env::var_os) {
        let bin = Path::new(&root).join("Windows Kits").join("10").join("bin");
        let Ok(entries) = std::fs::read_dir(&bin) else { continue };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let version: Vec<u32> = name.split('.').map(|p| p.parse().unwrap_or(0)).collect();
            for host in [arch, "x64", "x86"] {
                let exe = e.path().join(host).join("rc.exe");
                if exe.is_file() {
                    found.push((version.clone(), exe));
                    break;
                }
            }
        }
    }
    found.sort();
    found.pop().map(|(_, p)| p)
}

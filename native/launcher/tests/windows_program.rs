//! GENIE.EXE AS A PERSON SEES IT (Tynn #1058 L9; the coordinator, 2026-11-27). The launcher is what every shortcut, the
//! logon entry and the installer start, so on Windows:
//!
//! - it is a WINDOWS-SUBSYSTEM program: started from a shortcut or at logon, no console window exists, ever (a console
//!   program gets one from Windows before its first line runs; run 1127-223352-5d8720 showed it behind the card);
//! - its command line still answers in a terminal: the CLI modes attach to the console of the program that started them
//!   (AttachConsole(ATTACH_PARENT_PROCESS)) and write there; started any other way they stay windowless;
//! - it carries Genie's icon (build/icon.ico), so the Start menu, the desktop shortcut and the taskbar show Genie, not a
//!   blank page (the migrated install's desktop shortcut was blank: during-06-windows.png).
#![cfg(windows)]

mod common;

use common::live::wait_for;
use common::*;
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use windows_sys::Win32::Foundation::FreeLibrary;
use windows_sys::Win32::System::LibraryLoader::{FindResourceW, LoadLibraryExW, LOAD_LIBRARY_AS_DATAFILE, LOAD_LIBRARY_AS_IMAGE_RESOURCE};
use windows_sys::Win32::UI::WindowsAndMessaging::RT_GROUP_ICON;

fn genie() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_BIN_EXE_genie"))
}

fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    s.encode_wide().chain(Some(0)).collect()
}

/// The PE optional header's Subsystem: 2 is WINDOWS_GUI, 3 is WINDOWS_CUI (a console program).
fn subsystem(exe: &std::path::Path) -> u16 {
    let b = std::fs::read(exe).unwrap();
    let pe = u32::from_le_bytes(b[0x3c..0x40].try_into().unwrap()) as usize;
    assert_eq!(&b[pe..pe + 4], b"PE\0\0", "a PE file");
    let opt = pe + 4 + 20;
    u16::from_le_bytes(b[opt + 68..opt + 70].try_into().unwrap())
}

#[test]
fn genie_exe_is_a_windows_program_so_no_console_window_is_ever_made_for_it() {
    assert_eq!(subsystem(&genie()), 2, "Genie.exe is a windows-subsystem program (2), not a console one (3)");
}

#[test]
fn genie_exe_carries_genies_icon() {
    let path = wide(genie().as_os_str());
    unsafe {
        let h = LoadLibraryExW(path.as_ptr(), std::ptr::null_mut(), LOAD_LIBRARY_AS_DATAFILE | LOAD_LIBRARY_AS_IMAGE_RESOURCE);
        assert!(!h.is_null(), "Genie.exe opens as a resource file");
        let icon = FindResourceW(h, 1 as _, RT_GROUP_ICON);
        FreeLibrary(h);
        assert!(!icon.is_null(), "Genie.exe has an icon group, id 1: the icon Explorer shows for it and its shortcuts");
    }
}

/// What the launcher says of its console (GENIE_LAUNCHER_CONSOLE_PROBE, a test build's only): `console=true|false`.
fn probe(dir: &std::path::Path) -> std::path::PathBuf {
    dir.join("console-probe.txt")
}

#[test]
fn started_as_the_logon_entry_starts_it_there_is_no_console() {
    let base = temp_dir("no-console");
    let r = roots(&base);
    // Shut down, start on logon off: the logon run decides that Genie stays down, and exits.
    let out = Command::new(genie())
        .arg("--logon")
        .env("GENIE_HOME", &r.data)
        .env("GENIE_CODE_ROOT", &r.code)
        .env("GENIE_LAUNCHER_CONSOLE_PROBE", probe(&base))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap();
    assert!(out.success());
    assert_eq!(std::fs::read_to_string(probe(&base)).unwrap().trim(), "console=false", "no console, not even a hidden one");
}

#[test]
fn run_from_a_terminal_its_answer_reaches_that_terminal() {
    use windows_sys::Win32::System::Console::{AttachConsole, FreeConsole, ReadConsoleOutputCharacterW, ATTACH_PARENT_PROCESS, COORD};
    use windows_sys::Win32::Storage::FileSystem::{CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING};
    use windows_sys::Win32::Foundation::{CloseHandle, GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE};
    let base = temp_dir("cli-console");
    // A terminal of its own (cmd in a new console), typing `genie version` with nothing redirected, then waiting a while.
    let line = format!("\"{}\" version & ping -n 12 127.0.0.1 > NUL", genie().display());
    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
    let mut cmd = Command::new(r"C:\Windows\System32\cmd.exe")
        .raw_arg(format!("/c \"{line}\""))
        .env("GENIE_LAUNCHER_CONSOLE_PROBE", probe(&base))
        .creation_flags(CREATE_NEW_CONSOLE)
        .spawn()
        .unwrap();
    wait_for("genie wrote its probe", 20, || probe(&base).exists());
    std::thread::sleep(std::time::Duration::from_millis(1500));
    // What that terminal shows, read from its screen buffer.
    let shown = unsafe {
        FreeConsole();
        let attached = AttachConsole(cmd.id()) != 0;
        let mut text = String::new();
        if attached {
            let conout = wide(std::ffi::OsStr::new("CONOUT$"));
            let h = CreateFileW(conout.as_ptr(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, std::ptr::null(), OPEN_EXISTING, 0, std::ptr::null_mut());
            if h != INVALID_HANDLE_VALUE {
                let mut buf = vec![0u16; 120 * 20];
                let mut read = 0u32;
                ReadConsoleOutputCharacterW(h, buf.as_mut_ptr(), buf.len() as u32, COORD { X: 0, Y: 0 }, &mut read);
                text = String::from_utf16_lossy(&buf[..read as usize]);
                CloseHandle(h);
            }
            FreeConsole();
        }
        AttachConsole(ATTACH_PARENT_PROCESS);
        text
    };
    let _ = cmd.kill();
    let _ = cmd.wait();
    assert_eq!(std::fs::read_to_string(probe(&base)).unwrap().trim(), "console=true", "the CLI attached to the terminal it was typed into");
    assert!(shown.contains(genie_launcher::LAUNCHER_BUILD), "`genie version` answered in that terminal: {:?}", shown.trim());
}

//! GENIE-LAUNCH.EXE'S MODES, FOLDED IN. The quoting on every OS (pure); the modes themselves on Windows, with the
//! contracts test/win-launcher.test.ts holds for the packaged copy: `job` passes the child's output and exit code through
//! and ends what it started when it is ended; `detach` prints the child's pid and the child runs on with its log;
//! `pipe-owner-only` leaves a pipe with this user and SYSTEM only.
mod common;

use genie_launcher::argquote::{command_line, quote_arg};

#[test]
fn arguments_are_quoted_as_the_msvc_runtime_reads_them_back() {
    assert_eq!(quote_arg("plain"), "plain");
    assert_eq!(quote_arg(""), "\"\"");
    assert_eq!(quote_arg("a b"), "\"a b\"");
    assert_eq!(quote_arg("c\"d"), "\"c\\\"d\"");
    assert_eq!(quote_arg("e\\"), "e\\", "a trailing backslash with nothing to quote stays");
    assert_eq!(quote_arg("f g\\"), "\"f g\\\\\"", "a trailing backslash before the closing quote doubles");
    assert_eq!(quote_arg("h\\\"i"), "\"h\\\\\\\"i\"");
    assert_eq!(quote_arg("tab\there"), "\"tab\there\"");
    assert_eq!(command_line(&["a b".into(), "c".into()]), "\"a b\" c");
}

#[test]
fn the_modes_are_windows_only_elsewhere() {
    if cfg!(windows) {
        return;
    }
    for mode in ["detach", "job", "pipe-owner-only"] {
        let out = common::genie().arg(mode).output().unwrap();
        assert_eq!(out.status.code(), Some(125), "{mode}");
        assert!(String::from_utf8_lossy(&out.stderr).contains("Windows"), "{mode}");
    }
}

#[cfg(windows)]
mod windows {
    use super::common::*;
    use std::io::Read;
    use std::time::{Duration, Instant};

    const CMD: &str = r"C:\Windows\System32\cmd.exe";
    const PS: &str = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe";

    #[test]
    fn job_passes_the_childs_output_and_exit_code_through() {
        let out = genie().args(["job", CMD, "/d", "/c", "echo out& echo err 1>&2& exit 7"]).output().unwrap();
        assert_eq!(out.status.code(), Some(7));
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "out");
        assert_eq!(String::from_utf8_lossy(&out.stderr).trim(), "err");
    }

    #[test]
    fn job_hands_arguments_over_unchanged() {
        // The stand-in prints the arguments it was given (Rust's Debug form), then records them under GENIE_HOME.
        let home = temp_dir("job-args");
        let out = genie().env("GENIE_HOME", &home).args(["job", env!("CARGO_BIN_EXE_genie-fake-host"), "--open-window", "a b", "c\"d", "e\\", ""]).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let said = String::from_utf8_lossy(&out.stdout);
        assert!(said.contains(r#"["--open-window", "a b", "c\"d", "e\\", ""]"#), "{said}");
    }

    fn alive(pid: u32) -> bool {
        genie_launcher::spawn::pid_alive(pid)
    }

    #[test]
    fn ending_job_ends_what_the_child_started_however_detached() {
        let dir = temp_dir("job-tree");
        let mark = dir.join("grandchild.pid");
        // The child starts a grandchild of its own (Start-Process: not in its console, not its child in any way the
        // caller could walk) and waits; the grandchild writes its pid.
        let script = format!("$p = Start-Process -PassThru -WindowStyle Hidden -FilePath '{PS}' -ArgumentList '-NoProfile','-Command','Start-Sleep 120'; Set-Content -Path '{}' -Value $p.Id; Start-Sleep 120", mark.display());
        let mut parent = genie().args(["job", PS, "-NoProfile", "-Command", script.as_str()]).stdout(std::process::Stdio::null()).spawn().unwrap();
        let t = Instant::now();
        let grandchild: u32 = loop {
            if let Ok(text) = std::fs::read_to_string(&mark) {
                if let Ok(pid) = text.trim().parse() {
                    break pid;
                }
            }
            assert!(t.elapsed() < Duration::from_secs(30), "the grandchild never started");
            std::thread::sleep(Duration::from_millis(100));
        };
        assert!(alive(grandchild));
        parent.kill().unwrap();
        let _ = parent.wait();
        let t = Instant::now();
        while alive(grandchild) && t.elapsed() < Duration::from_secs(10) {
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(!alive(grandchild), "the job ended the grandchild with the launcher");
    }

    #[test]
    fn detach_prints_the_childs_pid_and_the_child_writes_only_its_log() {
        let dir = temp_dir("detach");
        let log = dir.join("child.log");
        let out = genie().arg("detach").arg(&log).args([CMD, "/d", "/c", "echo ran& ping -n 2 127.0.0.1 >nul"]).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let pid: u32 = String::from_utf8_lossy(&out.stdout).trim().parse().expect("a pid");
        assert!(pid > 0);
        let t = Instant::now();
        loop {
            let mut text = String::new();
            if let Ok(mut f) = std::fs::File::open(&log) {
                let _ = f.read_to_string(&mut text);
            }
            if text.contains("ran") {
                break;
            }
            assert!(t.elapsed() < Duration::from_secs(10), "the child never wrote its log");
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    #[test]
    fn detach_and_job_with_nothing_to_start_fail_with_125() {
        assert_eq!(genie().arg("detach").output().unwrap().status.code(), Some(125));
        assert_eq!(genie().arg("job").output().unwrap().status.code(), Some(125));
        assert_eq!(genie().args(["job", r"C:\nowhere\nothing.exe"]).output().unwrap().status.code(), Some(125));
    }

    #[test]
    fn pipe_owner_only_leaves_the_user_and_system() {
        let name = format!(r"\\.\pipe\genie-l2-test-{}", std::process::id());
        // An ordinary pipe (Windows' default descriptor), as Node makes them.
        let mut server = genie_launcher::win::test_default_pipe(&name).expect("a pipe");
        let out = genie().args(["pipe-owner-only", &name]).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let sid = genie_launcher::win::current_user_sid().unwrap();
        let want = format!("D:P(A;;FA;;;{sid})(A;;FA;;;SY)");
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), want);
        assert_eq!(genie_launcher::win::pipe_dacl_sddl(&name).unwrap(), want);
        server.close();
    }
}

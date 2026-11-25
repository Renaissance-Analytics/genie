//! GENIE-LAUNCH.EXE'S THREE JOBS, FOLDED IN (Windows; native/win-launcher/genie-launch.c, #1628, #1639, Tynn #398), with
//! the same contracts, held by test/win-launcher.test.ts and tests/win_modes.rs:
//!
//!   genie detach <log file> <program> [args...]
//!     The child inherits ONLY its three standard handles (the log file, twice, and NUL as input): a handle list
//!     (PROC_THREAD_ATTRIBUTE_HANDLE_LIST), never the rest of this process's. Detached, in its own process group, hidden,
//!     out of any job this one is in where the job allows it. Prints the child's pid and exits.
//!
//!   genie job <program> [args...]
//!     The child inherits ONLY this process's three standard handles and runs inside a job object created here with
//!     KILL_ON_JOB_CLOSE, created suspended, put in the job, then resumed. This waits for it and exits with its exit
//!     code. Ending THIS process closes the job, and the job ends every process in it. A child that ends by itself leaves
//!     what it started as it is: the kill is lifted first.
//!
//!   genie pipe-owner-only <pipe>
//!     The named pipe gets a protected DACL: this process's user and SYSTEM only. Prints the DACL read back (SDDL).
//!
//! Exit 125 (LAUNCH_FAILED) = the child could not be started, or the pipe's DACL set (the reason on stderr).

use std::ffi::OsString;

pub fn detach_main(args: &[OsString]) -> i32 {
    let _ = args;
    todo!("L2")
}

pub fn job_main(args: &[OsString]) -> i32 {
    let _ = args;
    todo!("L2")
}

pub fn pipe_owner_only_main(args: &[OsString]) -> i32 {
    let _ = args;
    todo!("L2")
}

/// This process's user, as a string SID (`S-1-5-21-...`).
pub fn current_user_sid() -> Result<String, String> {
    todo!("L2")
}

/// The owner-only descriptor: protected, this user and SYSTEM, full access each.
pub fn owner_only_sddl() -> Result<String, String> {
    Ok(format!("D:P(A;;FA;;;{})(A;;FA;;;SY)", current_user_sid()?))
}

/// The DACL of a kernel object reached by path (a pipe), read back as SDDL.
pub fn pipe_dacl_sddl(pipe: &str) -> Result<String, String> {
    let _ = pipe;
    todo!("L2")
}

/// The SIDs, other than this user's, SYSTEM's and Administrators', that the file object's DACL lets change it.
pub fn other_writers(path: &std::path::Path) -> Result<Vec<String>, String> {
    let _ = path;
    todo!("L2")
}

/// A pipe with Windows' default descriptor and a few waiting instances, as Node makes them: for the tests of
/// `pipe-owner-only` only.
pub struct TestPipe {
    handles: Vec<isize>,
}

impl TestPipe {
    pub fn close(&mut self) {
        todo!("L2")
    }
}

pub fn test_default_pipe(name: &str) -> Result<TestPipe, String> {
    let _ = name;
    todo!("L2")
}

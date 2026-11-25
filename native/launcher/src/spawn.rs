//! THE ONLY PLACE A PROGRAM IS STARTED (a source guard holds it: tests/source_guard.rs). It takes a `layout::Program`
//! alone: an absolute path inside a build folder, started with that folder as its working folder, never through a shell
//! or a search of PATH or the working folder (`lpApplicationName` on Windows). The child inherits ONLY its standard
//! handles: NUL as input, the log file as output and error (on Windows a handle list, genie-launch.c's `detach`; on
//! Linux every other descriptor is close-on-exec). It runs detached in its own session or process group.

use crate::layout::Program;
use std::path::Path;
use std::time::Duration;

pub fn start_detached(program: &Program, args: &[String], env: &[(String, String)], log: &Path) -> Result<u32, String> {
    let _ = (program, args, env, log);
    todo!("L2")
}

pub fn pid_alive(pid: u32) -> bool {
    let _ = pid;
    todo!("L2")
}

/// True once `pid` has gone, false when it is still there after `timeout`.
pub fn wait_gone(pid: u32, timeout: Duration) -> bool {
    let _ = (pid, timeout);
    todo!("L2")
}

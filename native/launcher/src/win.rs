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

use crate::argquote::command_line;
use crate::LAUNCH_FAILED;
use std::ffi::{c_void, OsStr, OsString};
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::{
    CloseHandle, DuplicateHandle, GetLastError, LocalFree, SetLastError, DUPLICATE_SAME_ACCESS, ERROR_ACCESS_DENIED, ERROR_PIPE_BUSY,
    ERROR_SUCCESS, GENERIC_READ, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSecurityDescriptorToStringSecurityDescriptorW, ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
    GetNamedSecurityInfoW, GetSecurityInfo, SetSecurityInfo, SDDL_REVISION_1, SE_FILE_OBJECT, SE_KERNEL_OBJECT,
};
use windows_sys::Win32::Security::{
    GetAce, GetSecurityDescriptorDacl, GetTokenInformation, TokenUser, ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, DACL_SECURITY_INFORMATION,
    INHERIT_ONLY_ACE, PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_APPEND_DATA, FILE_ATTRIBUTE_NORMAL, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_SHARE_DELETE, FILE_SHARE_READ,
    FILE_SHARE_WRITE, OPEN_ALWAYS, OPEN_EXISTING, PIPE_ACCESS_DUPLEX, READ_CONTROL, WRITE_DAC,
};
use windows_sys::Win32::System::Console::{GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Pipes::{
    CreateNamedPipeW, WaitNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};
use windows_sys::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetCurrentProcess, GetExitCodeProcess, InitializeProcThreadAttributeList,
    OpenProcessToken, ResumeThread, TerminateProcess, UpdateProcThreadAttribute, WaitForSingleObject, CREATE_BREAKAWAY_FROM_JOB,
    CREATE_NEW_PROCESS_GROUP, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, DETACHED_PROCESS, EXTENDED_STARTUPINFO_PRESENT, INFINITE,
    PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, STARTF_USESHOWWINDOW, STARTF_USESTDHANDLES, STARTUPINFOEXW,
};

fn say(what: &str, error: u32) {
    eprintln!("genie-launch: {what} (error {error})");
}

pub(crate) fn wide(s: &OsStr) -> Vec<u16> {
    s.encode_wide().chain(std::iter::once(0)).collect()
}

fn wide_str(s: &str) -> Vec<u16> {
    wide(OsStr::new(s))
}

unsafe fn from_wide_ptr(p: *const u16) -> String {
    let mut n = 0;
    while *p.add(n) != 0 {
        n += 1;
    }
    String::from_utf16_lossy(std::slice::from_raw_parts(p, n))
}

/// A copy of `h` that a child may inherit; null for none.
fn inheritable(h: HANDLE) -> HANDLE {
    if h.is_null() || h == INVALID_HANDLE_VALUE {
        return null_mut();
    }
    let mut copy: HANDLE = null_mut();
    let ok = unsafe { DuplicateHandle(GetCurrentProcess(), h, GetCurrentProcess(), &mut copy, 0, 1, DUPLICATE_SAME_ACCESS) };
    if ok == 0 { null_mut() } else { copy }
}

/// How a child is started: the program (absolute), its command line, its working folder and environment (None = this
/// process's), its three standard handles (each inheritable or null), and the creation flags.
pub(crate) struct Start<'a> {
    pub program: &'a [u16],
    pub command: String,
    pub cwd: Option<&'a [u16]>,
    pub env: Option<Vec<u16>>,
    pub stdio: [HANDLE; 3],
    pub flags: u32,
    pub hidden: bool,
}

/// The child, with exactly these standard handles inheritable and nothing else (the handle list). The error is the
/// Win32 error code.
pub(crate) fn start(s: &Start) -> Result<PROCESS_INFORMATION, u32> {
    let mut list: Vec<HANDLE> = Vec::new();
    for h in s.stdio {
        if !h.is_null() && !list.contains(&h) {
            list.push(h);
        }
    }
    unsafe {
        let mut size: usize = 0;
        InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut size);
        let mut buf: Vec<usize> = vec![0; size / std::mem::size_of::<usize>() + 1];
        let attrs = buf.as_mut_ptr() as *mut c_void;
        if InitializeProcThreadAttributeList(attrs, 1, 0, &mut size) == 0 {
            return Err(GetLastError());
        }
        let inherit = !list.is_empty();
        if inherit
            && UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize, list.as_ptr() as *const c_void, list.len() * std::mem::size_of::<HANDLE>(), null_mut(), null())
                == 0
        {
            let e = GetLastError();
            DeleteProcThreadAttributeList(attrs);
            return Err(e);
        }
        let mut si: STARTUPINFOEXW = std::mem::zeroed();
        si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        si.StartupInfo.dwFlags = STARTF_USESTDHANDLES | if s.hidden { STARTF_USESHOWWINDOW } else { 0 };
        si.StartupInfo.wShowWindow = 0; // SW_HIDE, read only with STARTF_USESHOWWINDOW
        si.StartupInfo.hStdInput = s.stdio[0];
        si.StartupInfo.hStdOutput = s.stdio[1];
        si.StartupInfo.hStdError = s.stdio[2];
        si.lpAttributeList = attrs;
        let mut cmd = wide_str(&s.command);
        let mut pi: PROCESS_INFORMATION = std::mem::zeroed();
        let env_ptr = s.env.as_ref().map_or(null(), |e| e.as_ptr() as *const c_void);
        let cwd_ptr = s.cwd.map_or(null(), |c| c.as_ptr());
        let ok = CreateProcessW(
            s.program.as_ptr(),
            cmd.as_mut_ptr(),
            null(),
            null(),
            if inherit { 1 } else { 0 },
            s.flags | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
            env_ptr,
            cwd_ptr,
            &si.StartupInfo,
            &mut pi,
        );
        let error = if ok == 0 { GetLastError() } else { 0 };
        DeleteProcThreadAttributeList(attrs);
        drop(buf);
        if ok == 0 {
            SetLastError(error);
            return Err(error);
        }
        Ok(pi)
    }
}

fn args_text(args: &[OsString], from: usize) -> Vec<String> {
    args[from..].iter().map(|a| a.to_string_lossy().into_owned()).collect()
}

/// The log file, opened for appending and inheritable.
pub(crate) fn open_log(path: &Path) -> Result<HANDLE, u32> {
    let sa = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: null_mut(), bInheritHandle: 1 };
    let name = wide(path.as_os_str());
    let h = unsafe { CreateFileW(name.as_ptr(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, &sa, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, null_mut()) };
    if h == INVALID_HANDLE_VALUE { Err(unsafe { GetLastError() }) } else { Ok(h) }
}

/// NUL, readable and inheritable (null when it cannot be opened).
pub(crate) fn open_nul() -> HANDLE {
    let sa = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: null_mut(), bInheritHandle: 1 };
    let name = wide_str("NUL");
    let h = unsafe { CreateFileW(name.as_ptr(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, null_mut()) };
    if h == INVALID_HANDLE_VALUE { null_mut() } else { h }
}

pub(crate) fn close(h: HANDLE) {
    if !h.is_null() && h != INVALID_HANDLE_VALUE {
        unsafe { CloseHandle(h) };
    }
}

/// Detached, hidden, its own process group, out of this process's job where the job allows it.
pub(crate) fn start_detached_raw(program: &[u16], command: String, cwd: Option<&[u16]>, env: Option<Vec<u16>>, std3: [HANDLE; 3], hidden: bool) -> Result<PROCESS_INFORMATION, u32> {
    let flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
    let mut s = Start { program, command, cwd, env, stdio: std3, flags: flags | CREATE_BREAKAWAY_FROM_JOB, hidden };
    match start(&s) {
        Err(e) if e == ERROR_ACCESS_DENIED => {
            s.flags = flags;
            start(&s)
        }
        other => other,
    }
}

pub fn detach_main(args: &[OsString]) -> i32 {
    if args.len() < 4 {
        eprintln!("genie-launch: detach <log file> <program> [args...]");
        return LAUNCH_FAILED;
    }
    let log = match open_log(Path::new(&args[2])) {
        Ok(h) => h,
        Err(e) => {
            say("the log file could not be opened", e);
            return LAUNCH_FAILED;
        }
    };
    let nul = open_nul();
    let program = wide(&args[3]);
    let command = command_line(&args_text(args, 3));
    match start_detached_raw(&program, command, None, None, [nul, log, log], true) {
        Ok(pi) => {
            println!("{}", pi.dwProcessId);
            close(pi.hThread);
            close(pi.hProcess);
            0
        }
        Err(e) => {
            say("the program could not be started", e);
            LAUNCH_FAILED
        }
    }
}

pub fn job_main(args: &[OsString]) -> i32 {
    if args.len() < 3 {
        eprintln!("genie-launch: job <program> [args...]");
        return LAUNCH_FAILED;
    }
    unsafe {
        let job = CreateJobObjectW(null(), null());
        if job.is_null() {
            say("no job object", GetLastError());
            return LAUNCH_FAILED;
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let set = |l: &JOBOBJECT_EXTENDED_LIMIT_INFORMATION| {
            SetInformationJobObject(job, JobObjectExtendedLimitInformation, l as *const _ as *const c_void, std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32)
        };
        if set(&limits) == 0 {
            say("the job could not be set to end its processes", GetLastError());
            return LAUNCH_FAILED;
        }
        let std3 = [inheritable(GetStdHandle(STD_INPUT_HANDLE)), inheritable(GetStdHandle(STD_OUTPUT_HANDLE)), inheritable(GetStdHandle(STD_ERROR_HANDLE))];
        let program = wide(&args[2]);
        let s = Start { program: &program, command: command_line(&args_text(args, 2)), cwd: None, env: None, stdio: std3, flags: CREATE_SUSPENDED, hidden: true };
        let pi = match start(&s) {
            Ok(pi) => pi,
            Err(e) => {
                say("the program could not be started", e);
                return LAUNCH_FAILED;
            }
        };
        if AssignProcessToJobObject(job, pi.hProcess) == 0 {
            // Nothing it starts may escape: a child that cannot be put in the job is not run.
            say("the program could not be put in the job", GetLastError());
            TerminateProcess(pi.hProcess, LAUNCH_FAILED as u32);
            return LAUNCH_FAILED;
        }
        for h in std3 {
            close(h);
        }
        ResumeThread(pi.hThread);
        close(pi.hThread);
        WaitForSingleObject(pi.hProcess, INFINITE);
        let mut code: u32 = LAUNCH_FAILED as u32;
        GetExitCodeProcess(pi.hProcess, &mut code);
        // Ended by itself: what it started is left as it would be without the job. Only this process ending early ends it all.
        limits.BasicLimitInformation.LimitFlags = 0;
        set(&limits);
        close(pi.hProcess);
        close(job);
        code as i32
    }
}

/// This process's user, as a string SID (`S-1-5-21-...`).
pub fn current_user_sid() -> Result<String, String> {
    unsafe {
        let mut token: HANDLE = null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(format!("the process token could not be read (error {})", GetLastError()));
        }
        let mut size: u32 = 0;
        GetTokenInformation(token, TokenUser, null_mut(), 0, &mut size);
        let mut buf: Vec<usize> = vec![0; size as usize / std::mem::size_of::<usize>() + 1];
        if GetTokenInformation(token, TokenUser, buf.as_mut_ptr() as *mut c_void, size, &mut size) == 0 {
            let e = GetLastError();
            close(token);
            return Err(format!("the token's user could not be read (error {e})"));
        }
        close(token);
        let user = &*(buf.as_ptr() as *const TOKEN_USER);
        sid_string(user.User.Sid)
    }
}

unsafe fn sid_string(sid: *mut c_void) -> Result<String, String> {
    let mut text: *mut u16 = null_mut();
    if ConvertSidToStringSidW(sid, &mut text) == 0 {
        return Err(format!("a SID could not be written (error {})", GetLastError()));
    }
    let s = from_wide_ptr(text);
    LocalFree(text as *mut c_void);
    Ok(s)
}

/// The owner-only descriptor: protected, this user and SYSTEM, full access each.
pub fn owner_only_sddl() -> Result<String, String> {
    Ok(format!("D:P(A;;FA;;;{})(A;;FA;;;SY)", current_user_sid()?))
}

/// A security descriptor built from SDDL; freed with LocalFree by the holder.
pub(crate) struct Descriptor(pub(crate) PSECURITY_DESCRIPTOR);

impl Descriptor {
    pub(crate) fn from_sddl(sddl: &str) -> Result<Descriptor, String> {
        let text = wide_str(sddl);
        let mut sd: PSECURITY_DESCRIPTOR = null_mut();
        if unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(text.as_ptr(), SDDL_REVISION_1, &mut sd, null_mut()) } == 0 {
            return Err(format!("the descriptor could not be built (error {})", unsafe { GetLastError() }));
        }
        Ok(Descriptor(sd))
    }
}

impl Drop for Descriptor {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { LocalFree(self.0) };
        }
    }
}

/// Opens a pipe as a client for `access`, waiting while it is busy.
fn open_pipe(pipe: &str, access: u32) -> Result<HANDLE, u32> {
    let name = wide_str(pipe);
    for _ in 0..40 {
        let h = unsafe { CreateFileW(name.as_ptr(), access, 0, null(), OPEN_EXISTING, 0, null_mut()) };
        if h != INVALID_HANDLE_VALUE {
            return Ok(h);
        }
        let e = unsafe { GetLastError() };
        if e != ERROR_PIPE_BUSY {
            return Err(e);
        }
        unsafe { WaitNamedPipeW(name.as_ptr(), 250) };
    }
    Err(ERROR_PIPE_BUSY)
}

unsafe fn dacl_sddl_of(h: HANDLE) -> Result<String, String> {
    let mut sd: PSECURITY_DESCRIPTOR = null_mut();
    let got = GetSecurityInfo(h, SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION, null_mut(), null_mut(), null_mut(), null_mut(), &mut sd);
    if got != ERROR_SUCCESS {
        return Err(format!("the DACL could not be read back (error {got})"));
    }
    let mut text: *mut u16 = null_mut();
    if ConvertSecurityDescriptorToStringSecurityDescriptorW(sd, SDDL_REVISION_1, DACL_SECURITY_INFORMATION, &mut text, null_mut()) == 0 {
        let e = GetLastError();
        LocalFree(sd);
        return Err(format!("the DACL read back could not be written (error {e})"));
    }
    let s = from_wide_ptr(text);
    LocalFree(text as *mut c_void);
    LocalFree(sd);
    Ok(s)
}

pub fn pipe_owner_only_main(args: &[OsString]) -> i32 {
    if args.len() != 3 {
        eprintln!("genie-launch: pipe-owner-only <pipe>");
        return LAUNCH_FAILED;
    }
    let sddl = match owner_only_sddl() {
        Ok(s) => s,
        Err(why) => {
            eprintln!("genie-launch: {why}");
            return LAUNCH_FAILED;
        }
    };
    let wanted = match Descriptor::from_sddl(&sddl) {
        Ok(d) => d,
        Err(why) => {
            eprintln!("genie-launch: {why}");
            return LAUNCH_FAILED;
        }
    };
    unsafe {
        let mut present = 0;
        let mut defaulted = 0;
        let mut dacl: *mut ACL = null_mut();
        if GetSecurityDescriptorDacl(wanted.0, &mut present, &mut dacl, &mut defaulted) == 0 || present == 0 {
            say("the descriptor has no DACL", GetLastError());
            return LAUNCH_FAILED;
        }
        let pipe = match open_pipe(&args[2].to_string_lossy(), READ_CONTROL | WRITE_DAC) {
            Ok(h) => h,
            Err(e) => {
                say("the pipe could not be opened", e);
                return LAUNCH_FAILED;
            }
        };
        let set = SetSecurityInfo(pipe, SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, null_mut(), null_mut(), dacl, null());
        if set != ERROR_SUCCESS {
            say("the pipe's DACL could not be set", set);
            close(pipe);
            return LAUNCH_FAILED;
        }
        let now = dacl_sddl_of(pipe);
        close(pipe);
        match now {
            Ok(text) => {
                println!("{text}");
                0
            }
            Err(why) => {
                eprintln!("genie-launch: {why}");
                LAUNCH_FAILED
            }
        }
    }
}

/// The DACL of a kernel object reached by path (a pipe), read back as SDDL.
pub fn pipe_dacl_sddl(pipe: &str) -> Result<String, String> {
    let h = open_pipe(pipe, READ_CONTROL).map_err(|e| format!("the pipe could not be opened (error {e})"))?;
    let r = unsafe { dacl_sddl_of(h) };
    close(h);
    r
}

/// Rights that let an account change a folder or what is in it.
const WRITE_RIGHTS: u32 = 0x0002 /* write data, add file */
    | 0x0004 /* append data, add folder */
    | 0x0010 /* write extended attributes */
    | 0x0040 /* delete child */
    | 0x0100 /* write attributes */
    | 0x0001_0000 /* delete */
    | 0x0004_0000 /* write DAC */
    | 0x0008_0000 /* write owner */
    | 0x1000_0000 /* generic all */
    | 0x4000_0000 /* generic write */;

/// The SIDs, other than this user's, SYSTEM's and Administrators', that the file object's DACL lets change it.
pub fn other_writers(path: &Path) -> Result<Vec<String>, String> {
    let me = current_user_sid()?;
    let trusted = [me.as_str(), "S-1-5-18", "S-1-5-32-544"];
    let name = wide(path.as_os_str());
    unsafe {
        let mut dacl: *mut ACL = null_mut();
        let mut sd: PSECURITY_DESCRIPTOR = null_mut();
        let got = GetNamedSecurityInfoW(name.as_ptr(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, null_mut(), null_mut(), &mut dacl, null_mut(), &mut sd);
        if got != ERROR_SUCCESS {
            return Err(format!("{}: its permissions could not be read (error {got})", path.display()));
        }
        let mut out = Vec::new();
        if dacl.is_null() {
            out.push("everyone (it has no DACL)".to_string());
        } else {
            for i in 0..(*dacl).AceCount as u32 {
                let mut ace: *mut c_void = null_mut();
                if GetAce(dacl, i, &mut ace) == 0 {
                    continue;
                }
                let header = &*(ace as *const ACE_HEADER);
                if header.AceType != 0 || (header.AceFlags as u32) & (INHERIT_ONLY_ACE as u32) != 0 {
                    continue; // only allow entries that apply to this folder itself
                }
                let allowed = &*(ace as *const ACCESS_ALLOWED_ACE);
                if allowed.Mask & WRITE_RIGHTS == 0 {
                    continue;
                }
                let sid = sid_string(&allowed.SidStart as *const u32 as *mut c_void)?;
                if !trusted.contains(&sid.as_str()) && !out.contains(&sid) {
                    out.push(sid);
                }
            }
        }
        LocalFree(sd);
        Ok(out)
    }
}

/// Creates the pipe `name` owner-only (the protected DACL from its first moment). `first`: refuse if it exists.
pub(crate) fn create_owner_only_pipe(name: &str, first: bool) -> std::io::Result<HANDLE> {
    let sddl = owner_only_sddl().map_err(std::io::Error::other)?;
    let sd = Descriptor::from_sddl(&sddl).map_err(std::io::Error::other)?;
    let sa = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: sd.0, bInheritHandle: 0 };
    let w = wide_str(name);
    let open = PIPE_ACCESS_DUPLEX | if first { FILE_FLAG_FIRST_PIPE_INSTANCE } else { 0 };
    let h = unsafe { CreateNamedPipeW(w.as_ptr(), open, PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, PIPE_UNLIMITED_INSTANCES, 65536, 65536, 0, &sa) };
    if h == INVALID_HANDLE_VALUE {
        let e = unsafe { GetLastError() };
        if first && e == ERROR_ACCESS_DENIED {
            return Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, format!("{name} is already served")));
        }
        return Err(std::io::Error::from_raw_os_error(e as i32));
    }
    Ok(h)
}

/// A pipe with Windows' default descriptor and a few waiting instances, as Node makes them: for the tests of
/// `pipe-owner-only` only.
pub struct TestPipe {
    handles: Vec<isize>,
}

impl TestPipe {
    pub fn close(&mut self) {
        for h in self.handles.drain(..) {
            close(h as HANDLE);
        }
    }
}

pub fn test_default_pipe(name: &str) -> Result<TestPipe, String> {
    let w = wide_str(name);
    let mut handles = Vec::new();
    for _ in 0..4 {
        let h = unsafe { CreateNamedPipeW(w.as_ptr(), PIPE_ACCESS_DUPLEX, PIPE_TYPE_BYTE | PIPE_WAIT, PIPE_UNLIMITED_INSTANCES, 4096, 4096, 0, null()) };
        if h == INVALID_HANDLE_VALUE {
            return Err(format!("the pipe could not be made (error {})", unsafe { GetLastError() }));
        }
        handles.push(h as isize);
    }
    Ok(TestPipe { handles })
}

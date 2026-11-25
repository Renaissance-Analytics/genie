//! THE CODE ROOT IS THE USER'S ONLY. At start the launcher refuses to run from a code root another account can change:
//! on Linux, owned by another user or writable by group or others; on Windows, a DACL that lets anyone but this user,
//! SYSTEM or Administrators write, add, delete or change permissions (inherit-only entries aside).

use std::path::Path;

pub fn refusal_words(path: &Path) -> String {
    format!("Genie's programs folder can be changed by other accounts on this computer ({}). Genie will not run from it until that is fixed.", path.display())
}

/// Ok when only this user (and the system's own accounts) can change `dir`; the person's words otherwise.
pub fn check_private(dir: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let meta = std::fs::metadata(dir).map_err(|e| format!("{} could not be read: {e}", dir.display()))?;
        let me = unsafe { libc::geteuid() };
        if meta.uid() != me || meta.mode() & 0o022 != 0 {
            return Err(refusal_words(dir));
        }
        Ok(())
    }
    #[cfg(windows)]
    {
        let others = crate::win::other_writers(dir)?;
        if others.is_empty() { Ok(()) } else { Err(format!("{} (it lets {} change it)", refusal_words(dir), others.join(", "))) }
    }
}

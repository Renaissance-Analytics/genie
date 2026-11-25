//! THE LOCAL ENDPOINTS: a named pipe on Windows, a Unix socket on Linux. `bind` makes one OWNER-ONLY from its first
//! moment: on Windows the pipe is created with a protected DACL (this user and SYSTEM, genie-launch.c's
//! `pipe-owner-only` descriptor, given at creation rather than set after) and refuses remote clients; on Linux the socket
//! is bound under umask 077 and set to 0600. A second `bind` of the same pipe fails (FILE_FLAG_FIRST_PIPE_INSTANCE).

use std::io::{self, Read, Write};
use std::time::Duration;

pub struct LocalListener {
    #[allow(dead_code)]
    endpoint: String,
    #[cfg(unix)]
    inner: std::os::unix::net::UnixListener,
}

pub struct LocalStream {
    #[cfg(unix)]
    inner: std::os::unix::net::UnixStream,
    #[cfg(windows)]
    inner: std::fs::File,
}

impl LocalListener {
    pub fn bind(endpoint: &str) -> io::Result<LocalListener> {
        let _ = endpoint;
        todo!("L2")
    }
    pub fn accept(&self) -> io::Result<LocalStream> {
        todo!("L2")
    }
}

impl LocalStream {
    pub fn connect(endpoint: &str, timeout: Duration) -> io::Result<LocalStream> {
        let _ = (endpoint, timeout);
        todo!("L2")
    }
    pub fn try_clone(&self) -> io::Result<LocalStream> {
        todo!("L2")
    }
}

impl Read for LocalStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.inner.read(buf)
    }
}

impl Write for LocalStream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.inner.write(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

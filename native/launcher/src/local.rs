//! THE LOCAL ENDPOINTS: a named pipe on Windows, a Unix socket on Linux. `bind` makes one OWNER-ONLY from its first
//! moment: on Windows the pipe is created with a protected DACL (this user and SYSTEM, genie-launch.c's
//! `pipe-owner-only` descriptor, given at creation rather than set after) and refuses remote clients; on Linux the socket
//! is bound under umask 077 and set to 0600. A second `bind` of the same endpoint fails with `AlreadyExists`.

use std::io::{self, Read, Write};
use std::time::{Duration, Instant};

pub struct LocalListener {
    #[allow(dead_code)]
    endpoint: String,
    #[cfg(unix)]
    inner: std::os::unix::net::UnixListener,
    /// The instance waiting for the next client (a HANDLE, kept as an integer so the listener is Send).
    #[cfg(windows)]
    pending: std::sync::Mutex<isize>,
}

pub struct LocalStream {
    #[cfg(unix)]
    inner: std::os::unix::net::UnixStream,
    #[cfg(windows)]
    inner: std::fs::File,
}

impl LocalListener {
    #[cfg(unix)]
    pub fn bind(endpoint: &str) -> io::Result<LocalListener> {
        use std::os::unix::fs::PermissionsExt;
        use std::os::unix::net::{UnixListener, UnixStream};
        let path = std::path::Path::new(endpoint);
        if path.exists() {
            if UnixStream::connect(path).is_ok() {
                return Err(io::Error::new(io::ErrorKind::AlreadyExists, format!("{endpoint} is already served")));
            }
            std::fs::remove_file(path)?;
        }
        let old = unsafe { libc::umask(0o077) };
        let bound = UnixListener::bind(path);
        unsafe { libc::umask(old) };
        let inner = bound?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        Ok(LocalListener { endpoint: endpoint.to_string(), inner })
    }

    #[cfg(windows)]
    pub fn bind(endpoint: &str) -> io::Result<LocalListener> {
        let first = crate::win::create_owner_only_pipe(endpoint, true)?;
        Ok(LocalListener { endpoint: endpoint.to_string(), pending: std::sync::Mutex::new(first as isize) })
    }

    #[cfg(unix)]
    pub fn accept(&self) -> io::Result<LocalStream> {
        let (inner, _) = self.inner.accept()?;
        Ok(LocalStream { inner })
    }

    #[cfg(windows)]
    pub fn accept(&self) -> io::Result<LocalStream> {
        use std::os::windows::io::FromRawHandle;
        use windows_sys::Win32::Foundation::{GetLastError, ERROR_PIPE_CONNECTED, HANDLE};
        use windows_sys::Win32::System::Pipes::ConnectNamedPipe;
        let mut pending = self.pending.lock().unwrap_or_else(|p| p.into_inner());
        let h = *pending as HANDLE;
        let ok = unsafe { ConnectNamedPipe(h, std::ptr::null_mut()) };
        let error = if ok == 0 { unsafe { GetLastError() } } else { 0 };
        // The next instance waits before this one is handed out, so a client never finds no pipe.
        let next = crate::win::create_owner_only_pipe(&self.endpoint, false)?;
        *pending = next as isize;
        if ok == 0 && error != ERROR_PIPE_CONNECTED {
            crate::win::close(h);
            return Err(io::Error::from_raw_os_error(error as i32));
        }
        Ok(LocalStream { inner: unsafe { std::fs::File::from_raw_handle(h as _) } })
    }
}

impl LocalStream {
    /// Connects, waiting up to `timeout` for the endpoint to exist and to have a free instance.
    pub fn connect(endpoint: &str, timeout: Duration) -> io::Result<LocalStream> {
        let t = Instant::now();
        loop {
            match Self::connect_once(endpoint) {
                Ok(s) => return Ok(s),
                Err(e) if t.elapsed() < timeout && Self::worth_retrying(&e) => std::thread::sleep(Duration::from_millis(50)),
                Err(e) => return Err(e),
            }
        }
    }

    #[cfg(unix)]
    fn connect_once(endpoint: &str) -> io::Result<LocalStream> {
        Ok(LocalStream { inner: std::os::unix::net::UnixStream::connect(endpoint)? })
    }

    #[cfg(windows)]
    fn connect_once(endpoint: &str) -> io::Result<LocalStream> {
        Ok(LocalStream { inner: std::fs::OpenOptions::new().read(true).write(true).open(endpoint)? })
    }

    fn worth_retrying(e: &io::Error) -> bool {
        // Not there yet, refused while it binds, or every instance busy (ERROR_PIPE_BUSY, 231).
        matches!(e.kind(), io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused) || e.raw_os_error() == Some(231)
    }

    pub fn try_clone(&self) -> io::Result<LocalStream> {
        Ok(LocalStream { inner: self.inner.try_clone()? })
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

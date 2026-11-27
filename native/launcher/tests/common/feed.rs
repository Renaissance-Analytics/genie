//! A LOCAL FEED (L6): GitHub's REST release list, served on 127.0.0.1 as `GET /repos/o/r/releases` answers it — each
//! track's release on its own tag (`client-v<build>`, `host-v<build>`, `launcher-v<build>`), its package, manifest and
//! signature as assets — with an ETag, answering `304 Not Modified` to a matching `If-None-Match`. The assets are the
//! packages `write_package` made in the feed's folder. Drafts are listed only to a token, as GitHub does: never here.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[derive(Debug, Default, Clone)]
pub struct Hits {
    /// Every request for the release list.
    pub lists: u32,
    /// Those answered 304 (the client's If-None-Match matched).
    pub not_modified: u32,
    /// Every asset downloaded, by name.
    pub assets: Vec<String>,
}

struct Shared {
    releases: Vec<Value>,
    hits: Hits,
}

pub struct Feed {
    pub dir: PathBuf,
    pub port: u16,
    shared: Arc<Mutex<Shared>>,
}

impl Feed {
    pub fn start(dir: &Path) -> Feed {
        std::fs::create_dir_all(dir).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let shared = Arc::new(Mutex::new(Shared { releases: Vec::new(), hits: Hits::default() }));
        let s = Arc::clone(&shared);
        let d = dir.to_path_buf();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let s = Arc::clone(&s);
                let d = d.clone();
                std::thread::spawn(move || serve(stream, &s, &d, port));
            }
        });
        Feed { dir: dir.to_path_buf(), port, shared }
    }

    /// What the launcher is told to read (GENIE_LAUNCHER_FEED).
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/repos/o/r/releases", self.port)
    }

    /// The release of a package `write_package` put in the feed's folder (its stem), on `tag` (`<track>-v<build>`).
    pub fn publish(&self, track: &str, build: &str, prerelease: bool) {
        let suffix = format!("-{}-{}", genie_launcher::manifest::this_platform(), genie_launcher::manifest::this_arch());
        let stem = format!("{track}-{build}{suffix}");
        let mut assets = Vec::new();
        for ext in [".manifest.json", ".manifest.json.sig", ".zip", ".tar.zst"] {
            let name = format!("{stem}{ext}");
            if let Ok(meta) = std::fs::metadata(self.dir.join(&name)) {
                assets.push(json!({"name": name, "size": meta.len(), "browser_download_url": format!("http://127.0.0.1:{}/download/{name}", self.port)}));
            }
        }
        assert!(assets.len() >= 3, "the feed's folder holds {stem}'s package, manifest and signature");
        let release = json!({"tag_name": format!("{track}-v{build}"), "name": format!("{track} {build}"), "draft": false, "prerelease": prerelease,
            "body": format!("What is new in {track} {build}."), "assets": assets});
        self.shared.lock().unwrap().releases.insert(0, release);
    }

    pub fn hits(&self) -> Hits {
        self.shared.lock().unwrap().hits.clone()
    }
}

fn etag_of(body: &str) -> String {
    format!("\"{}\"", &genie_launcher::manifest::sha256_hex(body.as_bytes())[..16])
}

fn serve(stream: TcpStream, shared: &Arc<Mutex<Shared>>, dir: &Path, _port: u16) {
    let mut out = match stream.try_clone() {
        Ok(o) => o,
        Err(_) => return,
    };
    let mut reader = BufReader::new(stream);
    let mut request = String::new();
    if reader.read_line(&mut request).is_err() {
        return;
    }
    let mut if_none_match = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 || line.trim().is_empty() {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            if k.trim().eq_ignore_ascii_case("if-none-match") {
                if_none_match = Some(v.trim().to_string());
            }
        }
    }
    let path = request.split_whitespace().nth(1).unwrap_or("/").to_string();
    let respond = |out: &mut TcpStream, status: &str, headers: &[(&str, String)], body: &[u8]| {
        let mut head = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n", body.len());
        for (k, v) in headers {
            head.push_str(&format!("{k}: {v}\r\n"));
        }
        head.push_str("\r\n");
        let _ = out.write_all(head.as_bytes());
        let _ = out.write_all(body);
        let _ = out.flush();
    };
    if path.starts_with("/repos/o/r/releases") {
        let mut s = shared.lock().unwrap();
        s.hits.lists += 1;
        let body = Value::Array(s.releases.clone()).to_string();
        let etag = etag_of(&body);
        if if_none_match.as_deref() == Some(etag.as_str()) {
            s.hits.not_modified += 1;
            drop(s);
            respond(&mut out, "304 Not Modified", &[("ETag", etag)], b"");
        } else {
            drop(s);
            respond(&mut out, "200 OK", &[("ETag", etag), ("Content-Type", "application/json".into())], body.as_bytes());
        }
    } else if let Some(name) = path.strip_prefix("/download/") {
        let name = name.to_string();
        match std::fs::File::open(dir.join(&name)) {
            Ok(mut f) => {
                let mut bytes = Vec::new();
                f.read_to_end(&mut bytes).unwrap();
                shared.lock().unwrap().hits.assets.push(name);
                respond(&mut out, "200 OK", &[("Content-Type", "application/octet-stream".into())], &bytes);
            }
            Err(_) => respond(&mut out, "404 Not Found", &[], b"not found"),
        }
    } else {
        respond(&mut out, "404 Not Found", &[], b"not found");
    }
}

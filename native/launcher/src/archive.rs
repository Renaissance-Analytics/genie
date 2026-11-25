//! THE PACKAGES' ARCHIVES, read entry by entry: `.zip` (stored or deflated; Windows) and `.tar.zst` (Linux). Only
//! regular files and folders are read; a link, a device or anything else refuses the package. Nothing is written here:
//! the caller checks each entry's name and bytes against the signed manifest before anything lands.

use std::io::Read;
use std::path::Path;

/// Each regular file, by its archive name, with its bytes. An error from `each` stops the walk.
pub fn for_each_file(archive: &Path, each: &mut dyn FnMut(&str, &[u8]) -> Result<(), String>) -> Result<(), String> {
    let name = archive.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if name.ends_with(".zip") {
        let bytes = std::fs::read(archive).map_err(|e| format!("{} could not be read: {e}", archive.display()))?;
        zip_files(&bytes, each)
    } else if name.ends_with(".tar.zst") {
        let file = std::fs::File::open(archive).map_err(|e| format!("{} could not be read: {e}", archive.display()))?;
        let decoder = ruzstd::decoding::StreamingDecoder::new(std::io::BufReader::new(file)).map_err(|e| format!("not zstd: {e:?}"))?;
        tar_files(decoder, each)
    } else {
        Err(format!("{} is not a .zip or a .tar.zst", archive.display()))
    }
}

fn u16_at(b: &[u8], at: usize) -> Result<u16, String> {
    b.get(at..at + 2).map(|s| u16::from_le_bytes([s[0], s[1]])).ok_or_else(|| "the zip ends early".to_string())
}
fn u32_at(b: &[u8], at: usize) -> Result<u32, String> {
    b.get(at..at + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]])).ok_or_else(|| "the zip ends early".to_string())
}

fn zip_files(b: &[u8], each: &mut dyn FnMut(&str, &[u8]) -> Result<(), String>) -> Result<(), String> {
    const EOCD: u32 = 0x0605_4b50;
    const CENTRAL: u32 = 0x0201_4b50;
    const LOCAL: u32 = 0x0403_4b50;
    if b.len() < 22 {
        return Err("not a zip".into());
    }
    let lowest = b.len().saturating_sub(22 + 65535);
    let mut at = b.len() - 22;
    let eocd = loop {
        if u32_at(b, at)? == EOCD {
            break at;
        }
        if at == lowest {
            return Err("not a zip (no end of central directory)".into());
        }
        at -= 1;
    };
    let count = u16_at(b, eocd + 10)? as usize;
    let cd_size = u32_at(b, eocd + 12)? as usize;
    let cd_offset = u32_at(b, eocd + 16)? as usize;
    if count == 0xFFFF || cd_size == 0xFFFF_FFFF || cd_offset == 0xFFFF_FFFF {
        return Err("a zip64 archive is not a package".into());
    }
    let mut p = cd_offset;
    for _ in 0..count {
        if u32_at(b, p)? != CENTRAL {
            return Err("the zip's central directory is damaged".into());
        }
        let flags = u16_at(b, p + 8)?;
        let method = u16_at(b, p + 10)?;
        let csize = u32_at(b, p + 20)? as usize;
        let usize_ = u32_at(b, p + 24)? as usize;
        let nlen = u16_at(b, p + 28)? as usize;
        let elen = u16_at(b, p + 30)? as usize;
        let clen = u16_at(b, p + 32)? as usize;
        let attrs = u32_at(b, p + 38)?;
        let local = u32_at(b, p + 42)? as usize;
        let name_bytes = b.get(p + 46..p + 46 + nlen).ok_or("the zip ends early")?;
        let name = std::str::from_utf8(name_bytes).map_err(|_| "a zip entry's name is not UTF-8".to_string())?.to_string();
        p += 46 + nlen + elen + clen;
        if flags & 1 != 0 {
            return Err(format!("{name}: an encrypted entry is not a package's"));
        }
        let unix_kind = (attrs >> 16) & 0o170000;
        if unix_kind != 0 && unix_kind != 0o100000 && unix_kind != 0o040000 {
            return Err(format!("{name}: a link or special file is not a package's"));
        }
        if name.ends_with('/') {
            if usize_ != 0 {
                return Err(format!("{name}: a folder with content"));
            }
            continue;
        }
        if u32_at(b, local)? != LOCAL {
            return Err(format!("{name}: the zip's local header is damaged"));
        }
        let start = local + 30 + u16_at(b, local + 26)? as usize + u16_at(b, local + 28)? as usize;
        let data = b.get(start..start + csize).ok_or_else(|| format!("{name}: the zip ends early"))?;
        match method {
            0 => {
                if csize != usize_ {
                    return Err(format!("{name}: a stored entry's sizes differ"));
                }
                each(&name, data)?;
            }
            8 => {
                let out = miniz_oxide::inflate::decompress_to_vec_with_limit(data, usize_).map_err(|_| format!("{name}: its deflate stream is damaged or larger than said"))?;
                if out.len() != usize_ {
                    return Err(format!("{name}: it inflates to another size than said"));
                }
                each(&name, &out)?;
            }
            m => return Err(format!("{name}: compression method {m} is not read")),
        }
    }
    Ok(())
}

fn octal(field: &[u8]) -> Result<u64, String> {
    if field.first().is_some_and(|b| b & 0x80 != 0) {
        // GNU base-256 for large sizes.
        let mut n: u64 = (field[0] & 0x7f) as u64;
        for b in &field[1..] {
            n = n.checked_mul(256).and_then(|n| n.checked_add(*b as u64)).ok_or("a tar size is too large")?;
        }
        return Ok(n);
    }
    let text: String = field.iter().take_while(|b| **b != 0).map(|b| *b as char).collect();
    let t = text.trim();
    if t.is_empty() {
        return Ok(0);
    }
    u64::from_str_radix(t, 8).map_err(|_| format!("a tar number '{t}' is not octal"))
}

fn cstr(field: &[u8]) -> Result<String, String> {
    let end = field.iter().position(|b| *b == 0).unwrap_or(field.len());
    String::from_utf8(field[..end].to_vec()).map_err(|_| "a tar entry's name is not UTF-8".to_string())
}

/// Reads exactly `n` bytes; `Ok(false)` at a clean end of the stream before any byte.
fn fill<R: Read>(r: &mut R, buf: &mut [u8]) -> Result<bool, String> {
    let mut got = 0;
    while got < buf.len() {
        match r.read(&mut buf[got..]) {
            Ok(0) if got == 0 => return Ok(false),
            Ok(0) => return Err("the archive ends early".into()),
            Ok(n) => got += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(format!("the archive could not be read: {e}")),
        }
    }
    Ok(true)
}

fn read_body<R: Read>(r: &mut R, size: u64) -> Result<Vec<u8>, String> {
    let size = usize::try_from(size).map_err(|_| "a tar entry is too large".to_string())?;
    let mut data = vec![0u8; size];
    if size > 0 && !fill(r, &mut data)? {
        return Err("the archive ends early".into());
    }
    let pad = (512 - size % 512) % 512;
    if pad > 0 {
        let mut skip = vec![0u8; pad];
        if !fill(r, &mut skip)? {
            return Err("the archive ends early".into());
        }
    }
    Ok(data)
}

fn tar_files<R: Read>(mut r: R, each: &mut dyn FnMut(&str, &[u8]) -> Result<(), String>) -> Result<(), String> {
    let mut long_name: Option<String> = None;
    loop {
        let mut h = [0u8; 512];
        if !fill(&mut r, &mut h)? {
            return Err("the tar has no end marker".into());
        }
        if h.iter().all(|b| *b == 0) {
            return Ok(());
        }
        let want = octal(&h[148..156])?;
        let sum: u64 = h.iter().enumerate().map(|(i, b)| if (148..156).contains(&i) { 32 } else { *b as u64 }).sum();
        if want != sum {
            return Err("a tar header's checksum is wrong".into());
        }
        let size = octal(&h[124..136])?;
        let kind = h[156];
        let mut name = cstr(&h[0..100])?;
        if &h[257..262] == b"ustar" {
            let prefix = cstr(&h[345..500])?;
            if !prefix.is_empty() {
                name = format!("{prefix}/{name}");
            }
        }
        if let Some(n) = long_name.take() {
            name = n;
        }
        match kind {
            b'0' | 0 => {
                let data = read_body(&mut r, size)?;
                each(&name, &data)?;
            }
            b'5' => {
                read_body(&mut r, size)?;
            }
            b'x' => {
                let data = read_body(&mut r, size)?;
                long_name = pax_path(&data)?;
            }
            b'g' => {
                read_body(&mut r, size)?;
            }
            b'L' => {
                let data = read_body(&mut r, size)?;
                long_name = Some(cstr(&data)?);
            }
            _ => return Err(format!("{name}: a link or special entry is not a package's")),
        }
    }
}

/// The `path` record of a pax extended header, if it has one.
fn pax_path(data: &[u8]) -> Result<Option<String>, String> {
    let text = std::str::from_utf8(data).map_err(|_| "a pax header is not UTF-8".to_string())?;
    let mut rest = text;
    let mut path = None;
    while !rest.is_empty() {
        let (len, _) = rest.split_once(' ').ok_or("a pax record is damaged")?;
        let n: usize = len.parse().map_err(|_| "a pax record's length is not a number".to_string())?;
        let record = rest.get(..n).ok_or("a pax record is damaged")?;
        rest = &rest[n..];
        let body = record[len.len() + 1..].trim_end_matches('\n');
        if let Some(v) = body.strip_prefix("path=") {
            path = Some(v.to_string());
        }
    }
    Ok(path)
}

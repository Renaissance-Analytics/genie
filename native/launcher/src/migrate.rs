//! THE MIGRATION FROM THE SINGLE-APP INSTALL (Tynn #1058 L9, the bridge): the logon entry the single app wrote replaced by
//! the launcher's, and the person's two settings carried over from it. RED STUB: nothing is done yet.

use crate::layout::Roots;
use crate::logon::{LogonSettings, Place};

/// What the migration did: the settings it carried over (`None` when the client had already said them), and the old
/// entries it removed, in words.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Carried {
    pub settings: Option<LogonSettings>,
    pub removed: Vec<String>,
}

pub fn carry_over(_roots: &Roots, _place: &Place, _exe: &str) -> Result<Carried, String> {
    Ok(Carried::default())
}

/// Every value of the HKCU key `key`: its name and its data (REG_SZ / REG_EXPAND_SZ only).
#[cfg(windows)]
pub fn run_values(key: &str) -> Vec<(String, String)> {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{RegCloseKey, RegEnumValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_READ, REG_EXPAND_SZ, REG_SZ};
    let k: Vec<u16> = key.encode_utf16().chain(Some(0)).collect();
    let mut h: HKEY = std::ptr::null_mut();
    if unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, k.as_ptr(), 0, KEY_READ, &mut h) } != ERROR_SUCCESS {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut i = 0u32;
    loop {
        let mut name = vec![0u16; 16384];
        let mut name_len = name.len() as u32;
        let mut data = vec![0u8; 65536];
        let mut data_len = data.len() as u32;
        let mut kind = 0u32;
        let r = unsafe { RegEnumValueW(h, i, name.as_mut_ptr(), &mut name_len, std::ptr::null_mut(), &mut kind, data.as_mut_ptr(), &mut data_len) };
        if r != ERROR_SUCCESS {
            break;
        }
        i += 1;
        if kind != REG_SZ && kind != REG_EXPAND_SZ {
            continue;
        }
        let wide: Vec<u16> = data[..data_len as usize].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        let end = wide.iter().position(|&c| c == 0).unwrap_or(wide.len());
        out.push((String::from_utf16_lossy(&name[..name_len as usize]), String::from_utf16_lossy(&wide[..end])));
    }
    unsafe { RegCloseKey(h) };
    out
}

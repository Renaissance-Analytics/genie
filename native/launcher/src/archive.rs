//! THE PACKAGES' ARCHIVES, read entry by entry: `.zip` (stored or deflated; Windows) and `.tar.zst` (Linux). Only
//! regular files and folders are read; a link, a device or anything else refuses the package. Nothing is written here:
//! the caller checks each entry's name and bytes against the signed manifest before anything lands.

use std::path::Path;

/// Each regular file, by its archive name, with its bytes. An error from `each` stops the walk.
pub fn for_each_file(archive: &Path, each: &mut dyn FnMut(&str, &[u8]) -> Result<(), String>) -> Result<(), String> {
    let _ = (archive, each);
    todo!("L2")
}

// THE TOOLCHAIN ROW'S UPDATE CONTROL (Tynn #968): the harness holds git one version back, from the Arch Linux Archive, so
// the row can see Genie offer the update. The archive is outside Genie: when it cannot be read, the control is not set
// up, and the check is BLOCKED by `archive` (an environment blocker, linux.sh TRACKED_ENV), not a failure of Genie's.

/** The archive's base URL: GENIE_ARCH_ARCHIVE when a job points it at a mirror, else the archive itself. */
export function archiveBase(_env) { throw new Error('#968: not built yet'); }

/** From the archive's listing of git: the version to hold back to (the second newest) and the newest; null with fewer than two. */
export function heldBackOf(_listing) { throw new Error('#968: not built yet'); }

/** The listing, read with a deadline and one more try; null when it could not be read. */
export async function readListing(_fetchFn, _url, _options = {}) { throw new Error('#968: not built yet'); }

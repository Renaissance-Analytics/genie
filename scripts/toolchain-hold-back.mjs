// THE TOOLCHAIN ROW'S UPDATE CONTROL (Tynn #968): the harness holds git one version back, from the Arch Linux Archive, so
// the row can see Genie offer the update. The archive is outside Genie: when it cannot be read, the control is not set
// up, and the check is BLOCKED by `archive` (an environment blocker, linux.sh TRACKED_ENV), not a failure of Genie's.

/** The archive's base URL: GENIE_ARCH_ARCHIVE when a job points it at a mirror, else the archive itself. */
export function archiveBase(env) {
    return (typeof env?.GENIE_ARCH_ARCHIVE === 'string' && env.GENIE_ARCH_ARCHIVE.trim() !== '' ? env.GENIE_ARCH_ARCHIVE.trim() : 'https://archive.archlinux.org').replace(/\/+$/, '');
}

/** From the archive's listing of git: the version to hold back to (the second newest) and the newest; null with fewer than two. */
export function heldBackOf(listing) {
    const versions = [...new Set([...String(listing ?? '').matchAll(/href="git-(\d[^"]*?)-x86_64\.pkg\.tar\.zst"/g)].map((m) => m[1]))]
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return versions.length >= 2 ? { held: versions[versions.length - 2], newest: versions[versions.length - 1] } : null;
}

/** The listing, read with a deadline and one more try; null when it could not be read. */
export async function readListing(fetchFn, url, options = {}) {
    const timeoutMs = options.timeoutMs ?? 20_000;
    const tries = options.tries ?? 2;
    for (let i = 0; i < tries; i += 1) {
        try {
            const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
            if (res.ok) return await res.text();
        } catch { /* not reached in time, or refused: the next try, or nothing */ }
    }
    return null;
}

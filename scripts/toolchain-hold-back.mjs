// THE TOOLCHAIN ROW'S UPDATE CONTROL (Tynn #968): the harness holds git one version back, from the Arch Linux Archive, so
// the row can see Genie offer the update. The archive is outside Genie: when it cannot be read, the control is not set
// up, and the check is BLOCKED by `archive` (an environment blocker, linux.sh TRACKED_ENV), not a failure of Genie's.

/** The archive's base URL: GENIE_ARCH_ARCHIVE when a job points it at a mirror, else the archive itself. */
export function archiveBase(env) {
    return (typeof env?.GENIE_ARCH_ARCHIVE === 'string' && env.GENIE_ARCH_ARCHIVE.trim() !== '' ? env.GENIE_ARCH_ARCHIVE.trim() : 'https://archive.archlinux.org').replace(/\/+$/, '');
}

/**
 * From the archive's listing of git: the version to hold back to and the newest; null when there is none to hold to.
 * With `upTo`, the version THIS MACHINE'S repositories have (Tynn #968): the newest is that, and git is held at the newest
 * archive version whose pkgver is lower. Omarchy's stable mirror lags the archive (job 1125-191913-5de173: repos 2.56.0-1,
 * archive 2.56.1-1), so the archive's second newest (2.56.0-2) was newer than anything pacman could install, and a
 * pkgrel alone is a change `git --version` never shows. Without `upTo`: the archive's second newest and newest.
 */
export function heldBackOf(listing, upTo) {
    const byNumber = (a, b) => a.localeCompare(b, undefined, { numeric: true });
    const versions = [...new Set([...String(listing ?? '').matchAll(/href="git-(\d[^"]*?)-x86_64\.pkg\.tar\.zst"/g)].map((m) => m[1]))].sort(byNumber);
    if (typeof upTo === 'string' && upTo !== '') {
        const pkgver = (v) => v.replace(/^\d+:/, '').replace(/-[^-]+$/, '');
        const below = versions.filter((v) => byNumber(pkgver(v), pkgver(upTo)) < 0);
        return below.length > 0 ? { held: below[below.length - 1], newest: upTo } : null;
    }
    return versions.length >= 2 ? { held: versions[versions.length - 2], newest: versions[versions.length - 1] } : null;
}

/**
 * The version of a package this machine's repositories have now, read as Genie reads it (Tynn #968): `checkupdates`
 * refreshes a copy of the sync databases with no root, and `pacman -Si --dbpath` reads it. The system's own databases
 * are not touched. `run(cmd, args, options)` returns { status, stdout }. null when it cannot be read.
 */
export function repoVersion(run, pkg, dbPath) {
    const refreshed = run('checkupdates', ['--nocolor'], { env: { ...process.env, CHECKUPDATES_DB: dbPath } });
    if (refreshed.status !== 0 && refreshed.status !== 2) return null;
    const si = run('pacman', ['-Si', '--dbpath', dbPath, pkg], { env: { ...process.env, LC_ALL: 'C' } });
    return /^Version\s*:\s*(\S+)/m.exec(String(si.stdout ?? ''))?.[1] ?? null;
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

// THE HELD-BACK INSTALL ITSELF (Tynn #968; gates 1123-141448-86241a and 1123-145302-8818fd). Reading the listing is one
// read of the archive; `pacman -U <url>` is a second, and it runs pacman's own hooks on a machine the row has just changed.
// It is the harness setting up its OWN control: it says nothing about Genie. So it is tried once more after a wait, every
// try's output and exit status go into the row's log (the two gates above kept none, and so could not be explained), and
// when it still cannot be set up the check is BLOCKED by `control` (linux.sh TRACKED_ENV), never a FAIL.

/**
 * Run the held-back install, and once more after a wait when it fails. `install` is the row's own synchronous run
 * (spawnSync's result: status, signal, stdout, stderr, error). Every try is kept, whatever it did.
 */
export async function holdGitBack(install, options = {}) {
    const tries = options.tries ?? 2;
    const waitMs = options.waitMs ?? 30_000;
    const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const attempts = [];
    for (let i = 0; i < tries; i += 1) {
        if (i > 0) await sleep(waitMs);
        let r;
        try { r = install(); } catch (error) { r = { status: null, signal: null, stdout: '', stderr: '', error }; }
        const attempt = {
            status: typeof r?.status === 'number' ? r.status : null,
            signal: r?.signal ?? null,
            error: r?.error ? String(r.error instanceof Error ? r.error.message : r.error) : null,
            stdout: String(r?.stdout ?? ''),
            stderr: String(r?.stderr ?? ''),
        };
        attempts.push(attempt);
        if (attempt.status === 0) return { ok: true, tries, attempts };
    }
    return { ok: false, tries, attempts };
}

const exitWords = (a) => [`exit ${a.status ?? 'none'}`, a.signal ? `signal ${a.signal}` : null, a.error].filter(Boolean).join(', ');
const linesOf = (text) => String(text).split(/\r?\n|\r/).map((l) => l.trimEnd()).filter((l) => l.trim() !== '');

/**
 * What the row's log gets: the command, then each try's exit status and every line pacman wrote. Every line starts with
 * `--- ` (a note), so nothing pacman prints can be read as a verdict (linux.sh reads lines that START with TRACK or ROW).
 */
export function holdBackLog(url, result) {
    const lines = [`--- hold git back: pacman -U --noconfirm ${url}`];
    result.attempts.forEach((a, i) => {
        lines.push(`--- hold git back, try ${i + 1} of ${result.tries}: ${exitWords(a)}`);
        for (const l of linesOf(a.stdout)) lines.push(`---   out| ${l}`);
        for (const l of linesOf(a.stderr)) lines.push(`---   err| ${l}`);
    });
    return lines;
}

/** The check when the control could not be set up: BLOCKED by `control`, with the last try's status and pacman's own words. */
export function holdBackCheck(url, result) {
    const last = result.attempts[result.attempts.length - 1] ?? { status: null, signal: null, error: null, stdout: '', stderr: '' };
    const all = [...linesOf(last.stderr), ...linesOf(last.stdout)].map((l) => l.trim());
    // pacman's errors when it gave any; else the last it said.
    const errors = all.filter((l) => /^error:/i.test(l));
    const said = (errors.length > 0 ? errors : all.slice(-2)).join(' / ').replace(/\s+/g, ' ').slice(0, 220);
    const file = url.slice(url.lastIndexOf('/') + 1);
    return {
        verdict: 'BLOCKED',
        reason: 'control',
        detail: `CONTROL not set up: the harness could not hold git back in ${result.attempts.length} tries (pacman -U ${file}: ${exitWords(last)}); ${said ? `pacman said: ${said}` : 'pacman said nothing'}`,
    };
}

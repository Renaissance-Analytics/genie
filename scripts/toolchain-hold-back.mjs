// THE TOOLCHAIN ROW'S UPDATE CONTROL (Tynn #968): the harness holds git one version back, from the Arch Linux Archive, so
// the row can see Genie offer the update. The archive is outside Genie: when it cannot be read, the control is not set
// up, and the check is BLOCKED by `archive` (an environment blocker, linux.sh TRACKED_ENV), not a failure of Genie's.
// Since gate 1125-223010-b05ea9 the held git is ONE pinned package from our own cache first (THE HELD GIT, below).

import { createHash } from 'node:crypto';
import { join } from 'node:path';

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

// THE HELD GIT, PINNED AND OURS (gate 1125-223010-b05ea9, the beta.66 release commit 86baeb26: every row green but this
// one check, "the Arch archive (https://archive.archlinux.org) could not be read"). Reading the archive at gate time made
// a release gate's verdict depend on a third-party website being up. So the harness holds git back to ONE pinned
// package: its version and the sha256 of the package and of its signature, as fetched once from the archive and checked
// there (a Good signature from the Arch git packager, Christian Hesse, key 0429897DE5F3BDAC537A30696D42BDD116E0068F). It
// is fetched first from our own Azure blob, in the test VMs' region (storage account genietestpkgs, resource group
// genie-test-vms, role=infra, container `arch` with anonymous read of its blobs), and only then, with retries, from the
// archive. Bytes that do not hash to the pin are never installed, whichever source served them, and pacman -U checks the
// signature beside the package against the machine's keyring. The archive's LISTING is read only when the pin is not
// below this machine's repositories (they would have to go back past it).
//
// TO MOVE THE PIN (when git 2.55.0 no longer installs on the image): fetch the new git-<v>-x86_64.pkg.tar.zst and its
// .sig from https://archive.archlinux.org/packages/g/git/, check the signature (`gpg --verify`, or `pacman-key --verify`
// on an Arch machine), upload both to genietestpkgs/arch/git/, and set HELD_GIT to the version and both sha256s.

/** The git the harness holds back to. */
export const HELD_GIT = Object.freeze({
    version: '2.55.0-1',
    file: 'git-2.55.0-1-x86_64.pkg.tar.zst',
    sha256: 'fbb24f455cb1de1c004a76b5a4dab92e4a9137764fbc3bc46afe13b7a38814fe',
    sigSha256: '53c9abe5f6b7610b1f0c915f90e7a73f95fade7bd8d5ed9c53568575deae82ab',
});

/** Our cache's base URL: GENIE_PKG_CACHE when a job names another, else our Azure blob. */
export function cacheBase(env) {
    return (typeof env?.GENIE_PKG_CACHE === 'string' && env.GENIE_PKG_CACHE.trim() !== '' ? env.GENIE_PKG_CACHE.trim() : 'https://genietestpkgs.blob.core.windows.net/arch').replace(/\/+$/, '');
}

/** Where the pinned package is fetched from, in order: our cache, then the archive. */
export function pinnedSources(env, pin = HELD_GIT) {
    return [
        { name: 'cache', url: `${cacheBase(env)}/git/${pin.file}` },
        { name: 'archive', url: `${archiveBase(env)}/packages/g/git/${pin.file}` },
    ];
}

const pkgverOf = (v) => String(v).replace(/^\d+:/, '').replace(/-[^-]+$/, '');
const byNumber = (a, b) => a.localeCompare(b, undefined, { numeric: true });

/** The pin as the held git: only when its pkgver is below the repositories' (a pkgrel is no update `git --version` shows). */
export function pinnedPlan(pin, upTo) {
    if (typeof upTo !== 'string' || upTo === '') return null;
    return byNumber(pkgverOf(pin.version), pkgverOf(upTo)) < 0 ? { held: pin.version, newest: upTo } : null;
}

const sha256Of = (bytes) => createHash('sha256').update(bytes).digest('hex');
const oneLine = (text) => String(text).replace(/\s+/g, ' ').trim();

/** One file, read whole, with a deadline: its bytes, or why not. */
async function readBytes(fetchFn, url, timeoutMs) {
    try {
        const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) return { why: `http ${res.status}` };
        return { bytes: new Uint8Array(await res.arrayBuffer()) };
    } catch (error) {
        return { why: oneLine(error instanceof Error ? error.message : error) || 'failed' };
    }
}

/**
 * The pinned package and its signature, from the first source that serves both with the pin's sha256s. Each source is
 * tried `tries` times, with a wait between tries; every try is kept ({ source, url, outcome }). Not ok when none did.
 */
export async function fetchPinned(fetchFn, pin, sources, options = {}) {
    const tries = options.tries ?? 3;
    const waitMs = options.waitMs ?? 10_000;
    const timeoutMs = options.timeoutMs ?? 120_000;
    const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const attempts = [];
    for (const source of sources) {
        for (let i = 0; i < tries; i += 1) {
            if (i > 0) await sleep(waitMs);
            const pkg = await readBytes(fetchFn, source.url, timeoutMs);
            let outcome;
            let sig = null;
            if (!pkg.bytes) outcome = pkg.why;
            else if (sha256Of(pkg.bytes) !== pin.sha256) outcome = `sha256 ${sha256Of(pkg.bytes)} is not the pin`;
            else {
                sig = await readBytes(fetchFn, `${source.url}.sig`, timeoutMs);
                if (!sig.bytes) outcome = `signature: ${sig.why}`;
                else if (sha256Of(sig.bytes) !== pin.sigSha256) outcome = `signature sha256 ${sha256Of(sig.bytes)} is not the pin`;
                else outcome = 'ok';
            }
            attempts.push({ source: source.name, url: source.url, outcome });
            if (outcome === 'ok') return { ok: true, from: source.name, url: source.url, pkg: pkg.bytes, sig: sig.bytes, attempts };
        }
    }
    return { ok: false, attempts };
}

/**
 * THE HELD GIT FOR THE ROW: what to install (`target`, a file or a URL), the plan ({ held, newest }) and where it came
 * from, with `log` (lines the row says as notes). Or { ok: false, reason: 'archive', detail } when it could not be
 * had: an ENVIRONMENT blocker (linux.sh TRACKED_ENV), never a failure of Genie's. `write(path, bytes)` writes a file.
 */
export async function resolveHeldGit({ fetchFn, env, repoGit, pin = HELD_GIT, dir, write, ...options }) {
    const log = [];
    if (typeof repoGit !== 'string' || repoGit === '') {
        return { ok: false, reason: 'archive', detail: "CONTROL not set up: this machine's repositories could not be read (checkupdates)", log };
    }
    const plan = pinnedPlan(pin, repoGit);
    if (plan) {
        const sources = pinnedSources(env, pin);
        const got = await fetchPinned(fetchFn, pin, sources, options);
        got.attempts.forEach((a, i) => log.push(`held git ${pin.version}, try ${i + 1}: ${a.source} ${a.outcome} (${a.url})`));
        if (!got.ok) {
            const said = sources.map((s) => {
                const last = got.attempts.filter((a) => a.source === s.name).pop();
                return `${s.name} ${s.url}: ${last ? last.outcome : 'not tried'}`;
            }).join('; ');
            return { ok: false, reason: 'archive', detail: oneLine(`CONTROL not set up: git ${pin.version} could not be fetched with its pinned sha256 (${said})`).slice(0, 380), log };
        }
        const target = join(dir, pin.file);
        write(target, got.pkg);
        write(`${target}.sig`, got.sig);
        log.push(`held git ${pin.version} from ${got.from} (${got.url}): sha256 ${pin.sha256}, its signature's ${pin.sigSha256}; pacman checks the signature`);
        return { ok: true, plan, from: got.from, target, log };
    }
    // The pin is not below the repositories: the archive's listing, held below them (Tynn #968), as before the pin.
    const base = archiveBase(env);
    log.push(`held git: the pin ${pin.version} is not below the repositories' ${repoGit}; reading the archive's listing`);
    const listing = await readListing(fetchFn, `${base}/packages/g/git/`, options);
    if (listing === null) return { ok: false, reason: 'archive', detail: `CONTROL not set up: the Arch archive (${base}) could not be read`, log };
    const listed = heldBackOf(listing, repoGit);
    if (!listed) return { ok: false, reason: 'archive', detail: `CONTROL not set up: the Arch archive lists no git older than the repositories' ${repoGit}`, log };
    return { ok: true, plan: listed, from: 'archive listing', target: `${base}/packages/g/git/git-${listed.held}-x86_64.pkg.tar.zst`, log };
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

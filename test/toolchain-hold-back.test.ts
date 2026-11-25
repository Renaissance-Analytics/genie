import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error an .mjs script without types
import { HELD_GIT, archiveBase, fetchPinned, heldBackOf, holdBackCheck, holdBackLog, holdGitBack, pinnedPlan, pinnedSources, readListing, resolveHeldGit } from '../scripts/toolchain-hold-back.mjs';

/*
 * THE TOOLCHAIN ROW'S UPDATE CONTROL, AND AN ARCHIVE THAT IS DOWN (Tynn #968; gates 1122-000845-50ab63 and its control
 * 1122-012930-b9551f). The harness held git back from https://archive.archlinux.org, read once with no deadline and no
 * other try. When the archive could not be reached, git-update was a FAIL, a tracked row with a FAIL check fails, and so
 * every gate failed for an outage outside Genie. Now the listing is read with a deadline and one more try (and may come
 * from a mirror), and an archive that cannot be read makes the check BLOCKED by `archive`: an ENVIRONMENT blocker
 * (linux.sh TRACKED_ENV) that keeps the row TRACKED, is said in its note, and is never required to stay red.
 */
const root = join(__dirname, '..');
const LISTING = ['git-2.47.0-1-x86_64.pkg.tar.zst', 'git-2.9.5-1-x86_64.pkg.tar.zst', 'git-2.47.1-1-x86_64.pkg.tar.zst', 'git-2.47.1-1-x86_64.pkg.tar.zst.sig']
    .map((f) => `<a href="${f}">${f}</a>`).join('\n');

describe('holding git back', () => {
    it('the second newest by number, not by text, and the newest; with fewer than two, nothing to hold back to', () => {
        expect(heldBackOf(LISTING)).toEqual({ held: '2.47.0-1', newest: '2.47.1-1' });
        expect(heldBackOf('<a href="git-2.47.1-1-x86_64.pkg.tar.zst">x</a>')).toBeNull();
        expect(heldBackOf('')).toBeNull();
    });

    it("held back BELOW the version this machine's repositories have (Tynn #968): a newer pkgver than the repos' is no update Genie can offer", () => {
        // Measured on omarchy-genie (job 1125-191913-5de173): Omarchy's stable mirror has git 2.56.0-1 while the archive's
        // newest is 2.56.1-1. Held at 2.56.0-2 (the second newest), git was NEWER than anything pacman could install.
        const listing = ['2.53.0-1', '2.54.0-1', '2.55.0-1', '2.56.0-1', '2.56.0-2', '2.56.1-1'].map((v) => `<a href="git-${v}-x86_64.pkg.tar.zst">x</a>`).join('\n');
        expect(heldBackOf(listing, '2.56.0-1')).toEqual({ held: '2.55.0-1', newest: '2.56.0-1' });
        // The epoch is not part of the archive's file name; the pkgrel never makes an update `git --version` can see.
        expect(heldBackOf(listing, '1:2.56.0-3')).toEqual({ held: '2.55.0-1', newest: '1:2.56.0-3' });
        expect(heldBackOf(listing, '2.53.0-1')).toBeNull();
        expect(heldBackOf(listing)).toEqual({ held: '2.56.0-2', newest: '2.56.1-1' });
    });

    it('the archive is the Arch Linux Archive unless a job names a mirror', () => {
        expect(archiveBase({})).toBe('https://archive.archlinux.org');
        expect(archiveBase({ GENIE_ARCH_ARCHIVE: 'https://mirror.example/archive/' })).toBe('https://mirror.example/archive');
    });

    it('read with a deadline, and once more when the first read fails; nothing when neither answers', async () => {
        const asked: Array<AbortSignal | undefined> = [];
        let n = 0;
        const flaky = async (_url: string, init?: { signal?: AbortSignal }) => { asked.push(init?.signal); n += 1; if (n === 1) throw new Error('connect timeout'); return { ok: true, text: async () => LISTING }; };
        expect(await readListing(flaky, 'https://archive.example/packages/g/git/', { timeoutMs: 50 })).toBe(LISTING);
        expect(asked).toHaveLength(2);
        for (const s of asked) expect(s).toBeInstanceOf(AbortSignal);
        let tries = 0;
        const down = async () => { tries += 1; throw new Error('connect timeout'); };
        expect(await readListing(down, 'https://archive.example/packages/g/git/', { timeoutMs: 50 })).toBeNull();
        expect(tries).toBe(2);
        const refused = async () => ({ ok: false, text: async () => 'gone' });
        expect(await readListing(refused, 'https://archive.example/packages/g/git/', { timeoutMs: 50 })).toBeNull();
    });

    it('a read that never answers ends at its deadline', async () => {
        const hang = (_url: string, init?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))); });
        const at = Date.now();
        expect(await readListing(hang, 'https://archive.example/packages/g/git/', { timeoutMs: 40 })).toBeNull();
        expect(Date.now() - at).toBeLessThan(2_000);
    });

    it('wired: the row gets the held git through resolveHeldGit, and one it could not get is BLOCKED by archive, not a FAIL', () => {
        const row = readFileSync(join(root, 'scripts', 'toolchain-real-cdp.mjs'), 'utf8');
        expect(row).toMatch(/import \{ holdBackCheck, holdBackLog, holdGitBack, repoVersion, resolveHeldGit \} from '\.\/toolchain-hold-back\.mjs';/);
        // Held below the repositories' version (Tynn #968): the pin when it is below them, the archive's listing otherwise.
        expect(row).toMatch(/const got = await resolveHeldGit\(\{ fetchFn: fetch, env: process\.env, repoGit, dir: mkdtempSync\(join\(tmpdir\(\), 'tc968-pkg-'\)\), write: writeFileSync \}\);/);
        expect(row).toMatch(/for \(const line of got\.log\) say\(line\);/);
        expect(row).toMatch(/track\('git-update', 'BLOCKED', got\.reason, got\.detail\);/);
        expect(row).not.toMatch(/fetch\('https:\/\/archive\.archlinux\.org/);
        expect(row).not.toMatch(/readListing\(/);
    });
});

/*
 * THE HELD GIT, PINNED AND OURS (gate 1125-223010-b05ea9 on the beta.66 release commit 86baeb26): every row green but
 * linux/toolchain, 1 of 29 checks not passing, `git-update BLOCKED archive`, "the Arch archive (https://archive.archlinux.org)
 * could not be read". The control depended on a third-party website being up at gate time, so a release gate's verdict
 * did too. Now the harness holds git back to ONE pinned package (its version, and the sha256 of the package and of its
 * signature), fetched first from our own Azure blob (the test VMs' region) and only then, with retries, from the archive;
 * bytes that do not hash to the pin are never installed, whichever source served them. pacman -U then checks the
 * package's signature (the .sig beside it) against the machine's keyring. The archive's listing is read only when the pin
 * is not below the repositories' version.
 */
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const PKG = new TextEncoder().encode('a git package');
const SIG = new TextEncoder().encode('its signature');
const PIN = { version: '2.55.0-1', file: 'git-2.55.0-1-x86_64.pkg.tar.zst', sha256: sha(PKG), sigSha256: sha(SIG) };
const CACHE = 'https://cache.example/arch/git';
const ARCHIVE = 'https://archive.example/packages/g/git';
const SOURCES = [{ name: 'cache', url: `${CACHE}/${PIN.file}` }, { name: 'archive', url: `${ARCHIVE}/${PIN.file}` }];
type Init = { signal?: AbortSignal };
type Attempt = { source: string; url: string; outcome: string };
/** A fetch that serves `files` (url -> bytes), throws for `down` prefixes, and records every url it was asked for. */
function server(files: Record<string, Uint8Array>, down: string[] = []) {
    const asked: string[] = [];
    const signals: Array<AbortSignal | undefined> = [];
    const fetchFn = async (url: string, init?: Init) => {
        asked.push(url);
        signals.push(init?.signal);
        if (down.some((h) => url.startsWith(h))) throw new Error('connect timeout');
        const body = files[url];
        return body
            ? { ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength), text: async () => '' }
            : { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0), text: async () => 'not found' };
    };
    return { fetchFn, asked, signals };
}
const both = (base: string, pkg = PKG, sig = SIG) => ({ [`${base}/${PIN.file}`]: pkg, [`${base}/${PIN.file}.sig`]: sig });
const noWait = { sleep: async () => {}, timeoutMs: 50 };
const slash = (p: string) => p.split('\\').join('/');

describe('the held git: one pinned package, from our cache first, never installed unless it hashes to the pin', () => {
    it('the pin: the git below the repositories at the time, its file, and the sha256 of the package and of its signature', () => {
        expect(HELD_GIT).toEqual({
            version: '2.55.0-1',
            file: 'git-2.55.0-1-x86_64.pkg.tar.zst',
            sha256: 'fbb24f455cb1de1c004a76b5a4dab92e4a9137764fbc3bc46afe13b7a38814fe',
            sigSha256: '53c9abe5f6b7610b1f0c915f90e7a73f95fade7bd8d5ed9c53568575deae82ab',
        });
        expect(Object.isFrozen(HELD_GIT)).toBe(true);
    });

    it('the sources, in order: our Azure blob, then the archive; a job may name either', () => {
        expect(pinnedSources({}, HELD_GIT)).toEqual([
            { name: 'cache', url: 'https://genietestpkgs.blob.core.windows.net/arch/git/git-2.55.0-1-x86_64.pkg.tar.zst' },
            { name: 'archive', url: 'https://archive.archlinux.org/packages/g/git/git-2.55.0-1-x86_64.pkg.tar.zst' },
        ]);
        expect(pinnedSources({ GENIE_PKG_CACHE: 'https://cache.example/arch/', GENIE_ARCH_ARCHIVE: 'https://archive.example' }, PIN)).toEqual(SOURCES);
    });

    it("the pin is the held git only when its pkgver is BELOW the repositories' (an update `git --version` can see)", () => {
        expect(pinnedPlan(PIN, '2.56.0-1')).toEqual({ held: '2.55.0-1', newest: '2.56.0-1' });
        expect(pinnedPlan(PIN, '1:2.57.1-2')).toEqual({ held: '2.55.0-1', newest: '1:2.57.1-2' });
        expect(pinnedPlan(PIN, '2.55.0-3')).toBeNull();
        expect(pinnedPlan(PIN, '2.54.2-1')).toBeNull();
        expect(pinnedPlan(PIN, null)).toBeNull();
    });

    it('THE ARCHIVE DOWN: served by our cache at the first try, and the archive is never asked', async () => {
        const s = server(both(CACHE), ['https://archive.example']);
        const got = await fetchPinned(s.fetchFn, PIN, SOURCES, noWait);
        expect(got.ok).toBe(true);
        expect(got.from).toBe('cache');
        expect(sha(got.pkg)).toBe(PIN.sha256);
        expect(sha(got.sig)).toBe(PIN.sigSha256);
        expect(s.asked.length).toBeGreaterThan(0);
        expect(s.asked.every((u) => u.startsWith(CACHE))).toBe(true);
        for (const signal of s.signals) expect(signal).toBeInstanceOf(AbortSignal);
    });

    it('bytes that do not hash to the pin are refused, from any source, and the next source is tried', async () => {
        const s = server({ ...both(CACHE, new TextEncoder().encode('tampered')), ...both(ARCHIVE) });
        const got = await fetchPinned(s.fetchFn, PIN, SOURCES, noWait);
        expect(got.ok).toBe(true);
        expect(got.from).toBe('archive');
        const fromCache = (got.attempts as Attempt[]).filter((a) => a.source === 'cache');
        expect(fromCache).toHaveLength(3);
        for (const a of fromCache) expect(a.outcome).toMatch(/^sha256 [0-9a-f]{64} is not the pin$/);
        // A wrong signature file is refused too, and nothing is handed back.
        const badSig = server(both(CACHE, PKG, new TextEncoder().encode('other')));
        const refused = await fetchPinned(badSig.fetchFn, PIN, SOURCES, noWait);
        expect(refused.ok).toBe(false);
        expect(refused.pkg).toBeUndefined();
        expect(refused.sig).toBeUndefined();
        // Wrong everywhere: nothing.
        const bad = server({ ...both(CACHE, SIG), ...both(ARCHIVE, SIG) });
        expect((await fetchPinned(bad.fetchFn, PIN, SOURCES, noWait)).ok).toBe(false);
    });

    it('a source that fails is tried again after a wait, up to its tries; then the next; every try is kept', async () => {
        const waits: number[] = [];
        let n = 0;
        const files = server(both(CACHE));
        const flaky = async (url: string, init?: Init) => { n += 1; if (n <= 2) throw new Error('connect timeout'); return files.fetchFn(url, init); };
        const got = await fetchPinned(flaky, PIN, SOURCES, { ...noWait, waitMs: 7_000, sleep: async (ms: number) => { waits.push(ms); } });
        expect(got.ok).toBe(true);
        expect(got.from).toBe('cache');
        expect(waits).toEqual([7_000, 7_000]);
        expect((got.attempts as Attempt[]).map((a) => `${a.source} ${a.outcome === 'ok' ? 'ok' : 'failed'}`)).toEqual(['cache failed', 'cache failed', 'cache ok']);
        // Everything down: three tries of each, in order, then not ok.
        const down = server({}, ['https://']);
        const none = await fetchPinned(down.fetchFn, PIN, SOURCES, noWait);
        expect(none.ok).toBe(false);
        expect((none.attempts as Attempt[]).map((a) => a.source)).toEqual(['cache', 'cache', 'cache', 'archive', 'archive', 'archive']);
        expect(none.attempts[0].outcome).toContain('connect timeout');
        // A 404 is said as one.
        const gone = await fetchPinned(server({}).fetchFn, PIN, SOURCES, { ...noWait, tries: 1 });
        expect((gone.attempts as Attempt[]).map((a) => a.outcome)).toEqual(['http 404', 'http 404']);
    });

    it('a fetch that never answers ends at its deadline', async () => {
        const hang = (_url: string, init?: Init) => new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))); });
        const at = Date.now();
        const got = await fetchPinned(hang, PIN, SOURCES, { ...noWait, timeoutMs: 40 });
        expect(got.ok).toBe(false);
        expect(Date.now() - at).toBeLessThan(5_000);
    });

    it('resolveHeldGit: the pin below the repositories is written beside its signature and installed from that file; no listing is read', async () => {
        const s = server(both(CACHE), ['https://archive.example']);
        const written: Record<string, Uint8Array> = {};
        const env = { GENIE_PKG_CACHE: 'https://cache.example/arch', GENIE_ARCH_ARCHIVE: 'https://archive.example' };
        const got = await resolveHeldGit({ fetchFn: s.fetchFn, env, repoGit: '2.56.0-1', pin: PIN, dir: '/tmp/tc968-pkg-x', write: (p: string, b: Uint8Array) => { written[slash(p)] = b; }, ...noWait });
        expect(got.ok).toBe(true);
        expect(got.plan).toEqual({ held: '2.55.0-1', newest: '2.56.0-1' });
        expect(got.from).toBe('cache');
        expect(slash(got.target)).toBe(`/tmp/tc968-pkg-x/${PIN.file}`);
        expect(Object.keys(written).sort()).toEqual([`/tmp/tc968-pkg-x/${PIN.file}`, `/tmp/tc968-pkg-x/${PIN.file}.sig`]);
        expect(sha(written[`/tmp/tc968-pkg-x/${PIN.file}`])).toBe(PIN.sha256);
        expect(sha(written[`/tmp/tc968-pkg-x/${PIN.file}.sig`])).toBe(PIN.sigSha256);
        expect(s.asked.some((u) => u.endsWith('/packages/g/git/'))).toBe(false);
        // Every line it logs is a note, never a verdict linux.sh could read; it names the pin it verified.
        expect(got.log.length).toBeGreaterThan(0);
        for (const line of got.log as string[]) { expect(/^(TRACK|ROW) /.test(line)).toBe(false); expect(line).not.toMatch(/[\r\n]/); }
        expect(got.log.join('\n')).toContain(`sha256 ${PIN.sha256}`);
    });

    it('resolveHeldGit: the pin could not be fetched from either source: BLOCKED by archive, naming both and what each said', async () => {
        const env = { GENIE_PKG_CACHE: 'https://cache.example/arch', GENIE_ARCH_ARCHIVE: 'https://archive.example' };
        let wrote = 0;
        const got = await resolveHeldGit({ fetchFn: server({}, ['https://']).fetchFn, env, repoGit: '2.56.0-1', pin: PIN, dir: '/tmp/x', write: () => { wrote += 1; }, ...noWait });
        expect(got.ok).toBe(false);
        expect(wrote).toBe(0);
        expect(got.reason).toBe('archive');
        expect(got.detail).toMatch(/^CONTROL not set up: git 2\.55\.0-1 could not be fetched/);
        expect(got.detail).toContain(SOURCES[0].url);
        expect(got.detail).toContain(SOURCES[1].url);
        expect(got.detail).toContain('connect timeout');
        expect(got.detail).not.toMatch(/[\r\n]/);
    });

    it('resolveHeldGit: the pin NOT below the repositories: the archive listing, held below them, as before; and its failures said', async () => {
        const listing = ['2.56.0-1', '2.57.0-1', '2.57.1-1'].map((v) => `<a href="git-${v}-x86_64.pkg.tar.zst">x</a>`).join('\n');
        const listed = async (url: string) => ({ ok: url === `${ARCHIVE}/`, status: 200, text: async () => listing, arrayBuffer: async () => new ArrayBuffer(0) });
        const env = { GENIE_PKG_CACHE: 'https://cache.example/arch', GENIE_ARCH_ARCHIVE: 'https://archive.example' };
        const later = { ...PIN, version: '2.58.0-1' };
        const got = await resolveHeldGit({ fetchFn: listed, env, repoGit: '2.57.1-1', pin: later, dir: '/tmp/x', write: () => {}, ...noWait });
        expect(got).toMatchObject({ ok: true, from: 'archive listing', plan: { held: '2.57.0-1', newest: '2.57.1-1' }, target: `${ARCHIVE}/git-2.57.0-1-x86_64.pkg.tar.zst` });
        const unread = await resolveHeldGit({ fetchFn: server({}, ['https://']).fetchFn, env, repoGit: '2.57.1-1', pin: later, dir: '/tmp/x', write: () => {}, ...noWait });
        expect(unread).toMatchObject({ ok: false, reason: 'archive', detail: 'CONTROL not set up: the Arch archive (https://archive.example) could not be read' });
        const nothingBelow = await resolveHeldGit({ fetchFn: listed, env, repoGit: '2.56.0-1', pin: later, dir: '/tmp/x', write: () => {}, ...noWait });
        expect(nothingBelow).toMatchObject({ ok: false, reason: 'archive', detail: "CONTROL not set up: the Arch archive lists no git older than the repositories' 2.56.0-1" });
        const norepo = await resolveHeldGit({ fetchFn: listed, env, repoGit: null, pin: PIN, dir: '/tmp/x', write: () => {}, ...noWait });
        expect(norepo).toMatchObject({ ok: false, reason: 'archive', detail: "CONTROL not set up: this machine's repositories could not be read (checkupdates)" });
    });
});

/*
 * THE HELD-BACK INSTALL ITSELF (Tynn #968; gates 1123-141448-86241a and 1123-145302-8818fd, with the job 1123-152026-c7537c
 * that kept pacman's output). The listing was read, and then the harness's own `sudo pacman -U <held git>` exited non-zero
 * (19 s and 27 s, nothing installed) on two gates of one commit, and passed on a third run of the same commit and on another
 * PR's gate in between. The harness read only the exit status: pacman's words were kept nowhere, the check was FAIL/none,
 * and a tracked row with a FAIL check fails the gate. That step is the harness setting up its OWN control, as reading the
 * listing is: it is tried once more after a wait, pacman's output and status go into the row's log on every try, and when it
 * still cannot be set up the check is BLOCKED by `control` (an environment blocker) with pacman's words. Only that step:
 * every check that measures Genie is as strict as it was.
 */
const FAILED = { status: 1, signal: null, stdout: ':: Retrieving packages...\n git-2.56.0-2-x86_64 downloading...\n', stderr: 'error: failed retrieving file \'git-2.56.0-2-x86_64.pkg.tar.zst\' from archive.example : Operation too slow\nwarning: failed to retrieve some files\nerror: failed to commit transaction (download library error)\n' };
const INSTALLED = { status: 0, signal: null, stdout: ':: Processing package changes...\ninstalling git...\n', stderr: '' };
/** The row's other harness controls that are a FAIL with no reason when they cannot be set up: untouched by this. */
// 16 since Tynn #973: the keyring-elevation step's own control (gnome-keyring could not be removed) is one.
const FAIL_NONE_ELSEWHERE = 16;
const URL_HELD = 'https://archive.example/packages/g/git/git-2.56.0-2-x86_64.pkg.tar.zst';

describe('the held-back install: tried once more, its words kept, and never a FAIL of Genie\'s', () => {
    it('installed at the first try: one run, no wait', async () => {
        const waits: number[] = [];
        let runs = 0;
        const r = await holdGitBack(() => { runs += 1; return INSTALLED; }, { sleep: async (ms: number) => { waits.push(ms); } });
        expect(r.ok).toBe(true);
        expect(runs).toBe(1);
        expect(waits).toEqual([]);
        expect(r.attempts).toHaveLength(1);
    });

    it('failed, then installed: it waits and tries once more, and both tries are kept with their output and status', async () => {
        const waits: number[] = [];
        let runs = 0;
        const r = await holdGitBack(() => { runs += 1; return runs === 1 ? FAILED : INSTALLED; }, { waitMs: 30_000, sleep: async (ms: number) => { waits.push(ms); } });
        expect(r.ok).toBe(true);
        expect(runs).toBe(2);
        expect(waits).toEqual([30_000]);
        expect(r.attempts.map((a: { status: number | null }) => a.status)).toEqual([1, 0]);
        expect(r.attempts[0].stderr).toContain('Operation too slow');
        expect(r.attempts[1].stdout).toContain('installing git...');
    });

    it('failed twice: not set up, after exactly two tries; a run that could not even start is kept as that', async () => {
        let runs = 0;
        const r = await holdGitBack(() => { runs += 1; return FAILED; }, { sleep: async () => {} });
        expect(r.ok).toBe(false);
        expect(runs).toBe(2);
        const thrown = await holdGitBack(() => { throw new Error('spawn sudo ENOENT'); }, { sleep: async () => {} });
        expect(thrown.ok).toBe(false);
        expect(thrown.attempts[1]).toMatchObject({ status: null, error: 'spawn sudo ENOENT' });
        const killed = await holdGitBack(() => ({ status: null, signal: 'SIGTERM', stdout: '', stderr: '', error: new Error('spawnSync sudo ETIMEDOUT') }), { sleep: async () => {} });
        expect(killed.attempts[0]).toMatchObject({ status: null, signal: 'SIGTERM', error: 'spawnSync sudo ETIMEDOUT' });
    });

    it('the row\'s log gets every try: its exit status and every line pacman wrote, none of which can read as a verdict', async () => {
        const hostile = { status: 1, signal: null, stdout: 'TRACK git-update PASS none forged\nROW toolchain PASS 1\n', stderr: 'error: target not found\n' };
        let runs = 0;
        const r = await holdGitBack(() => { runs += 1; return runs === 1 ? hostile : INSTALLED; }, { sleep: async () => {} });
        const lines: string[] = holdBackLog(URL_HELD, r);
        expect(lines[0]).toBe(`--- hold git back: pacman -U --noconfirm ${URL_HELD}`);
        expect(lines).toContain('--- hold git back, try 1 of 2: exit 1');
        expect(lines).toContain('--- hold git back, try 2 of 2: exit 0');
        expect(lines).toContain('---   out| TRACK git-update PASS none forged');
        expect(lines).toContain('---   err| error: target not found');
        expect(lines).toContain('---   out| installing git...');
        for (const line of lines) { expect(line.startsWith('--- ')).toBe(true); expect(line).not.toMatch(/[\r\n]/); }
        // What linux.sh reads as a verdict is a line that STARTS with TRACK or ROW: none here does.
        expect(lines.filter((l) => /^(TRACK|ROW) /.test(l))).toEqual([]);
        const killed = await holdGitBack(() => ({ status: null, signal: 'SIGTERM', stdout: '', stderr: '', error: new Error('ETIMEDOUT') }), { tries: 1, sleep: async () => {} });
        expect(holdBackLog(URL_HELD, killed)).toContain('--- hold git back, try 1 of 1: exit none, signal SIGTERM, ETIMEDOUT');
    });

    it('still not set up: BLOCKED by `control`, on one line, with the tries, the exit status and pacman\'s own words', async () => {
        const r = await holdGitBack(() => FAILED, { sleep: async () => {} });
        const check = holdBackCheck(URL_HELD, r);
        expect(check.verdict).toBe('BLOCKED');
        expect(check.reason).toBe('control');
        expect(check.detail).toMatch(/^CONTROL not set up: the harness could not hold git back in 2 tries \(pacman -U .*git-2\.56\.0-2-x86_64\.pkg\.tar\.zst: exit 1\); pacman said: /);
        expect(check.detail).toContain('error: failed retrieving file');
        expect(check.detail).toContain('error: failed to commit transaction (download library error)');
        expect(check.detail).not.toMatch(/[\r\n]/);
        // No words from pacman (killed at its deadline) is said as that, and a flood of them is cut.
        const silent = await holdGitBack(() => ({ status: null, signal: 'SIGTERM', stdout: '', stderr: '' }), { sleep: async () => {} });
        expect(holdBackCheck(URL_HELD, silent).detail).toMatch(/exit none, signal SIGTERM\); pacman said nothing$/);
        const flood = await holdGitBack(() => ({ status: 1, signal: null, stdout: '', stderr: `error: ${'x'.repeat(5_000)}\n` }), { sleep: async () => {} });
        expect(holdBackCheck(URL_HELD, flood).detail.length).toBeLessThan(700);
    });

    it('wired: the row holds git back through this, prints every try, and reports a control it could not set up as BLOCKED by control', () => {
        const row = readFileSync(join(root, 'scripts', 'toolchain-real-cdp.mjs'), 'utf8');
        expect(row).toMatch(/const heldRun = url \? await holdGitBack\(\(\) => sudoP\('pacman', '-U', '--noconfirm', url\)\) : null;/);
        expect(row).toMatch(/const url = got\.ok \? got\.target : null;/);
        expect(row).toMatch(/if \(heldRun\) for \(const line of holdBackLog\(url, heldRun\)\) console\.log\(line\.replaceAll\(PW, '<password>'\)\);/);
        expect(row).toMatch(/const control = holdBackCheck\(url, heldRun\);\s+track\('git-update', control\.verdict, control\.reason, control\.detail\);/);
        // The old verdict is gone: the harness's own setup step is never a FAIL with no reason.
        expect(row).not.toMatch(/track\('git-update', 'FAIL'/);
        expect(row).not.toMatch(/could not hold git back \(pacman -U \$\{url\} failed\)/);
    });

    it('ONLY that step: `control` is given by the hold-back alone, and the checks that measure Genie are as strict as before', () => {
        const row = readFileSync(join(root, 'scripts', 'toolchain-real-cdp.mjs'), 'utf8');
        // No check in the row names the reason itself; it comes from holdBackCheck, used once.
        expect(row).not.toMatch(/'control'/);
        expect(row.split('holdBackCheck(').length - 1).toBe(1);
        // Genie not offering the update is RED, and an update that did not move git is RED (BLOCKED only when the elevated step never ran).
        expect(row).toMatch(/track\('git-update-offered', 'RED', 'pacman', `git \$\{before\?\.version \?\? '\?'\} held back from \$\{newest\}/);
        expect(row).toMatch(/track\('git-update', moved && steps\.length > 0 \? 'PASS' : r\.prompted \|\| r\.done \? 'RED' : 'BLOCKED', 'pacman',/);
        // The harness's other controls still FAIL when they cannot be set up as they always did.
        expect(row.split('\'FAIL\', \'none\'').length - 1).toBe(FAIL_NONE_ELSEWHERE);
    });
});

/*
 * THE VERDICT (linux.sh's own loop, between its markers, with stub rows, as test/ci-tracked-red-linux.test.ts runs it).
 */
const source = readFileSync(join(root, 'scripts', 'ci', 'linux.sh'), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('\n# >>> THE ROW LOOP');
const end = source.indexOf('\n# <<< THE ROW LOOP');
const loop = start > -1 && end > start ? source.slice(start + 1, end) : '';

function runLoop(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ci-env-blocker-linux-'));
    const script = `
set -uo pipefail
cd ${JSON.stringify(root)}
OUT=${JSON.stringify(dir)}; SETUP="$OUT/setup"; mkdir -p "$SETUP"
MACHINE_SAMPLES="$OUT/machine-samples.log"; : > "$MACHINE_SAMPLES"
failed=(); notes=(); infra=(); tracked=()
blocked=''; blocked_here=''; skip_reason=''
installed=''; electron_ok=''; built=''; built_why=''; display_ready=''; keyring_ready=''; app=''
ceiling() { echo 60; }
watchdog() { :; }
machine_line() { :; }
reap_leftovers() { :; }
stop_app() { :; }
block() { blocked="$1"; blocked_here=1; echo "--- $1"; return 1; }
ONE_SHOT_ROWS=""
declare -A TRACKED_RED=([envheld]="pacman:#968" [envred]="pacman:#968" [envfail]="pacman:#968" [plainheld]="pacman:#968")
TRACKED_ENV=" archive "
row_envheld() { echo "TRACK previews RED pacman no package manager found"; echo "TRACK git-update BLOCKED archive CONTROL: the Arch archive listing could not be read"; return 1; }
row_envred() { echo "TRACK previews RED pacman no package manager found"; echo "TRACK git-update RED archive it read red"; return 1; }
row_envfail() { echo "TRACK previews RED pacman no package manager found"; echo "TRACK git-update FAIL archive the control could not be set up"; return 1; }
row_plainheld() { echo "TRACK previews RED pacman no package manager found"; return 1; }
${loop}
selected=(envheld envred envfail plainheld)
run_rows
tracked_summary
echo "FAILED: \${failed[*]}"
`;
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 90000 });
    return `${r.stdout}${r.stderr}`;
}

describe.skipIf(process.platform !== 'linux')('linux.sh: an environment blocker (#968)', () => {
    const out = runLoop();
    it('a check BLOCKED by the archive keeps a tracked row TRACKED, and its note says so', () => {
        expect(out).toMatch(/^ROW envheld TRACKED \d+ \(known red: pacman #968; blocked by the environment: archive\)$/m);
    });
    it('the environment only ever BLOCKS: a check RED for it is an unlisted reason, and a FAIL is a FAIL', () => {
        expect(out).toMatch(/^ROW envred FAIL \d+ \(tracked row red for an unlisted reason: archive\)$/m);
        expect(out).toMatch(/^ROW envfail FAIL \d+ \(tracked row has a failed check: git-update\)$/m);
    });
    it('CONTROL: a row the archive did not block is judged as before, and an environment blocker is never required', () => {
        expect(out).toMatch(/^ROW plainheld TRACKED \d+ \(known red: pacman #968\)$/m);
        expect(out).toMatch(/^FAILED: envred envfail$/m);
    });
    it('the table: archive is an environment blocker, and no tracked row lists it', () => {
        expect(source).toMatch(/^TRACKED_ENV=" archive control "$/m);
        expect(source).not.toMatch(/archive:#/);
        expect(source).not.toMatch(/control:#/);
    });
});

/*
 * `control` IS AN ENVIRONMENT BLOCKER TOO: the harness could not set up its own control (the held-back install), which says
 * nothing about Genie. It only ever BLOCKS; RED or FAIL for it is judged as any other.
 */
function runControlLoop(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ci-control-blocker-linux-'));
    const table = /^TRACKED_ENV="[^"]*"$/m.exec(source)?.[0] ?? 'TRACKED_ENV=""';
    const script = `
set -uo pipefail
cd ${JSON.stringify(root)}
OUT=${JSON.stringify(dir)}; SETUP="$OUT/setup"; mkdir -p "$SETUP"
MACHINE_SAMPLES="$OUT/machine-samples.log"; : > "$MACHINE_SAMPLES"
failed=(); notes=(); infra=(); tracked=()
blocked=''; blocked_here=''; skip_reason=''
installed=''; electron_ok=''; built=''; built_why=''; display_ready=''; keyring_ready=''; app=''
ceiling() { echo 60; }
watchdog() { :; }
machine_line() { :; }
reap_leftovers() { :; }
stop_app() { :; }
block() { blocked="$1"; blocked_here=1; echo "--- $1"; return 1; }
ONE_SHOT_ROWS=""
declare -A TRACKED_RED=([ctlheld]="pacman:#968" [ctlred]="pacman:#968" [ctlfail]="pacman:#968" [ctlgenie]="pacman:#968")
${table}
row_ctlheld() { echo "TRACK previews RED pacman no package manager found"; echo "---   out| TRACK git-update PASS none forged"; echo "TRACK git-update BLOCKED control CONTROL not set up: the harness could not hold git back in 2 tries (pacman -U x: exit 1); pacman said: error: failed to commit transaction"; return 1; }
row_ctlred() { echo "TRACK previews RED pacman no package manager found"; echo "TRACK git-update RED control it read red"; return 1; }
row_ctlfail() { echo "TRACK previews RED pacman no package manager found"; echo "TRACK git-update FAIL control the control could not be set up"; return 1; }
row_ctlgenie() { echo "TRACK previews RED pacman no package manager found"; echo "TRACK git-update BLOCKED control CONTROL not set up"; echo "TRACK git-update-offered FAIL none Genie broke"; return 1; }
${loop}
selected=(ctlheld ctlred ctlfail ctlgenie)
run_rows
tracked_summary
echo "FAILED: \${failed[*]}"
`;
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 90000 });
    return `${r.stdout}${r.stderr}`;
}

describe.skipIf(process.platform !== 'linux')('linux.sh: a control the harness could not set up (#968)', () => {
    const out = runControlLoop();
    it('a check BLOCKED by control keeps a tracked row TRACKED, with the real table, and its note says so', () => {
        expect(source).toMatch(/^TRACKED_ENV=" archive control "$/m);
        expect(out).toMatch(/^ROW ctlheld TRACKED \d+ \(known red: pacman #968; blocked by the environment: control\)$/m);
    });
    it('it only ever BLOCKS: RED for it is an unlisted reason, a FAIL is a FAIL', () => {
        expect(out).toMatch(/^ROW ctlred FAIL \d+ \(tracked row red for an unlisted reason: control\)$/m);
        expect(out).toMatch(/^ROW ctlfail FAIL \d+ \(tracked row has a failed check: git-update\)$/m);
    });
    it('and it hides nothing of Genie\'s: a row with the control blocked AND a failed check of Genie\'s fails', () => {
        expect(out).toMatch(/^ROW ctlgenie FAIL \d+ \(tracked row has a failed check: git-update-offered\)$/m);
        expect(out).toMatch(/^FAILED: ctlred ctlfail ctlgenie$/m);
    });
});

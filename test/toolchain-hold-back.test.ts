import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error an .mjs script without types
import { archiveBase, heldBackOf, holdBackCheck, holdBackLog, holdGitBack, readListing } from '../scripts/toolchain-hold-back.mjs';

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

    it('wired: the row reads the listing through this, and an archive that cannot be read is BLOCKED by archive, not a FAIL', () => {
        const row = readFileSync(join(root, 'scripts', 'toolchain-real-cdp.mjs'), 'utf8');
        expect(row).toMatch(/import \{ archiveBase, heldBackOf, holdBackCheck, holdBackLog, holdGitBack, readListing \} from '\.\/toolchain-hold-back\.mjs';/);
        expect(row).toMatch(/const listing = await readListing\(fetch, `\$\{archiveBase\(process\.env\)\}\/packages\/g\/git\/`\);/);
        expect(row).toMatch(/track\('git-update', 'BLOCKED', 'archive', /);
        expect(row).not.toMatch(/fetch\('https:\/\/archive\.archlinux\.org/);
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

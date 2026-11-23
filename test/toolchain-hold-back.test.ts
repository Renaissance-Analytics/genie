import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error an .mjs script without types
import { archiveBase, heldBackOf, readListing } from '../scripts/toolchain-hold-back.mjs';

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
        expect(row).toMatch(/import \{ archiveBase, heldBackOf, readListing \} from '\.\/toolchain-hold-back\.mjs';/);
        expect(row).toMatch(/const listing = await readListing\(fetch, `\$\{archiveBase\(process\.env\)\}\/packages\/g\/git\/`\);/);
        expect(row).toMatch(/track\('git-update', 'BLOCKED', 'archive', /);
        expect(row).not.toMatch(/fetch\('https:\/\/archive\.archlinux\.org/);
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
        expect(source).toMatch(/^TRACKED_ENV=" archive "$/m);
        expect(source).not.toMatch(/archive:#/);
    });
});

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

/*
 * STALL-AWARE ROWS, LINUX (Tynn #660). linux.sh's row loop: a row that FAILS while the machine sampler recorded a stall
 * during it is marked INFRA and run once more, on the same machine; a row that fails without a stall is never run again;
 * a row that could not run because an earlier row's need failed is not this row's failure and is not run again either.
 * The summary names the INFRA rows and whether the rerun passed.
 *
 * This runs linux.sh's OWN loop (the block between `# >>> THE ROW LOOP` and `# <<< THE ROW LOOP`) with stub rows and
 * a samples file written here, and reads what it printed and how many times each row ran.
 */

const root = join(__dirname, '..');
const source = readFileSync(join(root, 'scripts', 'ci', 'linux.sh'), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('\n# >>> THE ROW LOOP');
const end = source.indexOf('\n# <<< THE ROW LOOP');
const loop = start > -1 && end > start ? source.slice(start + 1, end) : '';

/** Samples every 2 s from 60 s ago to 120 s ahead: stalled (io full 50 %) or quiet. */
function samples(stalled: boolean): string {
    const now = Date.now();
    const lines = [];
    for (let t = now - 60000; t <= now + 120000; t += 2000) {
        lines.push(`MACHINE ${t} gap=2000 cpu=4 steal=0 io_some=60 io_full=${stalled ? 50 : 0} mem_full=0 load=0.4`);
    }
    return lines.join('\n') + '\n';
}

function runLoop(samplesText: string | null): { out: string; count: (row: string) => number } {
    const dir = mkdtempSync(join(tmpdir(), 'ci-infra-linux-'));
    if (samplesText !== null) writeFileSync(join(dir, 'machine-samples.log'), samplesText);
    const script = `
set -uo pipefail
cd ${JSON.stringify(root)}
OUT=${JSON.stringify(dir)}; SETUP="$OUT/setup"; mkdir -p "$SETUP"
MACHINE_SAMPLES="$OUT/machine-samples.log"
failed=(); notes=(); infra=()
blocked=''; blocked_here=''; skip_reason=''
installed=''; electron_ok=''; built=''; built_why=''; display_ready=''; keyring_ready=''; app=''
ceiling() { echo 60; }
watchdog() { :; }
machine_line() { :; }
reap_leftovers() { :; }
stop_app() { :; }
block() { blocked="$1"; blocked_here=1; echo "--- $1"; return 1; }
ran() { echo x >> "$OUT/ran-$1"; }
row_ok() { ran ok; }
row_flaky() { ran flaky; [ "$(wc -l < "$OUT/ran-flaky")" -ge 2 ]; }
row_broken() { ran broken; echo "the broken row's own words"; return 1; }
row_cached() { ran cached; blocked='npm ci failed'; return 1; }
# A row whose own need fails in it (as need_build does): its rerun asks that need again, not its first failure.
row_needs() {
    ran needs
    if [ -n "$built" ]; then [ "$built" = ok ] && return 0; blocked="$built_why"; return 1; fi
    built=failed; built_why='the build failed'
    [ "$(wc -l < "$OUT/ran-needs")" -ge 2 ] && { built=ok; return 0; }
    block "$built_why"
}
${loop}
selected=(ok flaky broken cached needs)
run_rows
infra_summary
echo "FAILED: \${failed[*]}"
`;
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 60000 });
    const out = `${r.stdout}${r.stderr}`;
    const count = (row: string) => (existsSync(join(dir, `ran-${row}`)) ? readFileSync(join(dir, `ran-${row}`), 'utf8').trim().split('\n').length : 0);
    return { out, count };
}

describe.skipIf(process.platform !== 'linux')('linux.sh: stall-aware rows', () => {
    it('has the loop between its markers', () => {
        expect(loop).toMatch(/\nrun_rows\(\) \{/);
        expect(loop).toMatch(/\ninfra_summary\(\) \{/);
    });

    describe('the machine stalled during the rows', () => {
        let out = '';
        let count: (row: string) => number = () => -1;
        beforeAll(() => { ({ out, count } = runLoop(samples(true))); });
        it('a row that failed during the stall is marked INFRA, run once more, and passes on its rerun', () => {
            expect(out).toMatch(/^INFRA flaky FAIL \d+: the machine stalled during the row \(STALL io /m);
            expect(count('flaky')).toBe(2);
            expect(out).toMatch(/^ROW flaky PASS \d+ \(INFRA: the first run failed during a machine stall; the rerun passed\)$/m);
        });
        it('a row that fails again is run ONCE more only, and fails, saying so', () => {
            expect(count('broken')).toBe(2);
            expect(out).toMatch(/^ROW broken FAIL \d+ \(INFRA: the first run failed during a machine stall; the rerun failed too\)$/m);
        });
        it('a row blocked by an earlier need is not its own failure: not INFRA, not rerun', () => {
            expect(count('cached')).toBe(1);
            expect(out).not.toMatch(/^INFRA cached/m);
            expect(out).toMatch(/^ROW cached FAIL \d+ \(not run: npm ci failed\)$/m);
        });
        it('a row whose own need failed in it is rerun with that need asked again', () => {
            expect(count('needs')).toBe(2);
            expect(out).toMatch(/^ROW needs PASS \d+ \(INFRA: the first run failed during a machine stall; the rerun passed\)$/m);
        });
        it('a passing row runs once', () => {
            expect(count('ok')).toBe(1);
            expect(out).toMatch(/^ROW ok PASS \d+$/m);
        });
        it('the summary names the INFRA rows and their reruns; the run fails on the rows that failed in the end', () => {
            expect(out).toMatch(/^INFRA ROWS: flaky \(rerun PASS\) broken \(rerun FAIL\) needs \(rerun PASS\)$/m);
            expect(out).toMatch(/^FAILED: broken cached$/m);
        });
    });

    describe('CONTROL: the machine did not stall', () => {
        let out = '';
        let count: (row: string) => number = () => -1;
        beforeAll(() => { ({ out, count } = runLoop(samples(false))); });
        it('a failed row is never rerun: each ran once, and the failure is the row\'s', () => {
            expect(count('flaky')).toBe(1);
            expect(count('broken')).toBe(1);
            expect(count('needs')).toBe(1);
            expect(out).toMatch(/^ROW flaky FAIL \d+$/m);
            expect(out).toMatch(/^ROW broken FAIL \d+$/m);
            expect(out).not.toMatch(/^INFRA \S+ FAIL/m);
        });
        it('says the sampler saw no stall, with the count of samples it read (the gauge)', () => {
            expect(out).toMatch(/^NO STALL in \d+ samples/m);
        });
        it('the summary says there were no INFRA rows', () => {
            expect(out).toMatch(/^INFRA ROWS: none$/m);
            expect(out).toMatch(/^FAILED: flaky broken cached needs$/m);
        });
    });

    describe('no sampler ran', () => {
        let out = '';
        let count: (row: string) => number = () => -1;
        beforeAll(() => { ({ out, count } = runLoop(null)); });
        it('nothing is rerun, and the missing samples are said', () => {
            expect(count('flaky')).toBe(1);
            expect(out).toMatch(/NO SAMPLES/);
        });
    });
});

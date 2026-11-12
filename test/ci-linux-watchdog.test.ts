import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * A ROW'S WATCHDOG ENDS WITH ITS ROW (Tynn issue #709). scripts/ci/linux.sh starts `watchdog` in the background for every
 * row and kills it when the row ends. Killing the watchdog's subshell left its `sleep <ceiling>` running, reparented to
 * init, still holding the script's stdout: a gate run over SSH (omarchy-run.sh, the Azure Linux job) returned 10 to 30
 * minutes after its last row, waiting for the longest leftover sleep. This runs the script's own `watchdog`, kills it
 * the way the row loop does, and asks whether the output closes.
 */

const LIMIT = 4321; // a ceiling no other process on the machine sleeps for, so the leftover can be found and ended.
const source = readFileSync(new URL('../scripts/ci/linux.sh', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('\nwatchdog() {');
const end = source.indexOf('\n}\n', start);
const watchdogFn = start > -1 && end > -1 ? source.slice(start + 1, end + 2) : '';

const script = (fn: string) => `
${fn}
app_tree() { :; }
tree_of() { :; }
T="$(mktemp -d)"
watchdog row ${LIMIT} "$T/mark" tok &
w=$!
sleep 0.3
kill "$w" 2>/dev/null; wait "$w" 2>/dev/null
echo done
`;

/** Runs the script; resolves with the ms until every one of its outputs closed, or null if they were still open at the limit. */
function closesWithin(text: string, ms: number): Promise<number | null> {
    return new Promise((resolve) => {
        const t0 = Date.now();
        const child = spawn('bash', ['-c', text], { stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.resume();
        child.stderr.resume();
        const timer = setTimeout(() => resolve(null), ms);
        child.on('close', () => { clearTimeout(timer); resolve(Date.now() - t0); });
    });
}

const linux = process.platform === 'linux';

describe.skipIf(!linux)('linux.sh: a killed watchdog leaves nothing holding the gate open', () => {
    afterAll(() => { spawnSync('pkill', ['-f', `sleep ${LIMIT}`]); });

    it('finds the watchdog in linux.sh', () => {
        expect(watchdogFn).toMatch(/^watchdog\(\) \{/);
    });

    it('CONTROL: a background sleep that keeps the output does hold it open (the gauge can see the failure)', async () => {
        const held = await closesWithin(`sleep ${LIMIT} & sleep 0.3; echo done`, 3000);
        expect(held).toBeNull();
        spawnSync('pkill', ['-f', `sleep ${LIMIT}`]);
    });

    it('killing the watchdog the way the row loop does closes the output at once', async () => {
        const closed = await closesWithin(script(watchdogFn), 5000);
        expect(closed).not.toBeNull();
        expect(closed!).toBeLessThan(5000);
    });

    it('and leaves no sleep of the ceiling running', async () => {
        spawnSync('pkill', ['-f', `sleep ${LIMIT}`]);
        await closesWithin(script(watchdogFn), 5000);
        const left = spawnSync('pgrep', ['-f', `sleep ${LIMIT}`]).stdout.toString().trim();
        expect(left).toBe('');
    });
});

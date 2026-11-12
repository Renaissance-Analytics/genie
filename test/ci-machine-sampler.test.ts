import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: a plain .mjs script, imported for its functions
import { parseSamples } from '../scripts/ci/stall.mjs';
import { linuxSh, windowsPs1 } from './helpers/ci-scripts.js';

/*
 * THE MACHINE SAMPLER (Tynn #660): beside every row of both gates, one MACHINE line every ~2 s into
 * ci-out/machine-samples.log, which scripts/ci/stall.mjs reads to tell a machine stall from a row's own failure. It must
 * write what stall.mjs reads, end with the gate (it watches the gate's pid), and survive a row's watchdog, which ends
 * every other process the gate started.
 */

const root = join(__dirname, '..');

/** Runs the sampler beside a stand-in parent for ~5 s, then ends the parent; resolves with the samples and how long the sampler outlived it. */
function sample(cmd: string, args: (out: string, parent: number) => string[]): Promise<{ text: string; outlivedMs: number | null }> {
    return new Promise((resolve) => {
        const dir = mkdtempSync(join(tmpdir(), 'ci-sampler-'));
        const out = join(dir, 'machine-samples.log');
        const parent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
        const sampler = spawn(cmd, args(out, parent.pid!), { cwd: root, stdio: 'ignore' });
        let killedAt = 0;
        const limit = setTimeout(() => { sampler.kill(); resolve({ text: existsSync(out) ? readFileSync(out, 'utf8') : '', outlivedMs: null }); }, 30000);
        sampler.on('exit', () => {
            clearTimeout(limit);
            resolve({ text: existsSync(out) ? readFileSync(out, 'utf8') : '', outlivedMs: killedAt ? Date.now() - killedAt : -1 });
        });
        setTimeout(() => { killedAt = Date.now(); parent.kill(); }, 15000);
    });
}

describe.skipIf(process.platform !== 'linux')('machine-sampler.sh', () => {
    it('writes MACHINE lines stall.mjs reads (time, gap, CPU, steal, PSI) and ends within ~4 s of its gate', async () => {
        const { text, outlivedMs } = await sample('bash', (out, parent) => ['scripts/ci/machine-sampler.sh', out, String(parent), '1']);
        const s = parseSamples(text);
        expect(s.length).toBeGreaterThanOrEqual(3);
        for (const k of ['cpu', 'steal', 'io_full', 'mem_full']) expect(s[s.length - 1].f).toHaveProperty(k);
        expect(s[s.length - 1].gap).toBeGreaterThan(500);
        expect(outlivedMs).not.toBeNull();
        expect(outlivedMs!).toBeLessThan(4000);
    }, 40000);
});

describe.skipIf(process.platform !== 'win32')('machine-sampler.ps1', () => {
    it('writes MACHINE lines stall.mjs reads (time, gap, disk queue, CPU) and ends within ~6 s of its gate', async () => {
        const { text, outlivedMs } = await sample('powershell', (out, parent) => ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/ci/machine-sampler.ps1', '-Out', out, '-ParentId', String(parent), '-Interval', '1']);
        const s = parseSamples(text);
        // The first reads can be slow (a counter source that fails, then the CIM one), so ~15 s and at least three.
        expect(s.length, text).toBeGreaterThanOrEqual(3);
        const last = s[s.length - 1];
        expect(last.f, text).toHaveProperty('disk_q');
        expect(last.f, text).toHaveProperty('cpu');
        expect(last.gap).toBeGreaterThan(500);
        expect(outlivedMs).not.toBeNull();
        expect(outlivedMs!).toBeLessThan(6000);
    }, 40000);
});

describe('both gates run the sampler for the whole run, out of the watchdog\'s reach', () => {
    it('linux.sh starts it on the gate\'s pid into ci-out/machine-samples.log, and its watchdog spares it', () => {
        expect(linuxSh).toMatch(/MACHINE_SAMPLES="\$OUT\/machine-samples\.log"/);
        expect(linuxSh).toMatch(/scripts\/ci\/machine-sampler\.sh "\$MACHINE_SAMPLES" "\$\$"/);
        expect(linuxSh).toMatch(/keep=" \$BASHPID \$\(tree_of "\$SAMPLER_PID" \| tr '\\n' ' '\)/);
    });
    it('windows.ps1 starts it on its own pid into ci-out\\machine-samples.log, and its watchdog spares it', () => {
        expect(windowsPs1).toMatch(/\$MachineSamples = Join-Path \$Out 'machine-samples\.log'/);
        expect(windowsPs1).toMatch(/scripts\/ci\/machine-sampler\.ps1', '-Out', \$MachineSamples, '-ParentId', \$PID/);
        expect(windowsPs1).toMatch(/\$_\.ProcessId -ne \$sampler/);
    });
});

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

/**
 * THE HOST'S TLS UNDER THE NODE IT REALLY RUNS ON (P3.4 cut c). Electron's Node is built on BoringSSL. Plain Node passing says nothing
 * about it, and Electron never runs on the owner's desktop, so this runs where the binary is and a test may spawn it: CI, or a test
 * VM (`scripts/perf-lag/host-tls-measure.mjs`, which prints what it found, including whether the OS store could be read).
 */
const electron = createRequire(import.meta.url)('electron') as string;
const allowed = process.env.CI === 'true' || process.env.CI === '1';

describe.runIf(allowed)('under Electron’s own Node', () => {
    it('the binary is there: a skip here would be silence', () => {
        expect(existsSync(electron), electron).toBe(true);
    });

    it('every check of the measure passes', () => {
        const run = spawnSync(process.execPath, ['scripts/perf-lag/host-tls-measure.mjs'], { encoding: 'utf8', timeout: 150_000 });
        const out = `${run.stdout}\n${run.stderr}`;
        console.log(out.split('\n').filter((l) => l.startsWith('### host-tls')).join('\n'));
        // CONTROL: it really ran under Electron, and told which.
        expect(out).toMatch(/### host-tls really-under-electron=PASS/);
        expect(out).toMatch(/### host-tls=PASS/);
        expect(run.status).toBe(0);
    }, 180_000);
});

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * THE WINDOWS RUNNER'S OWN LOAD, MET IN CI ONLY (#1636's sampler: svchost[StorSvc] — the Storage Service — and TiWorker,
 * Windows Update servicing, busy, with a disk queue up to 12, beside the suite's intermittent EBUSY and slow read-backs;
 * Defender's own CPU there is its maintenance work: GitHub's image already excludes C:\ and D:\ from its scans). A test
 * that waits for something it wrote to read back from disk gives Windows its own budget (helpers/read-back.ts), never
 * vi.waitFor's 1 s default. The sampler stays beside unit (windows) (test/ci-windows-sampler.test.ts).
 */

describe('a read-back wait has a Windows budget', () => {
    it('no test waits for a store it wrote to read back with vi.waitFor\'s 1 s default', () => {
        const tests = readdirSync('test').filter((f) => /\.test\.tsx?$/.test(f));
        const bare = tests.flatMap((f) => readFileSync(join('test', f), 'utf8').split(/\r?\n/)
            .filter((l) => /vi\.waitFor\(async \(\) => expect\(\(await [A-Za-z]+\.open\(/.test(l) && !/\)\)\.to[A-Za-z]+\([^)]*\), [A-Za-z_{]/.test(l))
            .map((l) => `${f}: ${l.trim().slice(0, 120)}`));
        expect(bare).toEqual([]);
    });
    it('CONTROL: the rule finds such a wait where one is (tray-residence\'s, with its budget)', () => {
        const tray = readFileSync('test/tray-residence.test.ts', 'utf8');
        expect(tray.match(/vi\.waitFor\(async \(\) => expect\(\(await SettingsStore\.open\(dir\)\)[^\n]*READ_BACK_WAIT\)/g)?.length).toBe(3);
    });
});

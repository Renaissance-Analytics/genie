import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * THE WINDOWS RUNNER'S OWN LOAD, MET IN CI ONLY (#1636's sampler: svchost[StorSvc], TiWorker and Defender busy, a disk
 * queue to 12, beside the suite's intermittent EBUSY and slow read-backs). Two mitigations, held here:
 *  - the Windows jobs that run tests exclude the temp folders from Defender's real-time scan, on the runner only — never
 *    a product change, never on a person's machine;
 *  - a test that waits for something it wrote to read back from disk gives Windows its own budget (helpers/read-back.ts),
 *    never vi.waitFor's 1 s default.
 * The sampler stays beside unit (windows) (test/ci-windows-sampler.test.ts).
 */
const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
/** A job's text: from its name to the next job (or the file's end, for the last one). */
const jobOf = (name: string, next: string) => { const at = ci.indexOf(`name: ${name}`); const end = ci.indexOf(next, at); return ci.slice(at, end < 0 ? ci.length : end); };

describe('Defender leaves the runner\'s temp folders alone, in CI only', () => {
    for (const [name, next] of [['unit (windows)', '\n  zip64:'], ['a real window (windows)', '\n  # (the last job)']] as const) {
        it(`${name}: the exclusion runs before the tests, and says what it did`, () => {
            const job = jobOf(name, next);
            const step = job.indexOf('Defender skips the runner\'s temp folders');
            expect(step).toBeGreaterThan(0);
            expect(job.slice(step)).toMatch(/Add-MpPreference -ExclusionPath \$env:TEMP, \$env:RUNNER_TEMP/);
            // Before anything writes there: the first npm step comes after it.
            expect(step).toBeLessThan(job.indexOf('npm ci'));
        });
    }
    it('nowhere in the product', () => {
        const src = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? src(join(dir, e.name)) : [join(dir, e.name)]));
        expect(src('src').filter((f) => /MpPreference/.test(readFileSync(f, 'utf8')))).toEqual([]);
    });
});

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

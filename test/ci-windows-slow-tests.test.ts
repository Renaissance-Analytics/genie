import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { linuxRow, windowsFunction } from './helpers/ci-scripts.js';

/*
 * THE SLOW-TEST TABLE AFTER `unit (windows)`, OBSERVE ONLY (scripts/ci/slow-tests.mjs). Rows keep failing at the 30 s
 * Windows budget in different places (tray-residence, knowledge-paged-reads, carry-over-over-the-link), and we only learn
 * a row is near the edge when it crosses it. After every run, pass or fail, the job prints the 15 slowest tests, every
 * test over a third of the budget (10 s), and every FILE whose time outside its tests (its setup and hooks; vitest's JSON
 * report has no hook timings) is over 10 s, and uploads the full table. It changes no test and no budget, and it can
 * never fail the job.
 */
let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });

type Row = { title: string; ms: number | null; status?: string };
type File = { name: string; start: number; end: number; tests: Row[] };

function run(report: unknown | string | null): { out: string; table: string | null; code: number } {
    dir = mkdtempSync(join(tmpdir(), 'slow-tests-'));
    const results = join(dir, 'vitest.json');
    const table = join(dir, 'slow-tests.tsv');
    if (report !== null) writeFileSync(results, typeof report === 'string' ? report : JSON.stringify(report));
    let out = '';
    let code = 0;
    try {
        out = execFileSync(process.execPath, ['scripts/ci/slow-tests.mjs', results, table], { encoding: 'utf8' });
    } catch (error) {
        const e = error as { status?: number; stdout?: string };
        code = e.status ?? 1;
        out = e.stdout ?? '';
    }
    return { out, table: existsSync(table) ? readFileSync(table, 'utf8') : null, code };
}

function report(files: File[]) {
    return {
        testResults: files.map((f) => ({
            name: `D:\\a\\genie\\genie\\test\\${f.name}`,
            status: 'passed',
            startTime: f.start,
            endTime: f.end,
            assertionResults: f.tests.map((t) => ({ fullName: t.title, title: t.title, status: t.status ?? 'passed', duration: t.ms })),
        })),
    };
}

describe('the slow-test table', () => {
    it('prints the 15 slowest tests, slowest first, with their file and time', () => {
        const tests = Array.from({ length: 20 }, (_, i) => ({ title: `row ${i}`, ms: (i + 1) * 100 }));
        const { out, code } = run(report([{ name: 'a.test.ts', start: 0, end: 60_000, tests }]));
        expect(code).toBe(0);
        const lines = out.split(/\r?\n/).filter((l) => /^### +\d+\. /.test(l));
        expect(lines).toHaveLength(15);
        expect(lines[0]).toMatch(/^### +1\. +2\.0 s +test\/a\.test\.ts > row 19$/);
        expect(lines[14]).toMatch(/^### +15\. +0\.6 s +test\/a\.test\.ts > row 5$/);
    });

    it('lists EVERY test over 10 s, beyond the top 15, and says when there are none', () => {
        const tests = Array.from({ length: 18 }, (_, i) => ({ title: `slow ${i}`, ms: 10_001 + i }));
        const many = run(report([{ name: 'b.test.ts', start: 0, end: 400_000, tests }]));
        const over = many.out.split(/\r?\n/).filter((l) => /^### over 10 s: /.test(l));
        expect(over).toHaveLength(18);
        expect(many.out).toMatch(/^### 18 test\(s\) over 10 s \(a third of the 30 s budget\)$/m);
        const none = run(report([{ name: 'c.test.ts', start: 0, end: 1_000, tests: [{ title: 'quick', ms: 50 }] }]));
        expect(none.out).toMatch(/^### 0 test\(s\) over 10 s \(a third of the 30 s budget\)$/m);
    });

    it('names a file whose time OUTSIDE its tests (setup and hooks) is over 10 s, and not one that is all tests', () => {
        const { out } = run(report([
            { name: 'heavy-setup.test.ts', start: 0, end: 40_000, tests: [{ title: 'one', ms: 2_000 }, { title: 'two', ms: 3_000 }] },
            { name: 'all-tests.test.ts', start: 0, end: 25_000, tests: [{ title: 'long', ms: 24_000 }] },
        ]));
        expect(out).toMatch(/^### outside its tests over 10 s: +35\.0 s +test\/heavy-setup\.test\.ts \(file 40\.0 s, tests 5\.0 s\)$/m);
        expect(out).not.toMatch(/outside its tests over 10 s: .*all-tests/);
    });

    it('writes the full table, every test, slowest first, as tab-separated rows; skipped tests have no time and come last', () => {
        const { table } = run(report([{ name: 'd.test.ts', start: 0, end: 5_000, tests: [{ title: 'fast', ms: 10 }, { title: 'skipped', ms: null, status: 'skipped' }, { title: 'slow', ms: 900 }] }]));
        expect(table).not.toBeNull();
        expect(table!.split(/\r?\n/).filter(Boolean)).toEqual([
            'ms\tstatus\tfile\ttest',
            '900\tpassed\ttest/d.test.ts\tslow',
            '10\tpassed\ttest/d.test.ts\tfast',
            '\tskipped\ttest/d.test.ts\tskipped',
        ]);
    });

    it('never fails the job: no results file, or one that is not JSON, says so and exits 0', () => {
        const missing = run(null);
        expect(missing.code).toBe(0);
        expect(missing.out).toMatch(/^### slow tests: no results to read/m);
        const broken = run('{not json');
        expect(broken.code).toBe(0);
        expect(broken.out).toMatch(/^### slow tests: no results to read/m);
    });
});

describe('both unit rows run it after the suite, whatever happened, and it changes nothing else (scripts/ci)', () => {
    it('windows.ps1: after the suite, on pass or fail, and its own exit is not the row\'s', () => {
        const row = windowsFunction('Row-unit');
        const suite = row.indexOf('npm test -- --testTimeout=30000');
        const table = row.indexOf("node scripts/ci/slow-tests.mjs $results (Join-Path $Out 'slow-tests.tsv')");
        expect(suite).toBeGreaterThan(-1);
        expect(table, 'after the suite').toBeGreaterThan(suite);
        // The row's result is the suite's exit code, read before the table runs.
        expect(row.indexOf('$code = $LASTEXITCODE')).toBeLessThan(table);
        expect(row.slice(table)).toMatch(/if \(\$code -ne 0\) \{ throw "npm test failed/);
    });
    it('linux.sh: the same, and the table cannot fail the row', () => {
        const row = linuxRow('unit');
        expect(row).toMatch(/node scripts\/ci\/slow-tests\.mjs "\$OUT\/vitest-results\.json" "\$OUT\/slow-tests\.tsv" \|\| true/);
        expect(row).toMatch(/return "\$code"/);
    });
    it('the Windows suite itself is unchanged: the same command, the same 30 s budget', () => {
        expect(windowsFunction('Row-unit')).toMatch(/npm test -- --testTimeout=30000 --hookTimeout=30000 --reporter=default --reporter=json "--outputFile\.json=\$results"/);
    });
});

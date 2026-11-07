#!/usr/bin/env node
/**
 * THE SLOW-TEST TABLE AFTER `unit (windows)`, OBSERVE ONLY (test/ci-windows-slow-tests.test.ts holds it).
 *
 *   node scripts/ci/slow-tests.mjs <vitest-results.json> <slow-tests.tsv>
 *
 * Rows keep failing at the 30 s Windows budget in different places, and a row near the edge is only seen when it crosses
 * it. So after every run, pass or fail, this prints:
 *   - the 15 slowest tests, slowest first;
 *   - every test over 10 s, a third of the budget;
 *   - every file whose time OUTSIDE its tests is over 10 s: its setup and hooks (vitest's JSON report has no hook
 *     timings, so this is the file's wall time less its tests' time, which also takes in the file's import);
 * and writes every test to the TSV (ms, status, file, test), slowest first, for the uploaded artifact.
 * It changes no test and no budget, and it never fails the job: a missing or unreadable report is said and exits 0.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const BUDGET_MS = 30_000;
const OVER_MS = BUDGET_MS / 3;
const TOP = 15;

const [resultsFile, tableFile] = process.argv.slice(2);
const sec = (ms) => (ms / 1000).toFixed(1);
const fileName = (name) => String(name ?? '?').replace(/^.*[\\/]test[\\/]/, 'test/').replace(/\\/g, '/');

try {
    let report = null;
    try { report = JSON.parse(readFileSync(resultsFile, 'utf8')); } catch { report = null; }
    if (!report || !Array.isArray(report.testResults)) {
        console.log(`### slow tests: no results to read at ${resultsFile ?? '(none given)'} (the suite may not have started)`);
        process.exit(0);
    }
    const tests = [];
    const outside = [];
    for (const f of report.testResults) {
        const file = fileName(f.name);
        let inTests = 0;
        for (const a of f.assertionResults ?? []) {
            const ms = typeof a.duration === 'number' && Number.isFinite(a.duration) ? a.duration : null;
            if (ms !== null) inTests += ms;
            tests.push({ ms, status: String(a.status ?? '?'), file, title: String(a.fullName || a.title || '?').replace(/[\t\r\n]+/g, ' ') });
        }
        const wall = typeof f.startTime === 'number' && typeof f.endTime === 'number' ? f.endTime - f.startTime : null;
        if (wall !== null && wall - inTests > OVER_MS) outside.push({ file, wall, inTests, outside: wall - inTests });
    }
    tests.sort((a, b) => (b.ms ?? -1) - (a.ms ?? -1));

    console.log(`### slowest ${Math.min(TOP, tests.length)} of ${tests.length} tests`);
    tests.filter((t) => t.ms !== null).slice(0, TOP).forEach((t, i) => {
        console.log(`### ${String(i + 1).padStart(2)}. ${sec(t.ms).padStart(6)} s  ${t.file} > ${t.title}`);
    });
    const over = tests.filter((t) => t.ms !== null && t.ms > OVER_MS);
    console.log(`### ${over.length} test(s) over ${sec(OVER_MS).replace(/\.0$/, '')} s (a third of the ${BUDGET_MS / 1000} s budget)`);
    for (const t of over) console.log(`### over 10 s: ${sec(t.ms).padStart(6)} s  ${t.file} > ${t.title}`);
    outside.sort((a, b) => b.outside - a.outside);
    console.log(`### ${outside.length} file(s) over 10 s outside their tests (setup, hooks, import)`);
    for (const o of outside) console.log(`### outside its tests over 10 s: ${sec(o.outside).padStart(6)} s  ${o.file} (file ${sec(o.wall)} s, tests ${sec(o.inTests)} s)`);

    if (tableFile) {
        const rows = ['ms\tstatus\tfile\ttest', ...tests.map((t) => `${t.ms === null ? '' : Math.round(t.ms)}\t${t.status}\t${t.file}\t${t.title}`)];
        writeFileSync(tableFile, `${rows.join('\n')}\n`);
        console.log(`### the full table: ${tableFile}`);
    }
} catch (error) {
    // Observe only: whatever went wrong here is said, and the job's result is the suite's.
    console.log(`### slow tests: the table could not be made: ${error instanceof Error ? error.message : String(error)}`);
}
process.exit(0);

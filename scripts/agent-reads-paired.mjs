#!/usr/bin/env node
/** Opt-in paired M4-M6 measurement. Build the full app first; run only on the approved test VMs (Tynn #564). */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquirePairedRuns } from './agent-reads-acquire.mjs';
import { comparePairedRuns } from './agent-reads-compare.mjs';
import { readMeasurementIdentity, runMeasurementProcess } from './agent-reads-process.mjs';
import { refuseOffTestMachines } from './crash-cdp-lib.mjs';

export async function runPairedMeasurement({ outDir }) {
    refuseOffTestMachines('agent-reads-paired');
    if (typeof outDir !== 'string' || outDir.length === 0) throw new Error('a fresh output directory is required');
    const output = resolve(outDir), cwd = process.cwd();
    await mkdir(output, { recursive: false }); // Existing evidence is never reused or overwritten by another job.
    const identity = readMeasurementIdentity(randomUUID());
    const summary = { identity, pass: false, finished: false, verdicts: [] };
    const save = (name, value) => writeFile(join(output, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    try {
        for (const candidateMode of ['door', 'door-revision']) {
            const report = await acquirePairedRuns({
                identity, candidateMode, pairCount: 3,
                runSample: (request) => runMeasurementProcess({ request, cwd, out: join(output, `${candidateMode}-pair-${request.pairIndex}-${request.mode}.json`) }),
                checkpoint: (partial) => save(`${candidateMode}.json`, partial),
            });
            const rows = comparePairedRuns(report);
            const verdict = { candidateMode, pass: rows.length > 0 && rows.every((row) => row.pass), rows };
            await save(`${candidateMode}-verdict.json`, verdict);
            summary.verdicts.push(verdict);
            if (!verdict.pass) {
                summary.finished = true;
                await save('summary.json', summary);
                return summary; // Report the failed bound; do not start a different candidate or change course.
            }
            await save('summary.json', summary); // Remains pass:false until BOTH candidates completed and passed.
        }
        summary.finished = true; summary.pass = true;
        await save('summary.json', summary);
        return summary;
    } catch (error) {
        summary.error = error instanceof Error ? error.message : String(error);
        // Preserve the original failure if the storage that lost a checkpoint cannot save the failure journal either.
        await save('summary.json', summary).catch(() => {});
        throw error;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const arg = process.argv.slice(2).find((value) => value.startsWith('--out-dir='));
    if (!arg || process.argv.length !== 3) { console.error('usage: node scripts/agent-reads-paired.mjs --out-dir=<fresh-directory>'); process.exitCode = 2; }
    else {
        console.log('PAIRED MEASURE START: three alternating pairs each, inline and revision; stop on any failed bound');
        runPairedMeasurement({ outDir: arg.slice('--out-dir='.length) }).then((result) => {
            console.log(`IDENTITY ${JSON.stringify(result.identity)}`);
            for (const verdict of result.verdicts) {
                for (const row of verdict.rows) console.log(`${row.pass ? 'PASS' : 'FAIL'} ${verdict.candidateMode} ${row.row} value=${row.value} limit=${row.limit}`);
            }
            console.log(`PAIRED MEASURE ${result.pass ? 'PASS' : 'FAIL'}`);
            process.exitCode = result.pass ? 0 : 1;
        }, (error) => { console.error(`PAIRED MEASURE FAIL: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
    }
}

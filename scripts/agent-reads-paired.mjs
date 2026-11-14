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
    const summary = { identity, schedule: { m4: 12, 'm5-m6': 3 }, pass: false, finished: false, verdicts: [] };
    const save = (name, value) => writeFile(join(output, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    try {
        for (const candidateMode of ['door', 'door-revision']) {
            const rows = [], phases = [];
            for (const [scope, pairCount] of [['m4', 12], ['m5-m6', 3]]) {
                const report = await acquirePairedRuns({
                    identity, candidateMode, pairCount,
                    runSample: (request) => runMeasurementProcess({ request, scope, cwd,
                        out: join(output, `${candidateMode}-${scope}-pair-${request.pairIndex}-${request.mode}.json`) }),
                    checkpoint: (partial) => save(`${candidateMode}-${scope}.json`, partial),
                });
                // The complete predeclared sample is acquired before judging it. No early numerical success or retry.
                const measured = comparePairedRuns(report, { scope });
                await save(`${candidateMode}-${scope}-rows.json`, measured);
                const pass = measured.length > 0 && measured.every((row) => row.pass);
                phases.push({ scope, pairCount, pass });
                rows.push(...measured.map((row) => ({ ...row, row: row.row.startsWith('pairs.') ? `${scope}.${row.row}` : row.row })));
                if (!pass) break; // A completed failed phase is reported, never traded for a different sample.
            }
            const verdict = { candidateMode, phases, pass: phases.length === 2 && phases.every((phase) => phase.pass), rows };
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
        console.log('PAIRED MEASURE START: twelve M4 pairs (six each order), three M5/M6 pairs per candidate; one fixed acceptance run');
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

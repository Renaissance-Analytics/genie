#!/usr/bin/env node
/** One fixed, opt-in M4 diagnostic (Tynn #564). The earlier acceptance FAIL remains; this never judges acceptance. */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquirePairedRuns } from './agent-reads-acquire.mjs';
import { readMeasurementIdentity, runMeasurementProcess } from './agent-reads-process.mjs';
import { refuseOffTestMachines } from './crash-cdp-lib.mjs';

const groups = ['m4_5000', 'm4_20000'];
const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : sorted[middle - 1] / 2 + sorted[middle] / 2;
};
function requireEvidence(sample) {
    if (sample.scope !== 'm4-diagnostic') throw new Error('expected M4 diagnostic scope');
    for (const group of groups) {
        const ordinary = sample[group];
        if (!Array.isArray(ordinary?.runs) || ordinary.runs.length !== 5 ||
            !ordinary.runs.every((run) => finite(run?.ms) && finite(run?.maxGapMs)) ||
            !finite(ordinary.ms) || ordinary.ms <= 0 || ordinary.ms !== median(ordinary.runs.map((run) => run.ms))) {
            throw new Error(`${group}: exactly five valid ordinary opens are required`);
        }
        const stage = sample.m4Stages?.[group];
        if (!['producerMs', 'decodeMs', 'rebuildMs', 'totalMs'].every((key) => finite(stage?.[key]))) {
            throw new Error(`${group}: separate diagnostic stage evidence is required`);
        }
    }
}

export async function runM4Diagnostic({ outDir }) {
    refuseOffTestMachines('agent-reads-m4-diagnostic');
    if (typeof outDir !== 'string' || outDir.length === 0) throw new Error('a fresh output directory is required');
    const output = resolve(outDir), cwd = process.cwd();
    await mkdir(output, { recursive: false });
    const identity = readMeasurementIdentity(randomUUID());
    const summary = { kind: 'm4-diagnostic', finished: false, acceptance: false, identity };
    const save = (name, value) => writeFile(join(output, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    try {
        const report = await acquirePairedRuns({
            identity, candidateMode: 'door', pairCount: 12,
            runSample: async (request) => {
                const sample = await runMeasurementProcess({
                    request, scope: 'm4-diagnostic', cwd,
                    out: join(output, `m4-pair-${request.pairIndex}-${request.mode}.json`),
                });
                requireEvidence(sample);
                return sample;
            },
            checkpoint: (partial) => save('m4-pairs.json', partial),
        });
        // Descriptive data only. No comparePairedRuns, acceptance verdict, exclusions or early success stopping.
        const statistics = Object.fromEntries(groups.map((group) => {
            const ratios = report.pairs.map((pair) => pair.door[group].ms / pair.ipc[group].ms);
            return [group, { ratios, median: median(ratios), min: Math.min(...ratios), max: Math.max(...ratios) }];
        }));
        const result = { ...summary, finished: true, report, statistics };
        await save('summary.json', result);
        return result;
    } catch (error) {
        await save('summary.json', { ...summary, error: error instanceof Error ? error.message : String(error) }).catch(() => {});
        throw error;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const arg = process.argv.slice(2).find((value) => value.startsWith('--out-dir='));
    if (!arg || process.argv.length !== 3) {
        console.error('usage: node scripts/agent-reads-m4-diagnostic.mjs --out-dir=<fresh-directory>');
        process.exitCode = 2;
    } else {
        console.log('M4 DIAGNOSTIC START:12 fixed alternating pairs,5 ordinary opens; NOT ACCEPTANCE');
        runM4Diagnostic({ outDir: arg.slice('--out-dir='.length) }).then((result) => {
            console.log(`IDENTITY ${JSON.stringify(result.identity)}`);
            console.log(`DESCRIPTIVE RATIOS ${JSON.stringify(result.statistics)}`);
            console.log('M4 DIAGNOSTIC COMPLETE: NOT ACCEPTANCE; original FAIL remains');
        }, (error) => {
            console.error(`M4 DIAGNOSTIC INCOMPLETE: ${error instanceof Error ? error.message : String(error)}`);
            process.exitCode = 1;
        });
    }
}

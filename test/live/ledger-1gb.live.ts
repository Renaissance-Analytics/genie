/**
 * L1 — VM ONLY. Never run on the owner's desktop. This generates ~1GiB of synthetic legacy ledger data.
 * Tynn owns execution: npm ci && npx tsx test/live/ledger-1gb.live.ts
 * Nothing runs on import; ordinary unit tests import the small support module only.
 */
import { fork } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { mintAgentId } from '../../src/core/identity.js';
import { ThreadStore, readHistory, readWholeHistory } from '../../src/core/thread-store.js';
import { HISTORY_LIMIT } from '../../src/main/session-host.js';
import { LEDGER_LIVE_SHAPE, historyJsonBytes, writeLedgerFixture } from './ledger-1gb-support.js';
import { runLedgerWorker, type LedgerGroup, type LedgerWork, type LedgerWorkerReport } from './ledger-1gb-worker.js';

const entryFile = fileURLToPath(import.meta.url);
const shortError = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500);
function parseWork(value: unknown): LedgerWork {
    if (!value || typeof value !== 'object') throw new Error('missing ledger worker configuration');
    const work = value as LedgerWork;
    if (!['history', 'prompt-rows', 'count-append'].includes(work.group) || typeof work.directory !== 'string' || typeof work.agentId !== 'string' || !Number.isSafeInteger(work.expectedRows) || work.expectedRows < 1) throw new Error('invalid ledger worker configuration');
    if (basename(work.directory) !== 'full' || !basename(dirname(work.directory)).startsWith('genie-ledger-1gb-')) throw new Error('worker requires an owned synthetic fixture');
    return work;
}

function inFreshHost(work: LedgerWork, artifactDir: string): Promise<LedgerWorkerReport> {
    return new Promise(resolveWorker => {
        const log = createWriteStream(join(artifactDir, `${work.group}-worker.log`));
        const child = fork(entryFile, ['--worker', JSON.stringify(work)], { execArgv: process.execArgv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
        child.stdout?.pipe(log, { end: false }); child.stderr?.pipe(log, { end: false });
        let report: LedgerWorkerReport | null = null, failure: string | null = null;
        const timeout = setTimeout(() => { failure = 'host-shaped worker exceeded ten minutes'; child.kill('SIGKILL'); }, 10 * 60_000);
        child.on('message', message => { if (message && typeof message === 'object' && 'group' in message && 'measurements' in message) report = message as LedgerWorkerReport; });
        child.on('error', error => { failure = shortError(error); });
        log.on('error', error => { failure = `worker log: ${shortError(error)}`; child.kill('SIGKILL'); });
        child.on('close', (code, signal) => {
            clearTimeout(timeout);
            const result: LedgerWorkerReport = report ?? { group: work.group, pid: child.pid ?? -1, node: process.version, platform: process.platform, controls: null, measurements: [], failures: [] };
            if (failure) result.failures.push(failure);
            if (!report) result.failures.push(`worker returned no measurements (exit ${code}, signal ${signal ?? 'none'})`);
            else if (code !== 0 && result.failures.length === 0) result.failures.push(`worker exited ${code} without a recorded failure`);
            if (log.destroyed) resolveWorker(result); else log.end(() => resolveWorker(result));
        });
    });
}

async function runMain(): Promise<void> {
    const artifactDir = resolve('artifacts', 'ledger-1gb'), resultFile = join(artifactDir, 'result.json');
    await mkdir(artifactDir, { recursive: true });
    const root = await mkdtemp(join(tmpdir(), 'genie-ledger-1gb-')), agentId = mintAgentId();
    const reports: LedgerWorkerReport[] = [], failures: string[] = [];
    let fixture: Awaited<ReturnType<typeof writeLedgerFixture>> | null = null;
    let control: Record<string, unknown> | null = null;
    try {
        fixture = await writeLedgerFixture(root, agentId);
        const target = 1024 ** 3;
        if (fixture.bytes < target * 0.95 || fixture.bytes > target * 1.1 || fixture.rows !== LEDGER_LIVE_SHAPE.rows || fixture.toolRows !== LEDGER_LIVE_SHAPE.toolPairs * 2 || fixture.turns < 1000) throw new Error('synthetic ledger is not the requested ~1GiB /380k-row paired legacy shape');
        console.log(`L1 fixture rows=${fixture.rows} bytes=${fixture.bytes} toolRows=${fixture.toolRows} controlBytes=${fixture.controlBytes}`);

        // A whole-line ~50MiB COPY, not a second differently-shaped generator. Both APIs must agree exactly.
        const options = { limit: HISTORY_LIMIT };
        const bounded = await readHistory(new ThreadStore(fixture.controlDirectory), agentId, options);
        const whole = await readWholeHistory(new ThreadStore(fixture.controlDirectory), agentId, options);
        const equal = isDeepStrictEqual(bounded, whole);
        control = { equal, copiedRows: fixture.controlRows, copiedBytes: fixture.controlBytes, limit: HISTORY_LIMIT, rowsReturned: bounded.rows.length, serializedBytes: historyJsonBytes(bounded.rows), earlier: bounded.earlier, earlierTurns: bounded.earlierTurns, lastTurn: bounded.lastTurn,
            boundedSha256: createHash('sha256').update(JSON.stringify(bounded)).digest('hex'), referenceSha256: createHash('sha256').update(JSON.stringify(whole)).digest('hex') };
        console.log(`L1 history-control equal=${equal} rows=${bounded.rows.length} bytes=${historyJsonBytes(bounded.rows)}`);
        if (!equal) failures.push('50MiB copy history does not exactly equal readWholeHistory, including positions/turn counts');

        // The append group runs LAST, on the same fresh store as its first count. OS file cache is not evicted.
        for (const group of ['history', 'prompt-rows', 'count-append'] as LedgerGroup[]) {
            const report = await inFreshHost({ group, directory: fixture.directory, agentId, expectedRows: fixture.rows }, artifactDir); reports.push(report);
            if (report.controls) console.log(`L1 controls group=${group} positiveLatenessMs=${report.controls.positive.sampler.maxLatenessMs.toFixed(2)} idleLatenessMs=${report.controls.idle.sampler.maxLatenessMs.toFixed(2)} idleWallMs=${report.controls.idle.sampler.wallMs.toFixed(2)}`);
            for (const measurement of report.measurements) console.log(`L1 ${measurement.name} wallMs=${measurement.wallMs.toFixed(2)} rawGapMs=${measurement.sampler.maxGapMs.toFixed(2)} latenessMs=${measurement.sampler.maxLatenessMs.toFixed(2)} heartbeatGapMs=${measurement.heartbeat.maxGapMs.toFixed(2)} loopMaxMs=${measurement.eventLoopDelay.maxMs.toFixed(2)} loopP99Ms=${measurement.eventLoopDelay.p99Ms?.toFixed(2) ?? 'unobserved'} peakRssBytes=${measurement.sampler.peakRssBytes} rssGrowthBytes=${measurement.rssGrowthBytes} rows=${measurement.details.rowsReturned ?? measurement.details.count ?? measurement.details.countAfter ?? '-'} bytes=${measurement.details.historyBytes ?? measurement.details.serializedBytes ?? measurement.details.appendBytes ?? '-'} pass=${measurement.failures.length === 0}`);
            failures.push(...report.failures.map(reason => `${group}: ${reason}`));
        }
    } catch (error) { failures.push(shortError(error)); }
    finally {
        // root is the exact mkdtemp-owned directory; result/log artifacts live outside it and survive failure.
        try { await rm(root, { recursive: true, force: true }); } catch (error) { failures.push(`fixture cleanup: ${shortError(error)}`); }
        const result = { version: 1, platform: process.platform, node: process.version, fixture, control, reports, failures,
            limits: { samplerPeriodMs: 50, samplerMaxLatenessMs: 1000, heartbeatPeriodMs: 1000, monitorResolutionMs: 20, monitorReportOnly: true, positiveBlockMs: 2000, positiveMinLatenessMs: 1900, idleMs: 5000, idleMaxLatenessExclusiveMs: 100, rssGrowthExclusiveBytes: 300_000_000, historyMaxBytes: 4 * 1024 * 1024 },
            isolation: 'fresh process/store per group; first count and append share one store; OS file cache is not evicted; setup/reference memory is outside measured workers',
            code: failures.length ? 1 : 0 };
        await writeFile(resultFile, JSON.stringify(result, null, 2) + '\n');
        console.log(`L1 result code=${result.code} failures=${failures.length} file=${resultFile}`);
        process.exitCode = result.code;
    }
}

const launchedAs = process.argv[1] ? resolve(process.argv[1]) : '';
const samePath = process.platform === 'win32' ? launchedAs.toLowerCase() === entryFile.toLowerCase() : launchedAs === entryFile;
if (samePath) {
    if (process.argv[2] === '--worker') {
        try {
            const report = await runLedgerWorker(parseWork(JSON.parse(process.argv[3] ?? 'null')));
            process.exitCode = report.failures.length ? 1 : 0;
            if (!process.send) throw new Error('ledger worker requires its parent IPC channel');
            process.send(report, () => process.disconnect?.());
        } catch (error) { console.error(`L1 worker failed: ${shortError(error)}`); process.exitCode = 1; if (process.connected) process.disconnect?.(); }
    } else {
        try { await runMain(); } catch (error) { console.error(`L1 failed: ${shortError(error)}`); process.exitCode = 1; }
    }
}

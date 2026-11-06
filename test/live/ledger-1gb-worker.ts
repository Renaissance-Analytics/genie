import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { stat } from 'node:fs/promises';
import type { AgentId } from '../../src/core/identity.js';
import { threadKeyFor } from '../../src/core/identity.js';
import { ThreadStore, readHistory, readPromptRows, HISTORY_MAX_BYTES } from '../../src/core/thread-store.js';
import { HISTORY_LIMIT } from '../../src/main/session-host.js';
import { controlFailures, HeartbeatGauge, historyJsonBytes, measurementFailures } from './ledger-1gb-support.js';

export type LedgerGroup = 'history' | 'prompt-rows' | 'count-append';
export interface LedgerWork { group: LedgerGroup; directory: string; agentId: AgentId; expectedRows: number }
type GaugeReport = ReturnType<HeartbeatGauge['snapshot']>;
interface Clocks { sampler: GaugeReport; heartbeat: GaugeReport; eventLoopDelay: { samples: number; maxMs: number; p99Ms: number | null } }
export interface LedgerMeasurement extends Clocks { name: string; wallMs: number; methodWallMs: number; rssGrowthBytes: number; details: Record<string, unknown>; failures: string[] }
export interface LedgerWorkerReport { group: LedgerGroup; pid: number; node: string; platform: string; controls: { positive: Clocks; idle: Clocks } | null; measurements: LedgerMeasurement[]; failures: string[] }
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** A fresh process per group: writing/control reads cannot warm the store's counts or hide their RSS high-water mark. */
export async function runLedgerWorker(work: LedgerWork): Promise<LedgerWorkerReport> {
    const report: LedgerWorkerReport = { group: work.group, pid: process.pid, node: process.version, platform: process.platform, controls: null, measurements: [], failures: [] };
    const sampler = new HeartbeatGauge({ periodMs: 50 }), heartbeat = new HeartbeatGauge({ periodMs: 1000 });
    const histogram = monitorEventLoopDelay({ resolution: 20 }); histogram.enable();
    const sampleTimer = setInterval(() => sampler.tick(), 50), heartbeatTimer = setInterval(() => heartbeat.tick(), 1000);
    const reset = () => { sampler.reset(); heartbeat.reset(); histogram.reset(); };
    const clocks = (): Clocks => ({ sampler: sampler.snapshot(), heartbeat: heartbeat.snapshot(), eventLoopDelay: {
        // monitorEventLoopDelay reports nanoseconds; unlike the sampler, it is report-only (ruling5953).
        samples: histogram.count, maxMs: histogram.count ? histogram.max / 1e6 : 0, p99Ms: histogram.count ? histogram.percentile(99) / 1e6 : null,
    } });
    try {
        await delay(100); // Both interval and histogram have observed a real tick before calibration.
        reset();
        const blockedAt = performance.now();
        while (performance.now() - blockedAt < 2000) { /* Deliberate VM-only positive control. */ }
        await delay(0); // Let the overdue tick/histogram run before capturing and resetting.
        const positive = clocks();
        reset();
        const idleAt = performance.now();
        while (performance.now() - idleAt < 5000) await delay(Math.max(1, Math.ceil(5000 - (performance.now() - idleAt))));
        const idle = clocks(); report.controls = { positive, idle };
        report.failures.push(...controlFailures({ positiveLatenessMs: positive.sampler.maxLatenessMs, idleLatenessMs: idle.sampler.maxLatenessMs, idleWallMs: idle.sampler.wallMs }));
        if (!(process.resourceUsage().maxRSS > 0)) report.failures.push('OS RSS high-water counter is unavailable; peak growth is unproven');
        if (report.failures.length) return report; // Never call a broken/untested gauge a quiet successful measurement.

        const store = new ThreadStore(work.directory), key = threadKeyFor(work.agentId);
        const measure = async (name: string, operation: () => Promise<{ methodWallMs: number; details: Record<string, unknown> }>): Promise<LedgerMeasurement> => {
            reset(); const started = performance.now();
            let methodWallMs = 0, details: Record<string, unknown> = {}, failure: string | null = null;
            try { const result = await operation(); methodWallMs = result.methodWallMs; details = result.details; }
            catch (error) { failure = error instanceof Error ? error.message : String(error); }
            const wallMs = performance.now() - started;
            // An operation that held the loop can finish before its overdue interval callback gets a turn.
            const beforeDrain = clocks(); await delay(0); const afterDrain = clocks();
            const observed = afterDrain.sampler.maxLatenessMs >= beforeDrain.sampler.maxLatenessMs ? afterDrain : beforeDrain;
            const result: LedgerMeasurement = { name, ...observed, wallMs, methodWallMs, rssGrowthBytes: observed.sampler.rssGrowthBytes, details, failures: [] };
            result.failures.push(...measurementFailures({ sampler: result.sampler, rssGrowthBytes: result.rssGrowthBytes,
                ...(typeof details.historyBytes === 'number' ? { historyBytes: details.historyBytes } : {}) }));
            if (failure) result.failures.push(failure);
            report.measurements.push(result); report.failures.push(...result.failures.map(reason => `${name}: ${reason}`));
            return result;
        };

        if (work.group === 'history') await measure('readHistory', async () => {
            const started = performance.now(), history = await readHistory(store, work.agentId, { limit: HISTORY_LIMIT });
            const methodWallMs = performance.now() - started;
            // Include positions/array syntax as well as the store's narrower event+at budget; never weaken the4MiB gate.
            const historyBytes = historyJsonBytes(history.rows);
            const budgetedBytes = history.rows.reduce((total, row) => total + Buffer.byteLength(JSON.stringify({ event: row.event, at: row.at })), 0);
            return { methodWallMs, details: { limit: HISTORY_LIMIT, maxBytes: HISTORY_MAX_BYTES, rowsReturned: history.rows.length, historyBytes, budgetedBytes, earlier: history.earlier, earlierTurns: history.earlierTurns, lastTurn: history.lastTurn } };
        });
        else if (work.group === 'prompt-rows') await measure('readPromptRows', async () => {
            const started = performance.now(), result = await readPromptRows(store, work.agentId), methodWallMs = performance.now() - started;
            return { methodWallMs, details: { rowsReturned: result.rows.length, serializedBytes: historyJsonBytes(result.rows) } };
        });
        else {
            const count = await measure('firstLogLength', async () => {
                const started = performance.now(), count = await store.logLength(key), methodWallMs = performance.now() - started;
                if (count !== work.expectedRows) throw new Error(`cold logLength returned ${count}, expected ${work.expectedRows}`);
                return { methodWallMs, details: { count, expected: work.expectedRows, coldStore: true } };
            });
            if (count.failures.length === 0) await measure('oneAppend', async () => {
                const before = (await stat(store.logFile(key))).size, started = performance.now();
                await store.appendLog(key, [{ position: work.expectedRows, message: { kind: 'message', speaker: 'you', peerName: null, text: 'Synthetic L1 append' }, recorded_at: '2026-11-06T12:00:00.000Z' }] as never);
                const methodWallMs = performance.now() - started, count = await store.logLength(key), after = (await stat(store.logFile(key))).size;
                if (count !== work.expectedRows + 1 || after <= before) throw new Error('one append did not add exactly one counted row');
                return { methodWallMs, details: { countBefore: work.expectedRows, countAfter: count, bytesBefore: before, bytesAfter: after, appendBytes: after - before, sameStoreAfterFirstCount: true } };
            });
        }
        return report;
    } catch (error) {
        report.failures.push(error instanceof Error ? error.message : String(error)); return report;
    } finally { clearInterval(sampleTimer); clearInterval(heartbeatTimer); histogram.disable(); }
}

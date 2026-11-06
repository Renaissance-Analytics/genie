import { mkdir, open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { AgentId } from '../../src/core/identity.js';
import { threadKeyFor } from '../../src/core/identity.js';
import { RUN_FIELD, ThreadStore } from '../../src/core/thread-store.js';

/** Old rows intentionally bypass recordEvent's new preview/sidecar bound. Importing this module writes nothing. */
export const LEDGER_LIVE_SHAPE = { rows: 380_000, toolPairs: 3300, tailPairs: 512, minToolBytes: 50 * 1024, maxToolBytes: 240 * 1024, controlBytes: 50 * 1024 * 1024, batchBytes: 2 * 1024 * 1024 } as const;
export interface FixtureShape { rows: number; toolPairs: number; tailPairs: number; minToolBytes: number; maxToolBytes: number; controlBytes: number; batchBytes: number }
export interface LedgerEntry { position: number; message: Record<string, unknown>; recorded_at: string }
export const serializeLedgerEntry = (entry: LedgerEntry): string => JSON.stringify(entry) + '\n';
const entry = (position: number, message: Record<string, unknown>): LedgerEntry => ({ position, message, recorded_at: new Date(Date.UTC(2026, 10, 6) + position).toISOString() });

export function* fixtureEntries(options: Partial<FixtureShape> = {}): Generator<LedgerEntry> {
    const shape = { ...LEDGER_LIVE_SHAPE, ...options };
    if (!Number.isInteger(shape.rows) || !Number.isInteger(shape.toolPairs) || shape.rows < 1 || shape.toolPairs < 0 || shape.toolPairs * 2 > shape.rows || shape.minToolBytes < 512 || shape.maxToolBytes < shape.minToolBytes + 32) throw new Error('invalid synthetic ledger shape');
    const tailPairs = Math.min(shape.toolPairs, Math.max(0, Math.floor(shape.tailPairs))), tailAt = shape.rows - tailPairs * 2;
    const early = shape.toolPairs - tailPairs, starts = new Map<number, number>();
    for (let i = 0; i < early; i++) starts.set(Math.floor((i + 1) * Math.floor(tailAt / 2) / (early + 1)) * 2, i);
    for (let i = 0; i < tailPairs; i++) starts.set(tailAt + i * 2, early + i);
    for (let position = 0; position < shape.rows; position++) {
        const pair = starts.get(position), run = `synthetic-run-${Math.floor(position / 512)}`;
        if (pair !== undefined) {
            const base = { kind: 'tool', toolCallId: `synthetic-tool-${pair}`, name: 'synthetic.read', title: 'Synthetic legacy tool output', toolKind: 'read', rawInput: { path: 'synthetic-only.txt' }, output: '', [RUN_FIELD]: run };
            const a = entry(position, { ...base, status: 'in_progress' }), b = entry(position + 1, { ...base, status: 'completed' });
            const overhead = Math.max(Buffer.byteLength(serializeLedgerEntry(a)), Buffer.byteLength(serializeLedgerEntry(b)));
            const target = shape.minToolBytes + 8 + Math.floor((shape.maxToolBytes - shape.minToolBytes - 16) * (pair % 17) / 16);
            const prefix = `synthetic-output-${pair}: `, output = prefix + 'x'.repeat(target - overhead - prefix.length);
            a.message.output = output; b.message.output = output;
            yield a; yield b; position++;
            continue;
        }
        let message: Record<string, unknown>;
        if (position % 64 === 0) message = { kind: 'turn', n: Math.floor(position / 64) + 1, by: 'you' };
        else if (position % 64 === 1) message = { kind: 'run', resumed: false };
        else if (position % 64 === 2) message = { kind: 'message', speaker: 'you', peerName: null, text: 'Synthetic pending prompt', pending: { id: `synthetic-draft-${position}`, content: null } };
        else if (position % 64 === 3) message = { kind: 'prompt_delivery', id: `synthetic-draft-${position - 1}`, status: 'sent' };
        else message = { kind: 'message', speaker: position % 2 ? 'agent' : 'you', peerName: null, text: `Synthetic row ${position}: ` + 's'.repeat(96) };
        yield entry(position, { ...message, [RUN_FIELD]: run });
    }
}

/** writev can complete only part of the offered buffers; never drop a suffix or materialize the entire ledger. */
async function writeBuffers(handle: FileHandle, buffers: Buffer[]): Promise<void> {
    let index = 0, offset = 0;
    while (index < buffers.length) {
        const pending = buffers.slice(index); if (offset) pending[0] = pending[0]!.subarray(offset);
        const { bytesWritten } = await handle.writev(pending);
        if (bytesWritten <= 0) throw new Error('synthetic ledger write made no progress');
        let remaining = bytesWritten;
        while (index < buffers.length && remaining >= buffers[index]!.length - offset) { remaining -= buffers[index]!.length - offset; index++; offset = 0; }
        offset += remaining;
    }
}

export async function writeLedgerFixture(root: string, id: AgentId, options: Partial<FixtureShape> = {}) {
    const shape = { ...LEDGER_LIVE_SHAPE, ...options }, directory = join(root, 'full'), controlDirectory = join(root, 'control');
    if (!Number.isSafeInteger(shape.batchBytes) || shape.batchBytes < 1 || !Number.isSafeInteger(shape.controlBytes) || shape.controlBytes < 1) throw new Error('invalid synthetic ledger write budget');
    await Promise.all([mkdir(directory, { recursive: true }), mkdir(controlDirectory, { recursive: true })]);
    const key = threadKeyFor(id), logFile = new ThreadStore(directory).logFile(key), controlLogFile = new ThreadStore(controlDirectory).logFile(key);
    const full = await open(logFile, 'wx'); let control: FileHandle | null = null;
    let bytes = 0, controlBytes = 0, controlRows = 0, rows = 0, toolRows = 0, turns = 0, minToolBytes = Infinity, maxToolBytes = 0, maxBufferedBytes = 0;
    let batch: Buffer[] = [], copied: Buffer[] = [], buffered = 0, copying = true;
    const flush = async () => { await Promise.all([writeBuffers(full, batch), control ? writeBuffers(control, copied) : Promise.resolve()]); batch = []; copied = []; buffered = 0; };
    try {
        control = await open(controlLogFile, 'wx');
        for (const row of fixtureEntries(shape)) {
            const data = Buffer.from(serializeLedgerEntry(row)); rows++; bytes += data.length;
            if (row.message.kind === 'tool') { toolRows++; minToolBytes = Math.min(minToolBytes, data.length); maxToolBytes = Math.max(maxToolBytes, data.length); }
            if (row.message.kind === 'turn') turns++;
            batch.push(data); buffered += data.length; maxBufferedBytes = Math.max(maxBufferedBytes, buffered);
            if (copying && controlBytes + data.length <= shape.controlBytes) { copied.push(data); controlBytes += data.length; controlRows++; }
            else copying = false; // An exact prefix: do not skip a large line and resume copying later small ones.
            if (buffered >= shape.batchBytes) await flush();
        }
        if (batch.length) await flush();
    } finally { await Promise.allSettled([full.close(), ...(control ? [control.close()] : [])]); }
    return { directory, controlDirectory, logFile, controlLogFile, rows, bytes, controlBytes, controlRows, toolRows, turns, minToolBytes: toolRows ? minToolBytes : null, maxToolBytes, maxBufferedBytes };
}

export const historyJsonBytes = (rows: readonly unknown[]): number => Buffer.byteLength(JSON.stringify(rows), 'utf8');

interface GaugeDeps { periodMs: number; now?: () => number; rss?: () => number; highWaterRss?: () => number }
/** No timers on import/construction: the VM runner owns and disposes each real interval. */
export class HeartbeatGauge {
    readonly #deps: Required<GaugeDeps>;
    #start = 0; #last = 0; #baseline = 0; #baselineHighWater = 0; #peak = 0; #ticks = 0; #maxTickGap = 0;
    constructor(deps: GaugeDeps) {
        this.#deps = { periodMs: deps.periodMs, now: deps.now ?? (() => performance.now()), rss: deps.rss ?? (() => process.memoryUsage.rss()),
            // Node reports maxRSS in KiB: https://nodejs.org/api/process.html#processresourceusage
            highWaterRss: deps.highWaterRss ?? (() => process.resourceUsage().maxRSS * 1024) };
        this.reset();
    }
    reset(): void {
        this.#start = this.#last = this.#deps.now(); this.#baseline = this.#deps.rss(); this.#baselineHighWater = this.#deps.highWaterRss();
        this.#peak = Math.max(this.#baseline, this.#baselineHighWater); this.#ticks = 0; this.#maxTickGap = 0;
    }
    tick(): void {
        const now = this.#deps.now(); this.#maxTickGap = Math.max(this.#maxTickGap, now - this.#last); this.#last = now; this.#ticks++;
        this.#peak = Math.max(this.#peak, this.#deps.rss(), this.#deps.highWaterRss());
    }
    snapshot() {
        const now = this.#deps.now(), completionGapMs = now - this.#last, maxGapMs = Math.max(this.#maxTickGap, completionGapMs);
        this.#peak = Math.max(this.#peak, this.#deps.rss(), this.#deps.highWaterRss());
        return { ticks: this.#ticks, wallMs: now - this.#start, maxTickGapMs: this.#maxTickGap, completionGapMs, maxGapMs,
            maxLatenessMs: Math.max(0, maxGapMs - this.#deps.periodMs), baselineRssBytes: this.#baseline, baselineHighWaterRssBytes: this.#baselineHighWater,
            peakRssBytes: this.#peak, rssGrowthBytes: Math.max(0, this.#peak - this.#baseline) };
    }
}

const finiteNonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export interface MeasurementGateInput { sampler?: { maxLatenessMs?: number }; rssGrowthBytes?: number; historyBytes?: number }
/** Coordinator5953: only sampler lateness is gated; 1s raw heartbeat and loop histogram remain report-only. */
export function measurementFailures(value: MeasurementGateInput): string[] {
    const failures: string[] = [];
    if (!finiteNonnegative(value.sampler?.maxLatenessMs) || value.sampler.maxLatenessMs > 1000) failures.push('50ms sampler lateness exceeds 1000ms or is unobserved');
    if (!finiteNonnegative(value.rssGrowthBytes) || value.rssGrowthBytes >= 300_000_000) failures.push('peak RSS growth must be under 300000000 bytes');
    if (value.historyBytes !== undefined && (!finiteNonnegative(value.historyBytes) || value.historyBytes > 4 * 1024 * 1024)) failures.push('serialized history rows exceed 4MiB');
    return failures;
}
export function controlFailures(value: { positiveLatenessMs: number; idleLatenessMs: number; idleWallMs: number }): string[] {
    const failures: string[] = [];
    if (!finiteNonnegative(value.positiveLatenessMs) || value.positiveLatenessMs < 1900) failures.push('2s positive control did not show at least 1900ms lateness');
    if (!finiteNonnegative(value.idleLatenessMs) || value.idleLatenessMs >= 100 || !finiteNonnegative(value.idleWallMs) || value.idleWallMs < 5000) failures.push('5s idle control must show lateness under 100ms');
    return failures;
}

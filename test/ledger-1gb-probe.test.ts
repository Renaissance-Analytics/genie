import { readFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { mintAgentId, threadKeyFor } from '../src/core/identity.js';
import { ThreadStore, readHistory, readWholeHistory } from '../src/core/thread-store.js';

const support = async () => { const file: string = './live/ledger-1gb-support.js'; return import(file); };
type Entry = { position: number; message: Record<string, unknown>; recorded_at: string };
const small = { rows: 120, toolPairs: 12, tailPairs: 4, minToolBytes: 1024, maxToolBytes: 4096 };
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function temp() { const dir = await mkdtemp(join(tmpdir(), 'genie-ledger-probe-')); dirs.push(dir); return dir; }

it('declares a roughly 380k row legacy ledger with paired 50-240KiB tools and a 50MiB control, without building it on import', async () => {
    const m = await support();
    expect(m.LEDGER_LIVE_SHAPE).toMatchObject({ rows: 380_000, toolPairs: 3300, tailPairs: 512, minToolBytes: 50 * 1024, maxToolBytes: 240 * 1024, controlBytes: 50 * 1024 * 1024 });
});
it('produces consecutive old-format positions, spread turns and identical in-progress/completed payload pairs', async () => {
    const m = await support(), rows = [...m.fixtureEntries(small)] as Entry[];
    expect(rows.length).toBe(small.rows); expect(rows.map(row => row.position)).toEqual(Array.from({ length: small.rows }, (_, i) => i));
    const tools = rows.filter(row => row.message.kind === 'tool'); expect(tools.length).toBe(small.toolPairs * 2);
    for (let i = 0; i < tools.length; i += 2) {
        const a = tools[i]!, b = tools[i + 1]!;
        expect(b.position).toBe(a.position + 1); expect(a.message.status).toBe('in_progress'); expect(b.message.status).toBe('completed');
        expect(a.message.toolCallId).toBe(b.message.toolCallId); expect(a.message.output === b.message.output).toBe(true);
        for (const row of [a, b]) { const size = Buffer.byteLength(m.serializeLedgerEntry(row)); expect(size).toBeGreaterThanOrEqual(small.minToolBytes); expect(size).toBeLessThanOrEqual(small.maxToolBytes); }
    }
    const turns = rows.filter(row => row.message.kind === 'turn'); expect(turns.length).toBeGreaterThan(1);
    expect(turns.at(-1)!.position - turns[0]!.position).toBeGreaterThan(small.rows / 2);
    expect(rows.some(row => row.message.kind === 'run')).toBe(true);
    expect(rows.some(row => row.message.kind === 'message' && row.message.pending)).toBe(true);
    expect(rows.some(row => row.message.kind === 'prompt_delivery')).toBe(true);
});
it('serializes fixture rows byte-for-byte like the real ThreadStore append format', async () => {
    const m = await support(), dir = await temp(), store = new ThreadStore(dir), key = threadKeyFor(mintAgentId());
    const rows = [...m.fixtureEntries(small)] as Entry[];
    await store.appendLog(key, rows as never);
    const actual = await readFile(store.logFile(key)), expected = Buffer.from(rows.map(row => m.serializeLedgerEntry(row)).join(''));
    expect(actual.equals(expected)).toBe(true); // Failure must never print a synthetic tool payload into CI logs.
});
it('writes in bounded batches and copies an exact whole-line prefix for the smaller reference control', async () => {
    const m = await support(), dir = await temp(), id = mintAgentId();
    const result = await m.writeLedgerFixture(dir, id, { ...small, controlBytes: 20 * 1024, batchBytes: 8 * 1024 });
    const large = await readFile(result.logFile), control = await readFile(result.controlLogFile);
    expect(large.byteLength).toBe(result.bytes); expect((await stat(result.logFile)).size).toBe(result.bytes);
    expect(control.byteLength).toBe(result.controlBytes); expect(control.byteLength).toBeLessThanOrEqual(20 * 1024);
    expect(control.at(-1)).toBe(10); expect(large.subarray(0, control.length).equals(control)).toBe(true);
    expect(large.toString('utf8').trimEnd().split('\n').length).toBe(small.rows);
    expect(result.maxBufferedBytes).toBeLessThanOrEqual(8 * 1024 + small.maxToolBytes);
});
it('the smaller copied ledger gives exactly the reference history including positions, earlier turns and last turn', async () => {
    const m = await support(), dir = await temp(), id = mintAgentId();
    const fixture = await m.writeLedgerFixture(dir, id, { ...small, rows: 240, toolPairs: 30, minToolBytes: 20 * 1024, maxToolBytes: 64 * 1024, controlBytes: 512 * 1024 });
    const actual = await readHistory(new ThreadStore(fixture.controlDirectory), id, { limit: 20 });
    const expected = await readWholeHistory(new ThreadStore(fixture.controlDirectory), id, { limit: 20 });
    expect(isDeepStrictEqual(actual, expected)).toBe(true);
    expect(actual.earlier).toBeGreaterThan(0); expect(actual.lastTurn).toBeGreaterThan(0);
});
it('counts actual UTF-8 serialized history rows including positions and array syntax for the 4MiB gate', async () => {
    const m = await support(), rows = [{ position: 12345, event: { kind: 'message', text: '雪😀' }, at: 1 }];
    expect(m.historyJsonBytes(rows)).toBe(Buffer.byteLength(JSON.stringify(rows), 'utf8'));
    expect(m.historyJsonBytes(rows)).toBeGreaterThan(Buffer.byteLength(JSON.stringify({ event: rows[0]!.event, at: 1 })));
});
it('the monotonic heartbeat gauge records both raw tick gap and excess lateness without conflating them', async () => {
    const m = await support(); let now = 0, rss = 100;
    const gauge = new m.HeartbeatGauge({ periodMs: 1000, now: () => now, rss: () => rss, highWaterRss: () => rss });
    now = 1000; rss = 120; gauge.tick(); now = 3100; rss = 140; gauge.tick();
    expect(gauge.snapshot()).toMatchObject({ ticks: 2, maxGapMs: 2100, maxLatenessMs: 1100, baselineRssBytes: 100, peakRssBytes: 140, rssGrowthBytes: 40, wallMs: 3100 });
});
it('measurement completion observes a loop block even before the queued heartbeat callback runs', async () => {
    const m = await support(); let now = 0;
    const gauge = new m.HeartbeatGauge({ periodMs: 1000, now: () => now, rss: () => 100, highWaterRss: () => 100 });
    now = 1000; gauge.tick(); now = 3000;
    expect(gauge.snapshot()).toMatchObject({ ticks: 1, maxGapMs: 2000, maxLatenessMs: 1000 });
});
it('uses the process RSS high-water value to catch allocation peaks hidden by a blocked sampling timer', async () => {
    const m = await support(); let now = 0, sampled = 100, peak = 100;
    const gauge = new m.HeartbeatGauge({ periodMs: 1000, now: () => now, rss: () => sampled, highWaterRss: () => peak });
    now = 300; sampled = 110; peak = 450;
    expect(gauge.snapshot()).toMatchObject({ baselineRssBytes: 100, peakRssBytes: 450, rssGrowthBytes: 350 });
});
it('resets the positive-control gap and memory baseline before measuring the real ledger operation', async () => {
    const m = await support(); let now = 0, rss = 100;
    const gauge = new m.HeartbeatGauge({ periodMs: 1000, now: () => now, rss: () => rss, highWaterRss: () => rss });
    now = 3000; rss = 200; gauge.tick(); expect(gauge.snapshot().maxGapMs).toBe(3000); gauge.reset();
    now = 3500; rss = 210;
    expect(gauge.snapshot()).toMatchObject({ ticks: 0, wallMs: 500, maxGapMs: 500, maxLatenessMs: 0, baselineRssBytes: 200, peakRssBytes: 210, rssGrowthBytes: 10 });
});
it('gates the 50ms sampler lateness, retaining raw heartbeat gaps and monitorEventLoopDelay for reporting only', async () => {
    const m = await support();
    const measurement = { sampler: { maxGapMs: 1050, maxLatenessMs: 1000 }, heartbeat: { maxGapMs: 1700 }, rssGrowthBytes: 299_999_999, eventLoopDelay: { maxMs: 1500, p99Ms: 1200 } };
    expect(m.measurementFailures(measurement)).toEqual([]);
    expect(m.measurementFailures({ ...measurement, sampler: { maxGapMs: 1050.01, maxLatenessMs: 1000.01 } }).some((reason: string) => /lateness/i.test(reason))).toBe(true);
});
it('requires RSS growth strictly under 300MB and actual serialized history bytes at most 4MiB', async () => {
    const m = await support(), base = { sampler: { maxLatenessMs: 0 }, rssGrowthBytes: 0 };
    expect(m.measurementFailures({ ...base, rssGrowthBytes: 300_000_000 }).some((reason: string) => /RSS/i.test(reason))).toBe(true);
    expect(m.measurementFailures({ ...base, historyBytes: 4 * 1024 * 1024 })).toEqual([]);
    expect(m.measurementFailures({ ...base, historyBytes: 4 * 1024 * 1024 + 1 }).some((reason: string) => /history/i.test(reason))).toBe(true);
});
it('requires the live 2s positive control and 5s idle control at their exact ruled boundaries', async () => {
    const m = await support();
    expect(m.controlFailures({ positiveLatenessMs: 1900, idleLatenessMs: 99.99, idleWallMs: 5000 })).toEqual([]);
    expect(m.controlFailures({ positiveLatenessMs: 1899.99, idleLatenessMs: 0, idleWallMs: 5000 }).some((reason: string) => /positive/i.test(reason))).toBe(true);
    expect(m.controlFailures({ positiveLatenessMs: 2000, idleLatenessMs: 100, idleWallMs: 5000 }).some((reason: string) => /idle/i.test(reason))).toBe(true);
    expect(m.controlFailures({ positiveLatenessMs: 2000, idleLatenessMs: 0, idleWallMs: 4999 }).some((reason: string) => /idle/i.test(reason))).toBe(true);
});
it('refuses missing or non-finite gauge readings instead of treating an unobserved gauge as quiet', async () => {
    const m = await support();
    expect(m.measurementFailures({ sampler: { maxLatenessMs: NaN }, rssGrowthBytes: 0 }).length).toBeGreaterThan(0);
    expect(m.measurementFailures({ sampler: { maxLatenessMs: 0 }, rssGrowthBytes: undefined }).length).toBeGreaterThan(0);
    expect(m.controlFailures({ positiveLatenessMs: NaN, idleLatenessMs: 0, idleWallMs: 5000 }).length).toBeGreaterThan(0);
});

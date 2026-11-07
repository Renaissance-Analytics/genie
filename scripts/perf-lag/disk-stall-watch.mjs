#!/usr/bin/env node
/**
 * DOES THE MACHINE PAUSE, OR THE DISK STALL, WHILE THE SUITE RUNS? Run this beside the full suite on a test VM, so the next single-test 30 s timeout can be matched against a pause. Three of
 * them have hit this VM, on a different test each time (genie#1479). It writes only to a temp folder of its own.
 *
 *   node scripts/perf-lag/disk-stall-watch.mjs 2400 > stall.log     # seconds to watch, default 1800
 *
 * Two gauges on one thread, each with a time on every line:
 *   - `pause`: a 100 ms timer, and any time it comes back more than 1 s late. A wall-clock pause: the VM not scheduled, or this process kept off the CPU. A disk stall does not cause it,
 *     because the disk work below is asynchronous. An earlier version measured its gap straight after the sleep it meant to measure, so it could only ever read about 0.
 *   - `open` / `write` / `fsync` / `close` / `rename`: what writeJsonAtomic does, every 250 ms, for any step over 1 s.
 *
 * CONTROL: it first holds its own thread for 1,500 ms, and `pause` must read that, or the run says FAIL. A gauge that reads nothing is only believed because it can read something.
 * A line a minute shows it was still watching. To match a timeout, read the test's own start and duration: vitest `--reporter=default --reporter=json --outputFile=results.json`.
 *
 * Ends with `### disk-stall max=<ms> <step> at <time>`, `### disk-stall pauses=<n> longest=<ms> at <time>` and `### disk-stall control=PASS|FAIL`.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { open, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const seconds = Number(process.argv[2] ?? 1800);
const OVER_MS = 1000;
const dir = mkdtempSync(join(tmpdir(), 'disk-stall-'));
const body = randomBytes(4096);
const stamp = () => new Date().toISOString();
const worst = { ms: 0, step: 'none', at: '' };
const pauses = { count: 0, longest: 0, at: '' };
let samples = 0;

const TICK_MS = 100;
let lastTick = performance.now();
const tick = () => {
    const now = performance.now();
    const late = now - lastTick - TICK_MS;
    lastTick = now;
    if (late <= OVER_MS) return;
    pauses.count += 1;
    if (late > pauses.longest) { pauses.longest = Math.round(late); pauses.at = stamp(); }
    console.log(`${stamp()} pause ${Math.round(late)} ms`);
};
const ticker = setInterval(tick, TICK_MS);

await new Promise((r) => setTimeout(r, 300));
const held = performance.now();
while (performance.now() - held < OVER_MS + 500) { /* the control: this thread, held */ }
await new Promise((r) => setTimeout(r, 2 * TICK_MS));
const control = pauses.count === 1 && pauses.longest >= OVER_MS;
console.log(`### disk-stall control=${control ? 'PASS' : 'FAIL'}  a ${OVER_MS + 500} ms hold read as ${pauses.longest} ms`);
pauses.count = 0;
pauses.longest = 0;
pauses.at = '';

const note = (step, ms) => {
    if (ms > worst.ms) { worst.ms = Math.round(ms); worst.step = step; worst.at = stamp(); }
    if (ms > OVER_MS) console.log(`${stamp()} ${step} took ${Math.round(ms)} ms`);
};
const timed = async (step, run) => { const began = performance.now(); const value = await run(); note(step, performance.now() - began); return value; };
const end = Date.now() + seconds * 1000;
let nextMinute = Date.now() + 60_000;
while (Date.now() < end) {
    const tmp = join(dir, `w.${samples}.tmp`);
    const handle = await timed('open', () => open(tmp, 'w', 0o600));
    await timed('write', () => handle.writeFile(body));
    await timed('fsync', () => handle.sync());
    await timed('close', () => handle.close());
    await timed('rename', () => rename(tmp, join(dir, 'w.json')));
    samples += 1;
    if (Date.now() >= nextMinute) { console.log(`${stamp()} watching: ${samples} samples, ${pauses.count} pauses`); nextMinute += 60_000; }
    await new Promise((r) => setTimeout(r, 250));
}
clearInterval(ticker);
rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
console.log(`### disk-stall max=${worst.ms} ${worst.step} at ${worst.at}  samples=${samples}`);
console.log(`### disk-stall pauses=${pauses.count} longest=${pauses.longest} at ${pauses.at || 'none'}`);
process.exitCode = control ? 0 : 1;

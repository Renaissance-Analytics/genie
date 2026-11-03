#!/usr/bin/env node
/**
 * DOES THE DISK STALL WHILE THE SUITE RUNS? Run this beside the full suite on a test VM. A 30 s timeout hit `services-more` "a dedicated engine…" (61,942 ms, where its neighbours take
 * 18 ms): that test's Docker, passwords, ports and sleeps are all fakes, and all it really does is `writeJsonAtomic` (write, FlushFileBuffers, rename). So either the disk stalled, or
 * something else is going on that this will rule the disk out of.
 *
 *   node scripts/perf-lag/disk-stall-watch.mjs 2400 > stall.log     # seconds to watch, default 1800. Writes only to a temp folder of its own
 *
 * Every 250 ms it does what writeJsonAtomic does, timing each step on the wall clock. It prints a line for any step over 1 s, then `### disk-stall max=<ms> <step> at <time>` and how
 * many samples ran. A long gap between samples with quick steps is the event loop or the CPU, not the disk: `gap` shows that. Read it against the slow test's time.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { open, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const seconds = Number(process.argv[2] ?? 1800);
const dir = mkdtempSync(join(tmpdir(), 'disk-stall-'));
const body = randomBytes(4096);
const worst = { ms: 0, step: 'none', at: '' };
let samples = 0;
const note = (step, ms) => {
    if (ms > worst.ms) { worst.ms = Math.round(ms); worst.step = step; worst.at = new Date().toISOString(); }
    if (ms > 1000) console.log(`${new Date().toISOString()} ${step} took ${Math.round(ms)} ms`);
};
const timed = async (step, run) => { const began = performance.now(); const value = await run(); note(step, performance.now() - began); return value; };
const end = Date.now() + seconds * 1000;
let last = performance.now();
while (Date.now() < end) {
    note('gap', performance.now() - last - 250);
    const tmp = join(dir, `w.${samples}.tmp`);
    const handle = await timed('open', () => open(tmp, 'w', 0o600));
    await timed('write', () => handle.writeFile(body));
    await timed('fsync', () => handle.sync());
    await timed('close', () => handle.close());
    await timed('rename', () => rename(tmp, join(dir, 'w.json')));
    samples += 1;
    await new Promise((r) => setTimeout(r, 250));
    last = performance.now();
}
rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
console.log(`### disk-stall max=${worst.ms} ${worst.step} at ${worst.at}  samples=${samples}`);

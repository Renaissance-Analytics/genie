/**
 * A TERMINAL STREAMED PAST ITS OUTPUT CAP, for the UI-lag row (scripts/ui-lag-cdp.mjs, Tynn #542): run in a Genie terminal.
 * It prints `bytes` of output as fast as the terminal takes it — more than the view keeps per terminal (OUTPUT_CAP) — then
 * writes `flood-past.json` and goes on printing at the build's rate (40 lines every 50 ms) for `ms` milliseconds, so the
 * view streams with its kept output at the cap, trimmed from the front on every batch.
 *
 * Usage: node flood.mjs <bytes> <ms> <run-id>
 */
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';

const bytes = Number(process.argv[2] ?? 2_500_000), ms = Number(process.argv[3] ?? 15000), run = String(process.argv[4] ?? 'run');
const TICK_MS = 50, LINES_PER_TICK = 40;
const started = Date.now();
let sent = 0, i = 0;
while (sent < bytes) {
    let chunk = '';
    while (chunk.length < 65536) { chunk += `[flood ${run}] ${String(i).padStart(7)} ${'#'.repeat(60)}\n`; i += 1; }
    sent += chunk.length;
    if (!process.stdout.write(chunk)) await once(process.stdout, 'drain');
}
writeFileSync('flood-past.json', JSON.stringify({ run, bytes: sent, ms: Date.now() - started }));
const streamFrom = Date.now();
let ticks = 0;
while (Date.now() - streamFrom < ms) {
    const tickStart = Date.now();
    let out = '';
    for (let l = 0; l < LINES_PER_TICK; l += 1) out += `[flood ${run}] [${String(ticks).padStart(4)}] streaming past the cap ${'.'.repeat(l % 40)}\n`;
    process.stdout.write(out);
    ticks += 1;
    const rest = TICK_MS - (Date.now() - tickStart);
    if (rest > 0) await new Promise((r) => setTimeout(r, rest));
}
process.stdout.write(`UI_LAG_FLOOD_DONE ${run}\n`);

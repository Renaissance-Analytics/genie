/**
 * A WRITE-HEAVY BUILD, for the UI-lag row (scripts/ui-lag-cdp.mjs): run in a Genie terminal in the workspace, as a person
 * runs one. For `ms` milliseconds, every TICK_MS it rewrites a slice of `gen/` (sources a watcher and git see: untracked
 * files) and of `dist/` (build output the watcher ignores), and prints build-tool progress lines. At the end it writes
 * `dist/ui-lag-build.json` with what it did, and prints the done line the row waits for.
 *
 * Usage: node build.mjs <ms> <run-id>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ms = Number(process.argv[2] ?? 20000), run = String(process.argv[3] ?? 'run');
const TICK_MS = 50, PER_TICK = 120, GEN_FILES = 3000, DIST_FILES = 3000, DIRS = 30, LINES_PER_TICK = 40;
const body = (i, n) => `// generated ${run} ${n}\nexport const v${i} = ${n};\n${'// padding '.repeat(120)}\n`;
for (let d = 0; d < DIRS; d += 1) { mkdirSync(join('gen', `m${d}`), { recursive: true }); mkdirSync(join('dist', `m${d}`), { recursive: true }); }
const started = Date.now();
let ticks = 0, writes = 0, lines = 0, at = 0;
while (Date.now() - started < ms) {
    const tickStart = Date.now();
    for (let k = 0; k < PER_TICK; k += 1) {
        const i = (at + k) % GEN_FILES, j = (at + k) % DIST_FILES;
        writeFileSync(join('gen', `m${i % DIRS}`, `f${i}.js`), body(i, ticks));
        writeFileSync(join('dist', `m${j % DIRS}`, `f${j}.js`), body(j, ticks));
        writes += 2;
    }
    at = (at + PER_TICK) % GEN_FILES;
    let out = '';
    for (let l = 0; l < LINES_PER_TICK; l += 1) out += `[build ${run}] [${String(ticks).padStart(4)}] transforming gen/m${l % DIRS}/f${(at + l) % GEN_FILES}.js ${'.'.repeat(l % 40)}\n`;
    process.stdout.write(out);
    lines += LINES_PER_TICK;
    ticks += 1;
    const rest = TICK_MS - (Date.now() - tickStart);
    if (rest > 0) await new Promise((r) => setTimeout(r, rest));
}
const result = { run, ms: Date.now() - started, ticks, writes, lines };
writeFileSync(join('dist', 'ui-lag-build.json'), JSON.stringify(result));
process.stdout.write(`UI_LAG_BUILD_DONE ${run} writes=${writes}\n`);

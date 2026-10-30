#!/usr/bin/env node
/**
 * A CPU PROFILE, READ THROUGH THE BUILD'S SOURCE MAPS (genie#1340).
 *
 *   node scripts/perf-lag/analyze.mjs <x.cpuprofile> <dist dir> [fromMs toMs] [--focus <fn substring>]
 *
 * Prints self and inclusive time per SOURCE function (file:line name), optionally only for samples in a window of
 * the profile (ms from its start). Tooling only: it reads files, it runs nothing of Genie.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(join(process.cwd(), 'package.json'));
const { TraceMap, originalPositionFor } = require('@jridgewell/trace-mapping');

const [file, dist, fromArg, toArg] = process.argv.slice(2);
const focusAt = process.argv.indexOf('--focus');
const focus = focusAt > 0 ? process.argv[focusAt + 1] : null;
const profile = JSON.parse(readFileSync(file, 'utf8'));
const maps = new Map();
function mapFor(url) {
    const name = basename(url.split('?')[0]);
    if (maps.has(name)) return maps.get(name);
    let found = null;
    for (const dir of [join(dist, 'renderer', 'assets'), join(dist, 'main')]) {
        const p = join(dir, `${name}.map`);
        if (existsSync(p)) { found = new TraceMap(readFileSync(p, 'utf8')); break; }
    }
    maps.set(name, found);
    return found;
}
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const labelCache = new Map();
function label(node) {
    if (labelCache.has(node.id)) return labelCache.get(node.id);
    const f = node.callFrame;
    let out = `${f.functionName || '(anon)'} ${basename(f.url) || ''}`;
    const m = f.url ? mapFor(f.url) : null;
    if (m && f.lineNumber >= 0 && f.columnNumber >= 0) {
        const o = originalPositionFor(m, { line: f.lineNumber + 1, column: f.columnNumber });
        if (o.source) out = `${o.name ?? f.functionName ?? '(anon)'} ${o.source.replace(/^.*?(src|node_modules)\//, '$1/')}:${o.line}`;
    }
    labelCache.set(node.id, out);
    return out;
}
const from = fromArg ? Number(fromArg) : 0;
const to = toArg ? Number(toArg) : Infinity;
const self = new Map();
const incl = new Map();
let t = 0;
let total = 0;
profile.samples.forEach((id, i) => {
    const dt = (profile.timeDeltas[i + 1] ?? 0) / 1000;
    t += (profile.timeDeltas[i] ?? 0) / 1000;
    if (t < from || t > to) return;
    const node = byId.get(id);
    const l = label(node);
    if (/^\((idle|program)\)/.test(l)) return;
    const stack = [];
    for (let n = id; n !== undefined; n = parent.get(n)) stack.push(label(byId.get(n)));
    if (focus && !stack.some((s) => s.includes(focus))) return;
    total += dt;
    self.set(l, (self.get(l) ?? 0) + dt);
    for (const s of new Set(stack)) incl.set(s, (incl.get(s) ?? 0) + dt);
});
const show = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${String(Math.round(v)).padStart(7)} ms  ${k}`).join('\n');
console.log(`busy ${Math.round(total)} ms in [${from}, ${to === Infinity ? 'end' : to}]${focus ? ` under ${focus}` : ''}`);
console.log('--- self'); console.log(show(self, 30));
console.log('--- inclusive'); console.log(show(incl, 45));

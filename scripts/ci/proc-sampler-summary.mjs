#!/usr/bin/env node
/**
 * ON A FAILED `unit (windows)` SUITE ONLY: a short picture of the machine beside each failing file (scripts/ci/proc-sampler.ps1).
 * The samples from 10 s before the file started to 10 s after it ended, each with its five busiest processes and the disk
 * queue; then the run's busiest processes overall. Everything else stays in the uploaded artifact. Observe only.
 *   node scripts/ci/proc-sampler-summary.mjs <proc-samples.log> <vitest.json>
 */
import { readFileSync } from 'node:fs';

const [samplesFile, resultsFile] = process.argv.slice(2);
const read = (f) => { try { return readFileSync(f, 'utf8'); } catch { return null; } };
const samples = (read(samplesFile) ?? '').split(/\r?\n/).filter(Boolean).map((line) => {
    // "… cpu>=1s: name#pid[services]=Ns … io: name=MB/s …" (the services and the io part only from the newer sampler).
    const m = /^(\S+) disk_q=(\S+) cpu>=1s: ?(.*?)(?: io: ?(.*))?$/.exec(line);
    if (!m) return null;
    const procs = m[3].split(' ').filter(Boolean).map((p) => { const x = /^(.*)#(\d+)(\[[^\]]*\])?=([\d.]+)s$/.exec(p); return x ? { name: x[1] + (x[3] ?? ''), pid: Number(x[2]), s: Number(x[4]) } : null; }).filter(Boolean);
    const io = (m[4] ?? '').trim();
    return { at: Date.parse(m[1]), iso: m[1], disk: m[2], procs, io };
}).filter(Boolean);
let results = null;
try { results = JSON.parse(read(resultsFile) ?? 'null'); } catch { results = null; }
const failing = (results?.testResults ?? []).filter((t) => t.status === 'failed').map((t) => ({ name: String(t.name).replace(/^.*[\\/]test[\\/]/, 'test/'), start: t.startTime, end: t.endTime }));
console.log(`### sampler: ${samples.length} samples; ${failing.length} failing file(s)`);
const top = (procs, n) => [...procs].sort((a, b) => b.s - a.s).slice(0, n).map((p) => `${p.name}#${p.pid}=${p.s}s`).join(' ') || '-';
for (const f of failing.slice(0, 6)) {
    console.log(`### ${f.name}: ${new Date(f.start).toISOString().slice(11, 19)}–${new Date(f.end).toISOString().slice(11, 19)} (${Math.round((f.end - f.start) / 1000)} s)`);
    for (const s of samples.filter((x) => x.at >= f.start - 10_000 && x.at <= f.end + 10_000).slice(0, 24)) console.log(`###   ${s.iso.slice(11, 19)} disk_q=${s.disk} ${top(s.procs, 5)}${s.io ? ` io: ${s.io}` : ''}`);
}
const total = new Map();
for (const s of samples) for (const p of s.procs) { const k = `${p.name}#${p.pid}`; total.set(k, (total.get(k) ?? 0) + p.s); }
console.log(`### busiest over the run: ${[...total].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}=${Math.round(v)}s`).join(' ')}`);

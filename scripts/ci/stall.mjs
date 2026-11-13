#!/usr/bin/env node
/**
 * DID THE MACHINE STALL DURING THIS ROW? (Tynn #660)
 *
 *   node scripts/ci/stall.mjs <machine-samples.log> <from-ms> <to-ms>
 *
 * Reads the MACHINE lines scripts/ci/machine-sampler.ps1 (Windows) and machine-sampler.sh (Linux) write every ~2 s for
 * the whole gate, and says whether the machine itself stalled between a row's start and end (epoch milliseconds).
 * Exit 0 with one `STALL <kind> <n> s from <iso>: <numbers>` line per stall; 1 with `NO STALL in <n> samples ...`;
 * 3 with `NO SAMPLES ...` when the window has none (the sampler was not running: never read as "no stall" silently);
 * 64 when called wrong. Both gates rerun a FAILED row once when this exits 0 for it, and only then.
 *
 * A stall is the machine waiting while the test is not working, held long enough to break a timed step:
 *   disk   disk queue >= 4 with the CPU under 30 %, for 10 s or more (Windows; the 62c gates on Azure D8ads_v5: queue
 *          6-9 with the CPU idle for ~24 s, while registry writes took 9-14 s and safe-mode, packaged-launcher and
 *          artboard failed). The same queue with the CPU busy is the row working, and is not a stall.
 *   io     PSI io "full" avg10 >= 30 %: every runnable task waiting on the disk, for 10 s or more (Linux).
 *   steal  the hypervisor took >= 25 % of the CPU, for 10 s or more (Linux).
 *   pause  the sampler itself was not run for 5 s past its interval: the whole VM stopped (either OS).
 *
 * A sample at time t describes the time since the one before (its `gap`); the samples of a window [from, to] are those
 * from just after `from` to one interval after `to`.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const RULES = { intervalMs: 2000, pauseMs: 5000, sustainMs: 10000, diskQueue: 4, idleCpu: 30, ioFull: 30, steal: 25 };

/** `MACHINE <epoch-ms> gap=<ms> key=value ...` lines into { t, gap, f: { key: number } }; anything else is skipped. */
export function parseSamples(text) {
    const out = [];
    for (const raw of String(text).split(/\r?\n/)) {
        const m = /^MACHINE (\d{12,}) (.*)$/.exec(raw.trim());
        if (!m) continue;
        const f = {};
        let gap = NaN;
        for (const kv of m[2].split(/\s+/)) {
            const i = kv.indexOf('=');
            if (i < 1) continue;
            const v = Number(kv.slice(i + 1));
            if (!Number.isFinite(v)) continue;
            if (kv.slice(0, i) === 'gap') gap = v; else f[kv.slice(0, i)] = v;
        }
        out.push({ t: Number(m[1]), gap: Number.isFinite(gap) ? gap : RULES.intervalMs, f });
    }
    return out.sort((a, b) => a.t - b.t);
}

const range = (xs) => `${Math.round(Math.min(...xs))}-${Math.round(Math.max(...xs))}`;

const KINDS = [
    { kind: 'disk', hit: (s, r) => s.f.disk_q >= r.diskQueue && s.f.cpu < r.idleCpu, say: (run) => `queue ${range(run.map((s) => s.f.disk_q))}, CPU ${range(run.map((s) => s.f.cpu))} %` },
    { kind: 'io', hit: (s, r) => s.f.io_full >= r.ioFull, say: (run) => `io full ${range(run.map((s) => s.f.io_full))} %` },
    { kind: 'steal', hit: (s, r) => s.f.steal >= r.steal, say: (run) => `steal ${range(run.map((s) => s.f.steal))} %` },
];

/** Every stall in the samples: { kind, from, to, seconds, detail }, in time order. */
export function findStalls(samples, rules = RULES) {
    const stalls = [];
    for (const k of KINDS) {
        let run = [];
        const close = () => {
            if (run.length) {
                const from = run[0].t;
                const to = run[run.length - 1].t;
                const seconds = Math.round((to - from + rules.intervalMs) / 1000);
                if (seconds * 1000 >= rules.sustainMs) stalls.push({ kind: k.kind, from, to, seconds, detail: k.say(run) });
            }
            run = [];
        };
        for (const s of samples) {
            // A pause breaks a run: what the machine did across it is not known.
            if (k.hit(s, rules) && !(run.length && s.gap > rules.intervalMs + rules.pauseMs)) run.push(s);
            else { close(); if (k.hit(s, rules)) run.push(s); }
        }
        close();
    }
    for (const s of samples) {
        if (s.gap > rules.intervalMs + rules.pauseMs) {
            stalls.push({ kind: 'pause', from: s.t - s.gap, to: s.t, seconds: Math.round(s.gap / 1000), detail: `the sampler was not run for ${(s.gap / 1000).toFixed(1)} s (asked every ${rules.intervalMs / 1000} s)` });
        }
    }
    return stalls.sort((a, b) => a.from - b.from);
}

/** The stalls that overlap [from, to], and how many samples describe that window. */
export function stallsBetween(samples, from, to, rules = RULES) {
    const inWindow = samples.filter((s) => s.t > from && s.t <= to + rules.intervalMs).length;
    const stalls = findStalls(samples, rules).filter((s) => s.from <= to + rules.intervalMs && s.to >= from);
    return { samples: inWindow, stalls };
}

export function describeStall(s) {
    return `STALL ${s.kind} ${s.seconds} s from ${new Date(s.from).toISOString()}: ${s.detail}`;
}

function main(argv) {
    const [file, fromArg, toArg] = argv;
    const from = Number(fromArg);
    const to = Number(toArg);
    if (!file || !Number.isFinite(from) || !Number.isFinite(to)) {
        console.log('usage: node scripts/ci/stall.mjs <machine-samples.log> <from-ms> <to-ms>');
        return 64;
    }
    let text;
    try { text = readFileSync(file, 'utf8'); } catch (e) {
        console.log(`NO SAMPLES between ${new Date(from).toISOString()} and ${new Date(to).toISOString()}: ${file} could not be read (${e.code ?? e.message}); the sampler did not run`);
        return 3;
    }
    const r = stallsBetween(parseSamples(text), from, to);
    if (!r.samples) {
        console.log(`NO SAMPLES between ${new Date(from).toISOString()} and ${new Date(to).toISOString()} in ${file}: the sampler was not running then`);
        return 3;
    }
    if (!r.stalls.length) {
        console.log(`NO STALL in ${r.samples} samples between ${new Date(from).toISOString()} and ${new Date(to).toISOString()}`);
        return 1;
    }
    for (const s of r.stalls) console.log(describeStall(s));
    return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));

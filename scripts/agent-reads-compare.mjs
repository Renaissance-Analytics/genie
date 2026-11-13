#!/usr/bin/env node
/**
 * THE VM ROWS OF P4 FAMILY 9A, JUDGED (Tynn #564): two runs of scripts/agent-reads-measure.mjs, the IPC baseline and the
 * door candidate, on the same build and transcript. Within 1.2x of the baseline on time and CPU; the window's longest gap at
 * most 200 ms, whatever the baseline did. A number that is missing fails: an absent measurement is not a pass.
 *
 *   node scripts/agent-reads-compare.mjs <baseline.json> <candidate.json>
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const RATIO = 1.2;
const GAP_MS = 200;
/** A deliberate 120 ms block of the page: a gauge that reports less than this cannot see a gap. */
const CONTROL_MIN_MS = 80;

const RATIO_ROWS = [['m4_5000', 'ms'], ['m4_20000', 'ms'], ['m5', 'windowCpuMs'], ['m5', 'hostCpuMs'], ['m6', 'readMs']];
const GAP_ROWS = [['m4_5000', 'maxGapMs'], ['m4_20000', 'maxGapMs'], ['m5', 'maxGapMs'], ['m6', 'maxGapMs']];

const number = (run, group, key) => { const v = run?.[group]?.[key]; return typeof v === 'number' && Number.isFinite(v) ? v : null; };

/** Numeric verdict only: acquisition, run identity and per-measure controls belong to the opt-in VM job. */
export function comparePairedRuns(report) {
    const pairs = Array.isArray(report?.pairs) ? Array.from(report.pairs) : [];
    const enough = pairs.length >= 3;
    const first = pairs[0]?.order?.[0];
    const ordered = pairs.filter((pair, i) => {
        if (!Array.isArray(pair?.order) || pair.order.length !== 2 || !['ipc', 'door'].includes(first)) return false;
        const start = i % 2 === 0 ? first : first === 'ipc' ? 'door' : 'ipc';
        return pair.order[0] === start && pair.order[1] === (start === 'ipc' ? 'door' : 'ipc');
    }).length;
    const rows = [
        { row: 'pairs.count', base: null, value: pairs.length, limit: 3, pass: enough },
        { row: 'pairs.order', base: null, value: ordered, limit: pairs.length, pass: enough && ordered === pairs.length },
    ];
    const ratio = (base, value) => {
        if (base === null || value === null || base <= 0 || value < 0) return null;
        const result = value / base;
        return Number.isFinite(result) ? result : null;
    };
    // No missing/invalid pair is filtered out: that would let a failed measurement improve the verdict.
    const complete = (values) => enough && values.every((value) => value !== null);
    const median = (values) => {
        const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
        return sorted.length % 2 === 1 ? sorted[middle] : sorted[middle - 1] / 2 + sorted[middle] / 2;
    };
    for (const [group, key] of RATIO_ROWS) {
        const ratios = pairs.map((pair) => ratio(number(pair?.ipc, group, key), number(pair?.door, group, key)));
        const value = complete(ratios) ? median(ratios) : null;
        rows.push({ row: `${group}.${key}`, base: null, value, limit: RATIO, pass: value !== null && value <= RATIO });
    }
    // A bad gap or retained heap is never hidden by the median of the other pairs.
    const maximum = (values) => complete(values) ? values.reduce((max, value) => Math.max(max, value), 0) : null;
    for (const [group, key] of GAP_ROWS) {
        const gaps = pairs.map((pair) => {
            const value = number(pair?.door, group, key);
            return value !== null && value >= 0 ? value : null;
        });
        const value = maximum(gaps);
        rows.push({ row: `${group}.${key}`, base: null, value, limit: GAP_MS, pass: value !== null && value <= GAP_MS });
    }
    const heaps = pairs.map((pair) => {
        const before = number(pair?.door, 'm5', 'heapBeforeBytes'), after = number(pair?.door, 'm5', 'heapAfterGcBytes');
        return pair?.door?.m5?.gc === true && after !== null && after > 0 ? ratio(before, after) : null;
    });
    const heap = maximum(heaps);
    rows.push({ row: 'm5.heapAfterGc', base: null, value: heap, limit: RATIO, pass: heap !== null && heap <= RATIO });
    return rows;
}

export function compareRuns(baseline, candidate) {
    const rows = [];
    for (const [group, key] of RATIO_ROWS) {
        const base = number(baseline, group, key), value = number(candidate, group, key);
        const limit = base === null ? null : base * RATIO;
        rows.push({ row: `${group}.${key}`, base, value, limit, pass: base !== null && value !== null && value <= limit });
    }
    for (const [group, key] of GAP_ROWS) {
        const base = number(baseline, group, key), value = number(candidate, group, key);
        rows.push({ row: `${group}.${key}`, base, value, limit: GAP_MS, pass: value !== null && value <= GAP_MS });
    }
    const control = number(candidate, 'control', 'blockedGapMs');
    rows.push({ row: 'control.blockedGapMs', base: number(baseline, 'control', 'blockedGapMs'), value: control, limit: CONTROL_MIN_MS, pass: control !== null && control >= CONTROL_MIN_MS });
    return rows;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [baselineFile, candidateFile] = process.argv.slice(2);
    if (!baselineFile || !candidateFile) { console.error('usage: agent-reads-compare.mjs <baseline.json> <candidate.json>'); process.exit(2); }
    const rows = compareRuns(JSON.parse(readFileSync(baselineFile, 'utf8')), JSON.parse(readFileSync(candidateFile, 'utf8')));
    for (const r of rows) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.row.padEnd(24)} baseline ${r.base}  candidate ${r.value}  limit ${r.limit}`);
    const bad = rows.filter((r) => !r.pass);
    console.log(bad.length === 0 ? 'ALL ROWS PASS' : `${bad.length} ROW(S) FAILED`);
    process.exit(bad.length === 0 ? 0 : 1);
}

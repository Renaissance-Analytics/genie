#!/usr/bin/env node
/**
 * WHAT HOLDS THE HEAP (Tynn #665): a V8 .heapsnapshot of any size, read as a stream (a renderer at 1-4 GB writes a file
 * far past one JSON.parse), and answered with what RETAINS the window's estate copies:
 *
 *  - every object that looks like an estate snapshot (own properties `agents`, `workspaces` and `deckItems`), counted;
 *  - the self size reachable from all of them together (subtrees they share counted once) and from one of them;
 *  - for a sample of them, oldest to newest by allocation, the SHORTEST retaining path from the GC roots, and the paths
 *    grouped by their shape (edge names, numeric indices folded), so "300 held by a React update queue" reads as one line;
 *  - React hook update objects (`lane`, `action`, `next`, `hasEagerState`) counted;
 *  - the heap by constructor (self size).
 *
 *   node --max-old-space-size=24000 scripts/perf-lag/heap-retainers.mjs <file.heapsnapshot> [out.json]
 */
import { closeSync, openSync, readSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
const outFile = process.argv[3] ?? null;
if (!file) { console.error('usage: heap-retainers.mjs <file.heapsnapshot> [out.json]'); process.exit(2); }

// ---- the stream ----
const fd = openSync(file, 'r');
const CHUNK = 64 << 20;
const buf = Buffer.alloc(CHUNK);
let len = 0, pos = 0, eof = false;
function fill() {
    const rest = len - pos;
    if (rest > 0) buf.copy(buf, 0, pos, len);
    len = rest; pos = 0;
    while (!eof && len < CHUNK) { const n = readSync(fd, buf, len, CHUNK - len, null); if (n === 0) eof = true; len += n; if (n > 0) break; }
}
function byte() { if (pos >= len) { fill(); if (pos >= len) return -1; } return buf[pos++]; }

/** Read up to and including `token`, answering the text before it (for the small header only). */
function readUntil(token, keep) {
    let text = '';
    const want = Buffer.from(token);
    let matched = 0;
    for (;;) {
        const b = byte();
        if (b < 0) throw new Error(`end of file before ${token}`);
        if (keep) text += String.fromCharCode(b);
        if (b === want[matched]) { matched += 1; if (matched === want.length) return keep ? text.slice(0, -want.length) : ''; }
        else matched = b === want[0] ? 1 : 0;
    }
}

/** A JSON array of non-negative integers into `out`, after its `[`. */
function readNumbers(out) {
    let i = 0, n = 0, inNum = false;
    for (;;) {
        if (pos >= len) { fill(); if (pos >= len) throw new Error('end of file in a number array'); }
        const end = len;
        while (pos < end) {
            const c = buf[pos++];
            if (c >= 48 && c <= 57) { n = n * 10 + (c - 48); inNum = true; }
            else {
                if (inNum) { if (i < out.length) out[i] = n; i += 1; n = 0; inNum = false; }
                if (c === 93) return i;
            }
        }
    }
}

/** The JSON array of strings, after its `[`. */
function readStrings() {
    const strings = [];
    const dec = new TextDecoder();
    for (;;) {
        let b = byte();
        while (b === 44 || b === 10 || b === 13 || b === 32) b = byte();
        if (b === 93 || b < 0) return strings;
        if (b !== 34) throw new Error(`unexpected byte ${b} in strings`);
        const parts = [];
        let escaped = false;
        for (;;) {
            if (pos >= len) { fill(); if (pos >= len) throw new Error('end of file in a string'); }
            const start = pos;
            let done = false;
            while (pos < len) {
                const c = buf[pos++];
                if (escaped) { escaped = false; continue; }
                if (c === 92) { escaped = true; continue; }
                if (c === 34) { done = true; break; }
            }
            parts.push(Buffer.from(buf.subarray(start, done ? pos - 1 : pos)));
            if (done) break;
        }
        const raw = dec.decode(parts.length === 1 ? parts[0] : Buffer.concat(parts));
        let s;
        try { s = JSON.parse(`"${raw}"`); } catch { s = raw; }
        strings.push(s);
    }
}

const t0 = Date.now();
const header = JSON.parse(`${readUntil('"nodes":', true).replace(/[,\s]+$/, '')}}`);
const meta = header.snapshot.meta;
const NF = meta.node_fields, W = NF.length, EFD = meta.edge_fields, EW = EFD.length;
const nodeCount = header.snapshot.node_count, edgeCount = header.snapshot.edge_count;
readUntil('[', false);
const nodes = new Uint32Array(nodeCount * W);
const nRead = readNumbers(nodes);
readUntil('[', false);
const edges = new Uint32Array(edgeCount * EW);
const eRead = readNumbers(edges);
readUntil('"strings":', false);
readUntil('[', false);
const strings = readStrings();
closeSync(fd);
const parsedS = Math.round((Date.now() - t0) / 1000);

const iType = NF.indexOf('type'), iName = NF.indexOf('name'), iId = NF.indexOf('id'), iSelf = NF.indexOf('self_size'), iEC = NF.indexOf('edge_count');
const eType = EFD.indexOf('type'), eName = EFD.indexOf('name_or_index'), eTo = EFD.indexOf('to_node');
const nodeTypes = meta.node_types[0], edgeTypes = meta.edge_types[0];
const N = nodeCount;
const T_OBJECT = nodeTypes.indexOf('object'), T_CLOSURE = nodeTypes.indexOf('closure');
const E_WEAK = edgeTypes.indexOf('weak'), E_ELEMENT = edgeTypes.indexOf('element'), E_HIDDEN = edgeTypes.indexOf('hidden'), E_SHORTCUT = edgeTypes.indexOf('shortcut');

const firstEdge = new Uint32Array(N + 1);
for (let n = 0, e = 0; n < N; n += 1) { firstEdge[n] = e; e += nodes[n * W + iEC] * EW; firstEdge[n + 1] = e; }
const nodeName = (n) => strings[nodes[n * W + iName]] ?? '?';
const nodeDesc = (n) => `${nodeTypes[nodes[n * W + iType]]}:${String(nodeName(n)).slice(0, 60)}`;
const edgeLabel = (e) => {
    const t = edges[e + eType], v = edges[e + eName];
    return t === E_ELEMENT || t === E_HIDDEN ? `${edgeTypes[t]}[${v}]` : `${edgeTypes[t]}.${String(strings[v] ?? v).slice(0, 40)}`;
};
const foldedLabel = (e) => edgeLabel(e).replace(/\[\d+\]/g, '[n]');

// ---- estates and React updates ----
const sIdx = (s) => { const out = new Set(); strings.forEach((x, i) => { if (x === s) out.add(i); }); return out; };
const S = Object.fromEntries(['agents', 'workspaces', 'deckItems', 'lane', 'action', 'next', 'hasEagerState'].map((k) => [k, sIdx(k)]));
const estates = [];
let updates = 0;
let totalSelf = 0;
const byCtor = new Map();
for (let n = 0; n < N; n += 1) {
    const t = nodes[n * W + iType], self = nodes[n * W + iSelf];
    totalSelf += self;
    const key = t === T_OBJECT || t === T_CLOSURE ? `${nodeTypes[t]}:${nodeName(n)}` : nodeTypes[t];
    byCtor.set(key, (byCtor.get(key) ?? 0) + self);
    if (t !== T_OBJECT) continue;
    let has = 0;
    for (let e = firstEdge[n]; e < firstEdge[n + 1]; e += EW) {
        if (edges[e + eType] === E_ELEMENT || edges[e + eType] === E_HIDDEN) continue;
        const v = edges[e + eName];
        if (S.agents.has(v)) has |= 1; else if (S.workspaces.has(v)) has |= 2; else if (S.deckItems.has(v)) has |= 4;
        else if (S.lane.has(v)) has |= 8; else if (S.action.has(v)) has |= 16; else if (S.next.has(v)) has |= 32; else if (S.hasEagerState.has(v)) has |= 64;
    }
    if ((has & 7) === 7) estates.push(n);
    if ((has & 120) === 120) updates += 1;
}
estates.sort((a, b) => nodes[a * W + iId] - nodes[b * W + iId]);

// ---- reachable size from the estates ----
const mark = new Uint8Array(N);
function reach(starts, stamp) {
    let size = 0, count = 0;
    const stack = [...starts];
    for (const s of starts) mark[s] = stamp;
    while (stack.length) {
        const n = stack.pop();
        size += nodes[n * W + iSelf]; count += 1;
        for (let e = firstEdge[n]; e < firstEdge[n + 1]; e += EW) {
            const t = edges[e + eType];
            if (t === E_WEAK || t === E_SHORTCUT) continue;
            const to = edges[e + eTo] / W;
            const tt = nodes[to * W + iType];
            // Data only: an estate is plain objects, arrays and strings; never walk into code, contexts or the DOM.
            if (tt === T_CLOSURE || nodeTypes[tt] === 'code' || nodeTypes[tt] === 'hidden' || nodeTypes[tt] === 'native' || nodeTypes[tt] === 'synthetic') continue;
            if (mark[to] === stamp) continue;
            mark[to] = stamp; stack.push(to);
        }
    }
    return { mb: Math.round(size / 1048576), objects: count };
}
const allEstates = estates.length ? reach(estates, 1) : { mb: 0, objects: 0 };
const oneEstate = estates.length ? reach([estates.at(-1)], 2) : { mb: 0, objects: 0 };

// ---- shortest retaining paths: one BFS from the snapshot's root over strong edges ----
const parentEdge = new Int32Array(N).fill(-1);
const parentNode = new Int32Array(N).fill(-1);
{
    const seen = new Uint8Array(N);
    let queue = new Int32Array(1 << 20), qh = 0, qt = 0;
    const push = (n) => { if (qt >= queue.length) { const q = new Int32Array(queue.length * 2); q.set(queue); queue = q; } queue[qt++] = n; };
    seen[0] = 1; push(0);
    while (qh < qt) {
        const n = queue[qh++];
        for (let e = firstEdge[n]; e < firstEdge[n + 1]; e += EW) {
            const t = edges[e + eType];
            if (t === E_WEAK || t === E_SHORTCUT) continue;
            const to = edges[e + eTo] / W;
            if (seen[to]) continue;
            seen[to] = 1; parentEdge[to] = e; parentNode[to] = n; push(to);
        }
        if (qh > 1 << 22 && qh * 2 > qt) { queue = queue.slice(qh, qt); qt -= qh; qh = 0; }
    }
}
function pathOf(n, folded) {
    const steps = [];
    for (let cur = n, guard = 0; cur > 0 && guard < 60; guard += 1) {
        const e = parentEdge[cur];
        if (e < 0) { steps.push('(unreachable from the root)'); break; }
        steps.push(`${nodeDesc(parentNode[cur])} -${folded ? foldedLabel(e) : edgeLabel(e)}->`);
        cur = parentNode[cur];
    }
    return steps.reverse();
}
const sampleIdx = estates.length <= 12 ? estates.map((_, i) => i) : [0, 1, 2, ...[0.25, 0.5, 0.75].map((f) => Math.floor(f * estates.length)), estates.length - 3, estates.length - 2, estates.length - 1];
const samples = [...new Set(sampleIdx)].map((i) => ({ rank: i, id: nodes[estates[i] * W + iId], path: pathOf(estates[i], false) }));
const shapes = new Map();
const step = Math.max(1, Math.floor(estates.length / 400));
for (let i = 0; i < estates.length; i += step) {
    // The shape: the last 8 steps (nearest the estate), indices folded.
    const p = pathOf(estates[i], true).slice(-8).join(' ');
    shapes.set(p, (shapes.get(p) ?? 0) + 1);
}

const result = {
    file, parsedS, nodes: N, edges: edgeCount, nodesRead: nRead / W, edgesRead: eRead / EW, strings: strings.length,
    totalSelfMb: Math.round(totalSelf / 1048576),
    estates: { count: estates.length, reachableTogether: allEstates, newestAlone: oneEstate },
    reactUpdates: updates,
    estatePathShapes: [...shapes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([shape, n]) => ({ n, shape })),
    estatePaths: samples,
    byConstructor: [...byCtor.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${k} ${Math.round(v / 1048576)} MB`),
};
const json = JSON.stringify(result, null, 2);
if (outFile) writeFileSync(outFile, json);
console.log(json);

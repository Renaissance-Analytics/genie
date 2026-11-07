#!/usr/bin/env node
// THE IN-FLIGHT CALL'S BREAK-PROBE (2026-11-01). Run in a test VM (Linux and Windows), from the shipped tree, after
// `npm ci`:
//
//   node scripts/spawn-host-inflight-probe.mjs
//
// test/spawn-host-client.test.ts "a call in flight when the child dies fails with code ESPAWNHOST" now holds its call in
// flight for certain (the fixture never answers it). The probe makes the client NOT raise ESPAWNHOST for the calls a
// lost child held: the test must go red, on that test. Then the file is restored (checked by hash) and must pass.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const TEST = 'test/spawn-host-client.test.ts';
const SOURCE = 'src/main/spawn-host-client.ts';
const NAME = 'a call in flight when the child dies fails with code ESPAWNHOST';
const ANCHOR = "p.reject(Object.assign(new Error(`the spawn host ${why}`), { code: 'ESPAWNHOST' }));";
const BROKEN = "p.reject(Object.assign(new Error(`the spawn host ${why}`), { code: 'EPROBE' })); /* probe: not ESPAWNHOST */";

const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
function vitest() {
    try { return { ok: true, out: plain(execFileSync('npx', ['vitest', 'run', TEST, '--testTimeout=30000'], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })) }; }
    catch (error) { return { ok: false, out: plain(`${error.stdout ?? ''}${error.stderr ?? ''}`) }; }
}
function show(out) {
    const lines = out.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
        if (!lines[i].startsWith(' FAIL ')) continue;
        console.log(`    ${lines[i].trim()}`);
        for (let j = i + 1, k = 0; j < lines.length && k < 3; j += 1) { if (lines[j].startsWith(' ❯ ') || /^⎯/.test(lines[j])) break; if (lines[j].trim()) { console.log(`        ${lines[j].trim()}`); k += 1; } }
    }
}
const sha = (s) => createHash('sha256').update(s.split('\r\n').join('\n')).digest('hex');

let fail = 0;
const original = readFileSync(SOURCE, 'utf8');
try {
    const text = original.split('\r\n').join('\n');
    if (text.split(ANCHOR).length !== 2) { console.log(`PROBE not-espawnhost: anchor missing or not unique in ${SOURCE}`); process.exit(1); }
    writeFileSync(SOURCE, text.replace(ANCHOR, BROKEN));
    const r = vitest();
    if (r.ok) { console.log('PROBE not-espawnhost: STAYED GREEN with ESPAWNHOST not raised (the test is vacuous)'); fail = 1; }
    else if (/Transform failed|PARSE_ERROR|SyntaxError/.test(r.out)) { console.log('PROBE not-espawnhost: BROKEN PROBE: the probed source does not compile'); show(r.out); fail = 1; }
    else if (r.out.split('\n').some((l) => l.startsWith(' FAIL ') && l.includes(NAME))) { console.log(`PROBE not-espawnhost: red as expected (${NAME})`); show(r.out); }
    else { console.log(`PROBE not-espawnhost: red, but not on the expected test (${NAME})`); show(r.out); fail = 1; }
} finally {
    writeFileSync(SOURCE, original);
}
if (sha(readFileSync(SOURCE, 'utf8')) !== sha(original)) { console.log('TREE NOT RESTORED'); fail = 1; }
console.log('=== restored (green expected)');
const green = vitest();
if (green.ok) console.log(green.out.split('\n').filter((l) => /Test Files|Tests /.test(l)).join('\n'));
else { console.log('RESTORE FAILED:'); show(green.out); fail = 1; }
process.exit(fail);

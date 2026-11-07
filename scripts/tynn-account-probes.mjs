#!/usr/bin/env node
// THE TYNN ACCOUNT TESTS' BREAK-PROBES (2026-11-01). Run in a test VM (Windows matters most), from the shipped tree,
// after `npm ci`:
//
//   node scripts/tynn-account-probes.mjs
//
// test/tynn-account.test.ts took 200-264 s on genie-test-windows: every prepare and write went through Genie's private
// credential store, whose ACL work is PowerShell on Windows. Its account tests now keep the file in plain fs (an injected
// store); the permission tests keep the real one. A faster test must still catch what it names, so each probe PUTS A BUG
// BACK and the file must go red on the named test, then the restored file must pass — and the file's duration is printed.
//
//   1. revocation-kept: a 401/419 from /me no longer forgets the credential. The revocation CONTROLs must fail.
//   2. store-ignored: the account ignores the store it is given (the private store always). "the store it is given" fails.
//
// Every failing test's error is printed; the restore is checked by hash against the committed file. Exit 0 only when
// every probe went red where expected and the restore went green.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const TEST = 'test/tynn-account.test.ts';
const SOURCE = 'src/main/tynn-account.ts';

function vitest() {
    try {
        return { ok: true, out: execFileSync('npx', ['vitest', 'run', TEST, '--testTimeout=30000'], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }) };
    } catch (error) {
        return { ok: false, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
    }
}
// vitest colours its output even into a pipe: matches are made with the escapes stripped.
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const duration = (out) => (out.match(/test\/tynn-account\.test\.ts \([^)]*\) (\d+)ms/) ?? [])[1] ?? '?';

/** Each failed test's name and the lines of its error, from vitest's "Failed Tests" section. */
function failures(out) {
    const lines = out.split('\n');
    const found = [];
    for (let i = 0; i < lines.length; i += 1) {
        if (!lines[i].startsWith(' FAIL ')) continue;
        const error = [];
        for (let j = i + 1; j < lines.length && error.length < 4; j += 1) {
            const l = lines[j];
            if (l.startsWith(' FAIL ') || l.startsWith(' ❯ ') || /^⎯/.test(l)) break;
            if (l.trim() !== '') error.push(l.trim());
        }
        found.push({ name: lines[i].trim(), error });
    }
    return found;
}
const show = (out) => { for (const f of failures(out)) { console.log(`    ${f.name}`); for (const l of f.error) console.log(`        ${l}`); } };

const sha = (s) => createHash('sha256').update(s.split('\r\n').join('\n')).digest('hex');
function committed(file) {
    try { return sha(execFileSync('git', ['show', `HEAD:${file}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); } catch { return null; }
}

let fail = 0;
function probe(name, anchor, replacement, expect) {
    const original = readFileSync(SOURCE, 'utf8');
    try {
        const text = original.split('\r\n').join('\n');
        if (text.split(anchor).length !== 2) { console.log(`PROBE ${name}: anchor missing or not unique in ${SOURCE}`); fail = 1; return; }
        writeFileSync(SOURCE, text.replace(anchor, replacement));
        const r = vitest();
        const out = plain(r.out);
        if (r.ok) { console.log(`PROBE ${name}: STAYED GREEN with the bug put back (the tests are vacuous)`); fail = 1; return; }
        // A probe that does not compile ran no test at all: that is a broken PROBE, never a verdict on the tests.
        if (/Transform failed|PARSE_ERROR|SyntaxError/.test(out)) { console.log(`PROBE ${name}: BROKEN PROBE: the probed source does not compile, so no test ran`); show(out); fail = 1; return; }
        const failed = failures(out);
        for (const e of expect) {
            if (failed.some((f) => f.name.includes(e))) console.log(`PROBE ${name}: red as expected (${e})`);
            else { console.log(`PROBE ${name}: NOT red (${e})`); fail = 1; }
        }
        console.log(`  (${duration(out)} ms) the failures, as vitest reported them:`);
        show(out);
    } finally {
        writeFileSync(SOURCE, original);
        if (sha(readFileSync(SOURCE, 'utf8')) !== sha(original)) { console.log(`TREE NOT RESTORED (${SOURCE})`); fail = 1; }
    }
}

probe('revocation-kept',
    'if (res.status === 401 || res.status === 419) { await this.#forget(credential); return; }',
    'if (res.status === 401 || res.status === 419) { return; } /* probe: a revocation kept */',
    ['CONTROL: a 401 from /me is a definite revocation', 'CONTROL: a 419 from /me is a definite revocation', 'through the store it is given']);

probe('store-ignored',
    'return this.#ports.credentials ?? PRIVATE_CREDENTIAL_STORE;',
    // A BLOCK comment: the getter is one line, and a `//` swallowed its closing brace (batch C: a parse error, no test ran).
    'return PRIVATE_CREDENTIAL_STORE; /* probe: the given store ignored */',
    ['through the store it is given']);

for (const file of [SOURCE, TEST]) {
    const head = committed(file);
    const now = sha(readFileSync(file, 'utf8'));
    if (head !== null && head !== now) { console.log(`TREE DIFFERS FROM THE COMMITTED FILE: ${file}`); fail = 1; }
}
console.log('=== restored (green expected)');
const green = vitest();
const out = plain(green.out);
if (green.ok) { console.log(`green in ${duration(out)} ms`); console.log(out.split('\n').filter((l) => /Test Files|Tests /.test(l)).join('\n')); }
else { console.log('RESTORE FAILED: the failures, as vitest reported them:'); show(out); fail = 1; }
process.exit(fail);

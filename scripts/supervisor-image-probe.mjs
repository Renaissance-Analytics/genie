#!/usr/bin/env node
// THE SUPERVISOR IMAGE READ'S BREAK-PROBE (2026-11-01). Windows only. Run in the Windows test VM, from the shipped tree,
// after `npm ci`:
//
//   node scripts/supervisor-image-probe.mjs
//
// test/supervisor-cold-start-windows.test.ts reads the image of the supervisor prism-acp started, to show it is the one in
// Genie's folder. The provider used to end on its own after 5 s, and a PowerShell slower than that to start read a process
// that was gone: an empty image, reported as "not in Genie's folder" (batch A's Windows run, 2026-11-01). The provider now
// lives until the test stops it, and a read of a gone process fails saying so.
//
// The probe PUTS THE RACE BACK, certain to be lost: the provider ends after 200 ms and the read waits 3 s. Both tests that
// read an image must FAIL with "was gone before its image was read" (not as an image elsewhere). The file is restored —
// checked by hash against the committed file — and must then pass. Every failing test's error is printed, in both phases.
// Exit 0 only when both went red that way and the restore went green.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'test/supervisor-cold-start-windows.test.ts';
const TESTS = ['an install upgraded from prism-acp 0.29', 'a build from another supervisor source'];
const EXPECT = 'was gone before its image was read';

if (process.platform !== 'win32') { console.log('PROBE supervisor-image: Windows only (the tests skip elsewhere)'); process.exit(0); }

function vitest() {
    try {
        return { ok: true, out: execFileSync('npx', ['vitest', 'run', FILE], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }) };
    } catch (error) {
        return { ok: false, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
    }
}
// vitest colours its output even into a pipe: matches are made with the escapes stripped.
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** Each failed test's name and the lines of its error, from vitest's "Failed Tests" section. */
function failures(out) {
    const lines = out.split('\n');
    const found = [];
    for (let i = 0; i < lines.length; i += 1) {
        if (!lines[i].startsWith(' FAIL ')) continue;
        const error = [];
        for (let j = i + 1; j < lines.length && error.length < 6; j += 1) {
            const l = lines[j];
            if (l.startsWith(' FAIL ') || l.startsWith(' ❯ ') || /^⎯/.test(l)) break;
            if (l.trim() !== '') error.push(l.trim());
        }
        found.push({ name: lines[i].trim(), error });
    }
    return found;
}
function show(out) {
    for (const f of failures(out)) {
        console.log(`    ${f.name}`);
        for (const l of f.error) console.log(`        ${l}`);
    }
}

const sha = (s) => createHash('sha256').update(s.split('\r\n').join('\n')).digest('hex');
/** The committed file's hash (line endings normalised: a Windows checkout is CRLF), or null when the tree is not a git checkout. */
function committed() {
    try { return sha(execFileSync('git', ['show', `HEAD:${FILE}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); } catch { return null; }
}

const original = readFileSync(FILE, 'utf8');
const head = committed();
console.log(`file as found: ${sha(original).slice(0, 12)}; committed: ${head ? head.slice(0, 12) : '(no git: compared with the file as found)'}`);
let fail = 0;
try {
    const text = original.split('\r\n').join('\n');
    const anchors = [
        ["'setInterval(() => {}, 1000)'", "'setTimeout(() => process.exit(0), 200)'"],
        ['return imageOfLive(tree.supervisorPid);', 'await new Promise((r) => setTimeout(r, 3_000)); return imageOfLive(tree.supervisorPid);'],
    ];
    let probed = text;
    for (const [anchor, replacement] of anchors) {
        if (!probed.includes(anchor)) { console.log(`PROBE supervisor-image: anchor missing (${anchor})`); process.exitCode = 1; throw new Error('anchor missing'); }
        probed = probed.split(anchor).join(replacement);
    }
    writeFileSync(FILE, probed);
    const red = vitest();
    const out = plain(red.out);
    if (red.ok) {
        console.log('PROBE supervisor-image: STAYED GREEN with the race put back (the read proves nothing)'); fail = 1;
    } else {
        const failed = failures(out);
        for (const name of TESTS) {
            const f = failed.find((x) => x.name.includes(name));
            if (!f) { console.log(`PROBE supervisor-image: NOT red (${name})`); fail = 1; }
            else if (!f.error.some((l) => l.includes(EXPECT))) { console.log(`PROBE supervisor-image: red, but not saying "${EXPECT}" (${name})`); fail = 1; }
            else console.log(`PROBE supervisor-image: red as expected (${name})`);
        }
        const others = failed.filter((x) => !TESTS.some((t) => x.name.includes(t)));
        if (others.length > 0) { console.log('PROBE supervisor-image: other tests failed too'); fail = 1; }
        console.log('  the failures, as vitest reported them:');
        show(out);
    }
} finally {
    writeFileSync(FILE, original);
}
const restored = sha(readFileSync(FILE, 'utf8'));
if (restored !== sha(original)) { console.log('TREE NOT RESTORED (differs from the file as found)'); fail = 1; }
else if (head !== null && restored !== head) { console.log(`TREE DIFFERS FROM THE COMMITTED FILE (${restored.slice(0, 12)} vs ${head.slice(0, 12)}): the shipped tree was not HEAD`); fail = 1; }
else console.log(`restored: ${restored.slice(0, 12)}${head !== null ? ' = committed' : ' = as found'}`);

console.log('=== restored (green expected)');
const green = vitest();
const greenOut = plain(green.out);
if (green.ok) console.log(greenOut.split('\n').filter((l) => /Test Files|Tests /.test(l)).join('\n'));
else { console.log('RESTORE FAILED: the failures, as vitest reported them:'); show(greenOut); fail = 1; }
process.exit(fail || process.exitCode || 0);

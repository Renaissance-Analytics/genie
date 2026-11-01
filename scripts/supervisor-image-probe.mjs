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
// read an image must FAIL with "was gone before its image was read" (not as an image elsewhere). The file is restored and
// must then pass. Exit 0 only when both went red that way and the restore went green.
import { execFileSync } from 'node:child_process';
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

const original = readFileSync(FILE, 'utf8');
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
        for (const name of TESTS) {
            const failed = out.split('\n').some((l) => l.includes('FAIL') && l.includes(name));
            if (!failed) { console.log(`PROBE supervisor-image: NOT red (${name})`); fail = 1; } else console.log(`PROBE supervisor-image: red as expected (${name})`);
        }
        const said = out.split('\n').filter((l) => l.includes(EXPECT));
        if (said.length < TESTS.length) { console.log(`PROBE supervisor-image: red, but not saying "${EXPECT}" for each test`); fail = 1; }
        for (const l of [...new Set(said.map((l) => l.trim()))].slice(0, 4)) console.log(`    ${l}`);
    }
} finally {
    writeFileSync(FILE, original);
}
if (readFileSync(FILE, 'utf8') !== original) { console.log('TREE NOT RESTORED'); fail = 1; }

console.log('=== restored (green expected)');
const green = vitest();
const summary = plain(green.out).split('\n').filter((l) => /Test Files|Tests /.test(l));
if (green.ok) console.log(summary.join('\n'));
else { console.log('RESTORE FAILED'); console.log(plain(green.out).split('\n').filter((l) => /×|FAIL|Tests /.test(l)).slice(0, 10).join('\n')); fail = 1; }
process.exit(fail || process.exitCode || 0);

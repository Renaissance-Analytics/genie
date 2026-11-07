#!/usr/bin/env node
/**
 * WHEN DOES THE SHELL LOSE THE HELPER'S FD? (batch S, test/fancy-pty-lifecycle.test.ts test 2.) Native helper, listening socket on fd 3
 * without close-on-exec, the child read as early as possible: stopped with SIGSTOP the moment it is seen, read, let go, then read again
 * after it has exec'd. Linux, in a test VM or CI.
 *
 *   node scripts/perf-lag/fancy-pty-fd-race.mjs --expect closed                     # the installed fancy-pty (0.2.1)
 *   npm install --prefix /tmp/fp014 --no-save --ignore-scripts @particle-academy/fancy-pty@0.1.4
 *   node scripts/perf-lag/fancy-pty-fd-race.mjs --expect leaks --pkg /tmp/fp014/node_modules/@particle-academy/fancy-pty
 *
 * What it answers, for each version:
 *   held-after-exec: 0 of N means no leak; N of N means the shell really holds it. This is the test's claim.
 *   caught-before-exec / held-before-exec: how often the child was caught between fork and exec, and held the fd then. Held there with
 *   none after exec is the race: a read at that moment reports a leak that does not exist. caught-before-exec=0 means the race
 *   was not forced in this run, and proves nothing either way.
 *
 * Prints `### fancy-pty-race ...`; exit 0 when held-after-exec is what --expect says. Capped at 120 s. Never on the owner's desktop.
 */
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (!process.env.CI && userInfo().username !== 'genie') { console.error('refusing: test machines only'); process.exit(2); }
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const expected = arg('--expect', 'closed');
const pkg = resolve(arg('--pkg', 'node_modules/@particle-academy/fancy-pty'));
const RUNS = Number(arg('--runs', '40'));
setTimeout(() => { console.log('### fancy-pty-race=FAIL  the 120 s cap'); process.exit(1); }, 120_000).unref();

const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
const dot = manifest.exports?.['.'];
const entry = typeof dot === 'string' ? dot : dot?.import?.default ?? dot?.import ?? dot?.default ?? manifest.main;
const { encodeSpawn, frame, helperPath } = await import(pathToFileURL(join(pkg, entry)).href);
const SLEEP = realpathSync('/bin/sleep');
const childrenOf = (pid) => { try { return readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number); } catch { return []; } };
const exeOf = (pid) => { try { return readlinkSync(`/proc/${pid}/exe`); } catch { return null; } };
const holds = (pid, target) => { try { return readdirSync(`/proc/${pid}/fd`).some((fd) => { try { return readlinkSync(`/proc/${pid}/fd/${fd}`) === target; } catch { return false; } }); } catch { return false; } };
const signal = (pid, name) => { try { process.kill(pid, name); } catch { /* gone */ } };

const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const fd = server._handle.fd;
const inode = readlinkSync(`/proc/self/fd/${fd}`);

let caught = 0;
let heldBefore = 0;
let heldAfter = 0;
let helperHeld = 0;
let finished = 0;
for (let run = 0; run < RUNS; run += 1) {
    const helper = spawn(helperPath(), [], { stdio: ['pipe', 'pipe', 'pipe', fd] });
    helper.stdout.resume();
    helper.stderr.resume();
    const wrote = new Promise((r) => helper.stdin.write(frame(0, encodeSpawn({ argv: ['/bin/sleep', '300'], cwd: tmpdir(), env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, cols: 80, rows: 24 })), r));
    // Spinning, on purpose: a timer would miss the window between fork and exec. Starts before the write has finished, for the same reason.
    let child = null;
    const spinUntil = Date.now() + 5_000;
    await Promise.race([wrote, new Promise((r) => setImmediate(r))]);
    while (child === null && Date.now() < spinUntil) child = childrenOf(helper.pid)[0] ?? null;
    if (child !== null) {
        signal(child, 'SIGSTOP');
        if (exeOf(child) !== SLEEP) {
            caught += 1;
            if (holds(child, inode)) heldBefore += 1;
        }
        signal(child, 'SIGCONT');
        const execUntil = Date.now() + 5_000;
        while (exeOf(child) !== SLEEP && Date.now() < execUntil) await new Promise((r) => setTimeout(r, 2));
        if (exeOf(child) === SLEEP) {
            finished += 1;
            if (holds(child, inode)) heldAfter += 1;
        }
        if (holds(helper.pid, inode)) helperHeld += 1;
        signal(child, 'SIGKILL');
    }
    signal(helper.pid, 'SIGKILL');
    await new Promise((r) => helper.once('exit', r));
}
server.close();

console.log(`### fancy-pty-race version=${manifest.version} runs=${RUNS} execd=${finished} control-helper-held=${helperHeld} caught-before-exec=${caught} held-before-exec=${heldBefore} held-after-exec=${heldAfter}`);
if (caught === 0) console.log('### fancy-pty-race note: no child was caught before exec in this run, so the race was not forced');
const controlOk = finished === RUNS && helperHeld === RUNS;
const claimOk = expected === 'leaks' ? heldAfter === finished && finished > 0 : heldAfter === 0;
console.log(`### fancy-pty-race=${controlOk && claimOk ? 'PASS' : 'FAIL'}  expected ${expected}${controlOk ? '' : '; the control did not hold'}`);
process.exit(controlOk && claimOk ? 0 : 1);

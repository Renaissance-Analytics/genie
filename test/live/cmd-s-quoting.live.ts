/**
 * genie#1428 — DOES `cmd /d /s /c` MANGLE A QUOTED PATH WITH SPACES? Measured, not argued: the hypothesis is that a
 * supervised command line such as `"C:\dir with spaces\node.exe" probe.cjs` (a person's own Procfile/site command, run
 * with `shell: true`) reaches cmd as `C:\dir with spaces\node.exe probe.cjs` — /s strips the line's first quote and its
 * LAST quote — and fails at the space.
 *
 * Run in the WINDOWS TEST VM only, from the shipped tree after `npm ci`:
 *
 *     npx tsx test/live/cmd-s-quoting.live.ts
 *
 * It drives the REAL path a supervised process takes: `shellLaunch` (core/shell-launch.ts) through the spawn host's own
 * pty engine (fancy-term-host's in-process backend via `fancyTermPort`, exactly as src/main/spawn-host.ts builds it), and
 * prints one PASS/FAIL line per case with what the process printed. Each case runs a tiny script that prints a marker,
 * so "it ran" is seen, never inferred from an exit code. Cases:
 *
 *   CONTROL  a quoted executable path WITHOUT spaces — must run (proves the gauge sees a run);
 *   H1       a quoted executable path WITH spaces — the hypothesis says it does NOT run today;
 *   H2       the same, with a quoted script argument that also has spaces;
 *   H3       an unquoted bare command with a quoted, spaced argument (`node "dir with spaces\probe.cjs"`), the shape most
 *            people write — must keep working under any remedy;
 *   R1-R3    the candidate remedy, measured on the same lines: the whole line wrapped once more, `cmd /d /s /c "<line>"`.
 *
 * It changes nothing in Genie: R* builds its own launch beside `shellLaunch` to measure the remedy before anyone ships it.
 * Exit 0 always once every case ran (the verdict is the table, for a person to read); 2 on a timeout.
 */
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureInProcessBackend, inProcessBackend, resolveDefaultShell } from '@particle-academy/fancy-term-host';
import { shellLaunch } from '../../src/core/shell-launch.js';
import { fancyTermPort } from '../../src/main/fancy-term-port.js';
import type { PtyPort } from '../../src/main/terminal-host.js';

if (process.platform !== 'win32') {
    console.log('cmd-s-quoting: Windows only (cmd.exe /s); nothing to measure here.');
    process.exit(0);
}

setTimeout(() => { console.log('CMD-S PROBE FAILED (timeout)'); process.exit(2); }, 120_000).unref();

const settings = { get: (key: string) => (key === 'track_cwd' ? 'off' : key === 'detached_terminals' ? 'off' : undefined) };
configureInProcessBackend({
    settings,
    snapshots: { writeSnapshot: () => null, readSnapshot: () => null, deleteSnapshot: () => {}, encrypting: () => false },
} as unknown as Parameters<typeof configureInProcessBackend>[0]);
const backend = inProcessBackend();
const pty: PtyPort = fancyTermPort(backend, { defaultShell: () => resolveDefaultShell(settings) });

// The fixtures: node.exe copied into a folder with spaces and one without; a script that prints a marker, in each.
const base = mkdtempSync(join(tmpdir(), 'cmds-'));
const spaced = join(base, 'dir with spaces');
const plain = join(base, 'plain');
mkdirSync(spaced);
mkdirSync(plain);
copyFileSync(process.execPath, join(spaced, 'node.exe'));
copyFileSync(process.execPath, join(plain, 'node.exe'));
const MARK = 'CMDS-PROBE-RAN';
writeFileSync(join(plain, 'probe.cjs'), `console.log('${MARK} ' + process.argv.slice(2).join('|'));\n`);
writeFileSync(join(spaced, 'probe arg.cjs'), `console.log('${MARK} ' + process.argv.slice(2).join('|'));\n`);

const lines: Array<{ name: string; line: string; cwd: string }> = [
    { name: 'CONTROL quoted path, no spaces', line: `"${join(plain, 'node.exe')}" probe.cjs ok`, cwd: plain },
    { name: 'H1 quoted path WITH spaces', line: `"${join(spaced, 'node.exe')}" "${join(plain, 'probe.cjs')}" ok`, cwd: plain },
    { name: 'H2 quoted path and quoted argument, both spaced', line: `"${join(spaced, 'node.exe')}" "${join(spaced, 'probe arg.cjs')}" ok`, cwd: plain },
    { name: 'H3 bare command, quoted spaced argument', line: `node "${join(spaced, 'probe arg.cjs')}" ok`, cwd: plain },
];

/**
 * One launch with an EXACT argv, through the same engine (`backend.create`, what fancyTermPort's open calls with
 * `shellLaunch`'s answer): how the remedy's argv is measured without changing Genie.
 */
let seq = 0;
function run(launch: { command: string; args: string[] }, cwd: string): Promise<{ out: string; code: number }> {
    return new Promise((resolve) => {
        let out = '';
        const id = `cmds_${++seq}`;
        const offData = pty.onData((pid, data) => { if (pid === id) out += data; });
        const offExit = pty.onExit((pid, code) => {
            if (pid !== id) return;
            offData(); offExit();
            resolve({ out, code });
        });
        const created = backend.create({ id, cwd, shell: launch.command, args: launch.args });
        if (!(created.pid > 0)) { offData(); offExit(); resolve({ out: `(engine could not start it, pid ${created.pid})`, code: -1 }); }
    });
}

/** Today's path, exactly: the line through `pty.open({ shell: true })` (shellLaunch → cmd.exe /d /s /c <line>). */
function runShellLine(line: string, cwd: string): Promise<{ out: string; code: number }> {
    return new Promise((resolve) => {
        let out = '';
        const opened = pty.open({ cwd, command: line, shell: true });
        const offData = pty.onData((id, data) => { if (id === opened.id) out += data; });
        const offExit = pty.onExit((id, code) => {
            if (id !== opened.id) return;
            offData(); offExit();
            resolve({ out, code });
        });
    });
}

const verdict = (out: string) => out.includes(MARK);
const clean = (out: string) => out.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);

console.log(`today's launch for a line: ${JSON.stringify(shellLaunch('win32', () => ({ command: 'cmd.exe', args: [] }), '<line>'))}`);
for (const c of lines) {
    const today = await runShellLine(c.line, c.cwd);
    console.log(`${verdict(today.out) ? 'RAN   ' : 'NO RUN'}  today   ${c.name} (exit ${today.code}) — ${clean(today.out)}`);
}
for (const c of lines) {
    // THE REMEDY, measured: the whole line wrapped once more, so /s strips the wrapper and leaves the line intact.
    const remedy = await run({ command: 'cmd.exe', args: ['/d', '/s', '/c', `"${c.line}"`] }, c.cwd);
    console.log(`${verdict(remedy.out) ? 'RAN   ' : 'NO RUN'}  remedy  ${c.name} (exit ${remedy.code}) — ${clean(remedy.out)}`);
}
console.log('CMD-S PROBE DONE: read the table. Expected if genie#1428 is real: CONTROL ran today; H1/H2 did NOT run today; every row ran under the remedy.');
process.exit(0);

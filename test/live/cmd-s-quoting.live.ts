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
 *   E1-E3    what a person's line also does: two commands with &&, a pipe, a %VARIABLE%. Whatever replaces today's launch must keep these.
 *
 * MEASURED ON THE VM (batch HH): the CONTROL did not run either. Nothing was wrong with the probe: "today" is the product's own path. The pty engine takes a LIST and joins it for CreateProcessW by the C runtime's rules
 * (fancy-pty's documented contract: "the helper owns that join"), so each `"` in the line reaches cmd as `\"`, which cmd does not read as a quote. So today no supervised command with a quote in it runs on Windows, spaces or
 * not. Wrapping the line, the remedy genie#1428 proposed, failed the same way. service-exec.ts escapes this with windowsVerbatimArguments, which a pty has no equivalent of. These remedies put no quote in the argv at all:
 *
 *   env       `cmd /d /s /c %GENIE_SHELL_LINE%`, the line in the environment. cmd expands it before it reads quotes, so they are real quotes. It expands once, so a %VARIABLE% inside stays literal: E3 says so.
 *   env+vars  the same, with each %NAME% this environment defines already replaced in the line. The one change from cmd's own reading: an undefined %NAME% stays as it is, which is what cmd /c does too.
 *
 * It changes nothing in Genie: each remedy builds its own launch beside `shellLaunch` to measure it before anyone ships it.
 * Exit 0 always once every case ran (the verdict is the table, for a person to read); 2 on a timeout.
 */
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureInProcessBackend, inProcessBackend, resolveDefaultShell } from '@particle-academy/fancy-term-host';
import { ptyShellLaunch } from '../../src/core/shell-launch.js';
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
    // The marker is built when it runs: a window title carries the command line, so a marker in the line could read as a run.
    { name: 'E1 two commands with && and a quote', line: `node -e "console.log('CMDS-'+'PROBE-RAN')" && echo second`, cwd: plain },
    { name: 'E2 a pipe, no quotes', line: `node probe.cjs ok | findstr PROBE`, cwd: plain },
    { name: 'E3 a %VARIABLE%', line: `echo %CMDS_PROBE_VAR%`, cwd: plain },
];
process.env.CMDS_PROBE_VAR = MARK;

/**
 * One launch with an EXACT argv, through the same engine (`backend.create`, what fancyTermPort's open calls with
 * `shellLaunch`'s answer): how the remedy's argv is measured without changing Genie.
 */
let seq = 0;
function run(launch: { command: string; args: string[]; env?: Record<string, string> }, cwd: string): Promise<{ out: string; code: number }> {
    return new Promise((resolve) => {
        let out = '';
        const id = `cmds_${++seq}`;
        const offData = pty.onData((pid, data) => { if (pid === id) out += data; });
        const offExit = pty.onExit((pid, code) => {
            if (pid !== id) return;
            offData(); offExit();
            resolve({ out, code });
        });
        const created = backend.create({ id, cwd, shell: launch.command, args: launch.args, ...(launch.env ? { env: launch.env } : {}) });
        if (!(created.pid > 0)) { offData(); offExit(); resolve({ out: `(engine could not start it, pid ${created.pid})`, code: -1 }); }
    });
}

/** Today's path, exactly: the line through `pty.open({ shell: true })` (ptyShellLaunch: cmd.exe /d /s /c %GENIE_SHELL_LINE%, since genie#1428). */
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

// Window titles (OSC) out first: they carry the command line.
const plainOf = (out: string) => out.replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g, '').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
const verdict = (out: string) => plainOf(out).includes(MARK);
const clean = (out: string) => plainOf(out).replace(/\s+/g, ' ').trim().slice(0, 200);
const SHELL_LINE = '%GENIE_SHELL_LINE%';
const envLaunch = (line: string) => ({ command: 'cmd.exe', args: ['/d', '/s', '/c', SHELL_LINE], env: { GENIE_SHELL_LINE: line } });
const expanded = (line: string) => line.replace(/%([^%\s=]+)%/g, (whole, name: string) => process.env[name] ?? whole);

console.log(`the product's launch for a line: ${JSON.stringify(ptyShellLaunch('win32', () => ({ command: 'cmd.exe', args: [] }), '<line>', {}))}`);
for (const c of lines) {
    const today = await runShellLine(c.line, c.cwd);
    console.log(`${verdict(today.out) ? 'RAN   ' : 'NO RUN'}  today   ${c.name} (exit ${today.code}) — ${clean(today.out)}`);
}
for (const c of lines) {
    const remedy = await run(envLaunch(c.line), c.cwd);
    console.log(`${verdict(remedy.out) ? 'RAN   ' : 'NO RUN'}  env     ${c.name} (exit ${remedy.code}) — ${clean(remedy.out)}`);
}
for (const c of lines) {
    const remedy = await run(envLaunch(expanded(c.line)), c.cwd);
    console.log(`${verdict(remedy.out) ? 'RAN   ' : 'NO RUN'}  env+vars ${c.name} (exit ${remedy.code}) — ${clean(remedy.out)}`);
}
console.log('CMD-S PROBE DONE: read the table. Expected since the genie#1428 fix: today (the product path itself) runs every row, as env+vars does; env runs all but E3.');
process.exit(0);

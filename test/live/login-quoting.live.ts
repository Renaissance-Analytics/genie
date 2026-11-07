/**
 * genie#1428's REACH: DOES A PROVIDER'S SIGN-IN RUN ON WINDOWS? The real LoginHost, the real TerminalHost, a real pty (fancy-pty through fancyTermPort, as src/main/spawn-host.ts builds it), and a stub `claude`. In the Windows test VM only:
 *
 *     npx tsx test/live/login-quoting.live.ts
 *
 * From reading: `providerBinary` answers only GENIE2_<PROVIDER>_BINARY, a developer's override, so on an ordinary machine the line is `claude auth login`, with no quote in it, and it should run. With the override set the line is
 * `"<path>" auth login`, and a quote in a shell line is what batch HH saw cmd refuse. This measures both, and an agent's terminal with a quoted command, which reaches the same launch.
 *
 * Prints `### login-quoting <case>=RAN|NO RUN  what it printed`. The verdict is read by a person; exit 1 only when the ordinary case does not run, which is the control that this can see a run at all.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { configureInProcessBackend, inProcessBackend, resolveDefaultShell } from '@particle-academy/fancy-term-host';
import { fancyTermPort } from '../../src/main/fancy-term-port.js';
import { LoginHost } from '../../src/main/login-host.js';
import { TerminalHost } from '../../src/main/terminal-host.js';

if (process.platform !== 'win32') {
    console.log('login-quoting: Windows only; nothing to measure here.');
    process.exit(0);
}
setTimeout(() => { console.log('### login-quoting=FAILED (timeout)'); process.exit(2); }, 120_000).unref();

const settings = { get: (key: string) => (key === 'track_cwd' ? 'off' : key === 'detached_terminals' ? 'off' : undefined) };
configureInProcessBackend({
    settings,
    snapshots: { writeSnapshot: () => null, readSnapshot: () => null, deleteSnapshot: () => {}, encrypting: () => false },
} as unknown as Parameters<typeof configureInProcessBackend>[0]);
const terminals = new TerminalHost(fancyTermPort(inProcessBackend(), { defaultShell: () => resolveDefaultShell(settings) }));

// The stub's marker is split in its file, and the verdict reads no window title: a title carries the command line.
const MARK = 'LOGIN-STUB-RAN';
const stub = `@echo off\r\nset a=LOGIN-STUB\r\necho %a%-RAN %*\r\n`;
const base = mkdtempSync(join(tmpdir(), 'login-quoting-'));
const onPath = join(base, 'on path');
const plain = join(base, 'plain');
const spaced = join(base, 'dir with spaces');
for (const dir of [onPath, plain, spaced]) { mkdirSync(dir); writeFileSync(join(dir, 'claude.cmd'), stub); }
process.env.PATH = `${onPath}${delimiter}${process.env.PATH ?? ''}`;

const plainOf = (out: string) => out.replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g, '').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
const words = (out: string) => plainOf(out).replace(/\s+/g, ' ').trim().slice(0, 180);

function finished(id: string, take: (off: () => void, out: () => string) => void): void {
    let text = '';
    const offData = terminals.onData((t, data) => { if (t === id) text += data; });
    take(offData, () => text);
}

async function viaLogin(binary: string | null): Promise<{ ran: boolean; out: string }> {
    return new Promise((resolve, reject) => {
        let text = '';
        let target = '';
        const offData = terminals.onData((t, data) => { if (target === '' || t === target) text += data; });
        const offExit = terminals.onExit((t) => {
            if (t !== target) return;
            offData();
            offExit();
            resolve({ ran: plainOf(text).includes(MARK), out: words(text) });
        });
        const logins = new LoginHost({ terminals, openWindow: () => {}, runStatus: async () => 1, onSignedIn: () => {}, binaryFor: () => binary, scratch: () => base });
        const started = logins.start('claude');
        if (!started.ok) { reject(new Error(started.reason)); return; }
        target = started.terminalId;
    });
}

async function viaAgentTerminal(command: string): Promise<{ ran: boolean; out: string }> {
    return new Promise((resolve) => {
        let text = '';
        let target = '';
        const offData = terminals.onData((t, data) => { if (target === '' || t === target) text += data; });
        const offExit = terminals.onExit((t) => {
            if (t !== target) return;
            offData();
            offExit();
            resolve({ ran: plainOf(text).includes(MARK), out: words(text) });
        });
        // What mcp-tools-more.ts's `create` hands the terminals.
        target = terminals.open({ workspaceId: '__genie__', cwd: base, command, shell: true, limited: false }).id;
    });
}

const say = (name: string, r: { ran: boolean; out: string }) => console.log(`### login-quoting ${name}=${r.ran ? 'RAN' : 'NO RUN'}  ${r.out}`);

const ordinary = await viaLogin(null);
say('ordinary-machine-the-cli-on-path', ordinary);
say('override-set-a-path-with-no-spaces', await viaLogin(join(plain, 'claude.cmd')));
say('override-set-a-path-with-spaces', await viaLogin(join(spaced, 'claude.cmd')));
say('agent-terminal-no-quote', await viaAgentTerminal('claude hello'));
say('agent-terminal-a-quoted-argument', await viaAgentTerminal('claude "hello there"'));
console.log(`### login-quoting=${ordinary.ran ? 'DONE' : 'CONTROL-FAILED'}`);
process.exit(ordinary.ran ? 0 : 1);

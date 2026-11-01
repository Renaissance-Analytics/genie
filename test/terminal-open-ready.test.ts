import { describe, expect, it } from 'vitest';
import { SpawnHostClient } from '../src/main/spawn-host-client.js';
import type { SpawnChannel, SpawnFrame } from '../src/main/spawn-host-protocol.js';
import { serveSpawnHost } from '../src/main/spawn-host-server.js';
import { TerminalHost, type PtyOpened, type PtyPort, type PtySpawnOptions } from '../src/main/terminal-host.js';

/**
 * A TERMINAL OPENED UNDER genie-host ANSWERS WITH ITS PID AND ITS SHELL (the host split, P2.1; CI's real window,
 * 2026-11-01: "a Workspace terminal opened (pid reported) — pid 0, shell ").
 *
 * Under genie-host the pty is made in another process, so `open` answers before the process exists: pid 0, and the
 * shell is whatever the caller named ('' for the default shell). The person's terminal tab shows the shell, and an agent's
 * `manageTerminals create` hands back the pid, so whoever ASKS for a terminal must get the real ones: the spawn host says
 * the resolved shell with the pid, the client passes both on, and the terminal host answers `openReady` once it knows them
 * (and keeps them in its list). A pty that ends before it ever had a pid answers 0 rather than hanging.
 */

function fakeEngine() {
    let n = 0;
    const port: PtyPort = {
        open: (_o: PtySpawnOptions): PtyOpened => { n += 1; return { id: `e${n}`, pid: 5000 + n, shell: '/bin/bash', scrollback: '' }; },
        write: () => true,
        resize: () => true,
        kill: () => true,
        scrollback: () => '',
        onData: () => () => {},
        onExit: () => () => {},
    };
    return port;
}

/** A port that makes its ptys elsewhere: open answers pid 0; the test says the pid (and shell), or ends it. */
function remotePort() {
    const pid = new Set<(id: string, pid: number, shell?: string) => void>();
    const exit = new Set<(id: string, code: number) => void>();
    let n = 0;
    const port: PtyPort = {
        open: (o: PtySpawnOptions): PtyOpened => { n += 1; return { id: `term_${n}`, pid: 0, shell: o.command ?? '', scrollback: '' }; },
        write: () => true,
        resize: () => true,
        kill: () => true,
        scrollback: () => undefined,
        onData: () => () => {},
        onExit: (l) => { exit.add(l); return () => exit.delete(l); },
        onPid: (l) => { pid.add(l); return () => pid.delete(l); },
    };
    return {
        port,
        sayPid: (id: string, p: number, shell?: string) => { for (const l of pid) l(id, p, shell); },
        end: (id: string, code: number) => { for (const l of exit) l(id, code); },
    };
}

describe('the spawn host says the shell it started', () => {
    it('pty.opened carries the resolved shell beside the pid, and pty.list answers it too', () => {
        const frames: SpawnFrame[] = [];
        const toHost = new Set<(f: SpawnFrame) => void>();
        const channel: SpawnChannel = { send: (f) => frames.push(JSON.parse(JSON.stringify(f)) as SpawnFrame), onFrame: (l) => { toHost.add(l); }, onClose: () => {} };
        serveSpawnHost(channel, { exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }) as never, stream: (() => ({ stop() {} })) as never, pty: fakeEngine() });
        for (const l of toHost) l({ kind: 'call', id: 0, method: 'pty.open', args: ['term_a', { cwd: '/w' }, { kind: 'terminal', workspaceId: 'ws', shell: '' }] });
        expect(frames).toContainEqual({ kind: 'event', channel: 'pty.opened', payload: { id: 'term_a', pid: 5001, shell: '/bin/bash' } });
        for (const l of toHost) l({ kind: 'call', id: 3, method: 'pty.list', args: [] });
        const listed = frames.find((f) => f.kind === 'result' && f.id === 3) as Extract<SpawnFrame, { kind: 'result'; ok: true }>;
        expect(listed.value).toEqual([expect.objectContaining({ id: 'term_a', pid: 5001, shell: '/bin/bash' })]);
    });

    it('the client passes the shell on with the pid', async () => {
        const sent: SpawnFrame[] = [];
        const client = new SpawnHostClient({ entry: 'never-forked.js', link: { send: (f) => sent.push(f) } });
        const up = client.linkUp();
        const list = sent.find((f) => f.kind === 'call' && f.method === 'pty.list') as Extract<SpawnFrame, { kind: 'call' }>;
        client.linkFrame({ kind: 'result', id: list.id, ok: true, value: [] });
        await up;
        const pty = client.ptyPort();
        const said: Array<[string, number, string | undefined]> = [];
        pty.onPid?.((id, pid, shell) => { said.push([id, pid, shell]); });
        const opened = pty.open({ cwd: '/w' });
        client.linkFrame({ kind: 'event', channel: 'pty.opened', payload: { id: opened.id, pid: 777, shell: '/bin/zsh' } });
        expect(said).toEqual([[opened.id, 777, '/bin/zsh']]);
    });

    it('an adopted terminal keeps the shell the spawn host started, not the empty name it was asked for', () => {
        const host = new TerminalHost(remotePort().port);
        host.adopt({ id: 'term_z', pid: 4242, tag: { kind: 'terminal', workspaceId: 'ws', shell: '' }, shell: '/bin/bash', scrollback: '' });
        expect(host.attach('term_z')).toMatchObject({ pid: 4242, shell: '/bin/bash' });
    });
});

describe('TerminalHost.openReady', () => {
    it('answers once the pid is known, with the real pid and shell; the list holds them too', async () => {
        const remote = remotePort();
        const host = new TerminalHost(remote.port);
        let answered: PtyOpened | null = null;
        const ready = host.openReady({ workspaceId: 'ws', cwd: '/w' }).then((o) => { answered = o; return o; });
        await Promise.resolve();
        expect(answered).toBeNull(); // not before the process exists
        remote.sayPid('term_1', 4242, '/bin/bash');
        expect(await ready).toMatchObject({ id: 'term_1', pid: 4242, shell: '/bin/bash' });
        expect(host.list()).toEqual([expect.objectContaining({ id: 'term_1', pid: 4242, shell: '/bin/bash' })]);
    });

    it('a port that knows the pid at once answers at once', async () => {
        const host = new TerminalHost(fakeEngine());
        expect(await host.openReady({ workspaceId: 'ws', cwd: '/w' })).toMatchObject({ pid: 5001, shell: '/bin/bash' });
    });

    it('a pty that ends before it had a pid answers pid 0 — never a hang', async () => {
        const remote = remotePort();
        const host = new TerminalHost(remote.port);
        const ready = host.openReady({ workspaceId: 'ws', cwd: '/w' });
        remote.end('term_1', -1);
        expect(await ready).toMatchObject({ id: 'term_1', pid: 0 });
    });

    it('a pid with no shell keeps the name it had', async () => {
        const remote = remotePort();
        const host = new TerminalHost(remote.port);
        const ready = host.openReady({ workspaceId: 'ws', cwd: '/w', command: 'htop' });
        remote.sayPid('term_1', 99);
        expect(await ready).toMatchObject({ pid: 99, shell: 'htop' });
    });
});

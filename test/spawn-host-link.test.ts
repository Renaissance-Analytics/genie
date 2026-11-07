import { describe, expect, it } from 'vitest';
import { SpawnHostClient } from '../src/main/spawn-host-client.js';
import type { ListedPty, SpawnFrame } from '../src/main/spawn-host-protocol.js';

/**
 * THE SPAWN HOST OVER A LINK (the host split, P2.1: plan §11a). Under genie-host the spawn host is the HOST's child, and
 * the window reaches it through the engine link. So the window's client has a second transport: a link it is given,
 * whose loss is NOT the child's loss — nothing is killed and nothing reported exited when the link drops. When the link
 * comes back the client asks what is still running and reconciles: what it knew and is gone is reported exited (-1),
 * what it did not know is handed back for the supervisor and the terminals to adopt.
 */

function linked(options: { linkWaitMs?: number } = {}) {
    const sent: SpawnFrame[] = [];
    const killed: number[] = [];
    const client = new SpawnHostClient({ entry: 'never-forked.js', link: { send: (f) => sent.push(f) }, killPid: (pid) => killed.push(pid), ...options });
    /** Answer the client's next call of `method` (it is in `sent`) with `value`, as the spawn host would. */
    const answer = (method: string, value: unknown) => {
        const call = [...sent].reverse().find((f) => f.kind === 'call' && f.method === method) as Extract<SpawnFrame, { kind: 'call' }> | undefined;
        if (!call) throw new Error(`no ${method} call was sent`);
        client.linkFrame({ kind: 'result', id: call.id, ok: true, value });
    };
    return { client, sent, killed, answer };
}

const listed = (over: Partial<ListedPty> = {}): ListedPty => ({ id: 'term_x', pid: 4242, tag: { kind: 'process', processId: 'site:shop', workspaceId: 'ws' }, scrollback: 'listening\r\n', ...over });

describe('a spawn host reached over a link', () => {
    it('forks nothing, and a pty opened while the link is up goes over it with its tag', async () => {
        const { client, sent, answer } = linked();
        const up = client.linkUp();
        answer('pty.list', []);
        expect(await up).toEqual([]);
        const pty = client.ptyPort();
        const opened = pty.open({ cwd: '/w', command: 'php artisan serve', tag: { kind: 'process', processId: 'site:shop', workspaceId: 'ws' } });
        const open = sent.find((f) => f.kind === 'call' && f.method === 'pty.open') as Extract<SpawnFrame, { kind: 'call' }>;
        expect(open.args[0]).toBe(opened.id);
        expect(open.args[1]).toEqual({ cwd: '/w', command: 'php artisan serve' }); // the tag is not the engine's
        expect(open.args[2]).toEqual({ kind: 'process', processId: 'site:shop', workspaceId: 'ws' });
        expect(client.pid).toBeNull(); // no child of the window's own
    });

    it('a LOST LINK kills nothing and reports nothing exited; calls in flight fail with ESPAWNHOST', async () => {
        const { client, killed, answer } = linked();
        const up = client.linkUp();
        answer('pty.list', []);
        await up;
        const pty = client.ptyPort();
        const exits: string[] = [];
        pty.onExit((id) => exits.push(id));
        const opened = pty.open({ cwd: '/w', command: 'queue:work', tag: { kind: 'process', processId: 'p', workspaceId: 'ws' } });
        client.linkFrame({ kind: 'event', channel: 'pty.opened', payload: { id: opened.id, pid: 777 } });
        const inFlight = client.exec('docker', ['version']);
        client.linkDown('the agent host link was lost');
        await expect(inFlight).rejects.toMatchObject({ code: 'ESPAWNHOST' });
        await new Promise((r) => setTimeout(r, 30));
        expect(killed).toEqual([]);
        expect(exits).toEqual([]);
        expect(pty.isLive?.(opened.id)).toBe(true);
    });

    it('back up: a pty it knew that is gone is reported exited (-1); a live one it did not know is handed back to adopt', async () => {
        const { client, answer } = linked();
        let up = client.linkUp();
        answer('pty.list', []);
        await up;
        const pty = client.ptyPort();
        const exits: Array<[string, number]> = [];
        pty.onExit((id, code) => exits.push([id, code]));
        const mine = pty.open({ cwd: '/w', command: 'a' });
        client.linkDown('lost');
        up = client.linkUp();
        // The host restarted meanwhile: what this window had is gone; something it never saw is running.
        const stranger = listed({ id: 'term_other' });
        answer('pty.list', [stranger]);
        expect(await up).toEqual([stranger]);
        expect(exits).toEqual([[mine.id, -1]]);
        expect(pty.isLive?.(mine.id)).toBe(false);
    });

    it('an adopted pty is live to the port: its output, its exit and a write are routed', async () => {
        const { client, sent, answer } = linked();
        const up = client.linkUp();
        answer('pty.list', [listed()]);
        const [found] = await up;
        const pty = client.ptyPort();
        client.adoptPty(found!);
        expect(pty.isLive?.('term_x')).toBe(true);
        const data: string[] = [];
        const exits: number[] = [];
        pty.onData((id, d) => { if (id === 'term_x') data.push(d); });
        pty.onExit((id, c) => { if (id === 'term_x') exits.push(c); });
        client.linkFrame({ kind: 'event', channel: 'pty.data', payload: { id: 'term_x', data: 'GET /\r\n' } });
        expect(pty.write('term_x', 'q')).toBe(true);
        expect(sent.some((f) => f.kind === 'call' && f.method === 'pty.write' && f.args[0] === 'term_x')).toBe(true);
        client.linkFrame({ kind: 'event', channel: 'pty.exit', payload: { id: 'term_x', code: 0 } });
        expect(data).toEqual(['GET /\r\n']);
        expect(exits).toEqual([0]);
    });

    it('a pty opened while the link is DOWN does not start, and says why (a crash with words, never a silent hang)', async () => {
        const { client, answer } = linked();
        const up = client.linkUp();
        answer('pty.list', []);
        await up;
        client.linkDown('the host went');
        const pty = client.ptyPort();
        const data: string[] = [];
        const exits: number[] = [];
        pty.onData((_id, d) => data.push(d));
        pty.onExit((_id, c) => exits.push(c));
        pty.open({ cwd: '/w', command: 'php artisan serve' });
        await new Promise((r) => setTimeout(r, 0));
        expect(exits).toEqual([-1]);
        expect(data.join('')).toMatch(/agent host is not connected/);
    });

    describe('a link that has not come up YET is not a link that is down (genie#1453)', () => {
        const opens = (sent: readonly SpawnFrame[]) => sent.filter((f) => f.kind === 'call' && f.method === 'pty.open') as Extract<SpawnFrame, { kind: 'call' }>[];
        const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
        function watched(pty: ReturnType<SpawnHostClient['ptyPort']>) {
            const data: string[] = [];
            const exits: Array<[string, number]> = [];
            pty.onData((_id, d) => data.push(d));
            pty.onExit((id, c) => exits.push([id, c]));
            return { data, exits };
        }

        it('an open waits, and starts when the link comes up, with its id and its tag', async () => {
            const { client, sent, answer } = linked();
            const pty = client.ptyPort();
            const w = watched(pty);
            const opened = pty.open({ cwd: '/w', command: 'bash', tag: { kind: 'process', processId: 'p', workspaceId: 'ws' } });
            await tick();
            expect(w.exits, 'not refused').toEqual([]);
            expect(w.data).toEqual([]);
            expect(pty.isLive?.(opened.id)).toBe(true);
            expect(opens(sent)).toEqual([]);
            const up = client.linkUp();
            answer('pty.list', []);
            await up;
            expect(opens(sent).map((f) => f.args[0])).toEqual([opened.id]);
            expect(opens(sent)[0]!.args[2]).toEqual({ kind: 'process', processId: 'p', workspaceId: 'ws' });
            expect(w.exits, 'and the reconcile does not call it gone').toEqual([]);
        });

        it('what was typed while it waited follows the open, in order', async () => {
            const { client, sent, answer } = linked();
            const pty = client.ptyPort();
            const opened = pty.open({ cwd: '/w', command: 'bash' });
            expect(pty.write(opened.id, 'ls\r')).toBe(true);
            expect(pty.resize(opened.id, 80, 24)).toBe(true);
            const up = client.linkUp();
            answer('pty.list', []);
            await up;
            const after = sent.filter((f) => f.kind === 'call' && f.method.startsWith('pty.') && f.method !== 'pty.list') as Extract<SpawnFrame, { kind: 'call' }>[];
            expect(after.map((f) => f.method)).toEqual(['pty.open', 'pty.write', 'pty.resize']);
        });

        it('a link that stays away past the bound refuses, in the same words, once', async () => {
            const { client, sent } = linked({ linkWaitMs: 5 });
            const pty = client.ptyPort();
            const w = watched(pty);
            const opened = pty.open({ cwd: '/w', command: 'bash' });
            await tick(30);
            expect(w.exits).toEqual([[opened.id, -1]]);
            expect(w.data.join('')).toBe('[genie] the agent host is not connected, so this process was not started\r\n');
            expect(pty.isLive?.(opened.id)).toBe(false);
            expect(opens(sent)).toEqual([]);
        });

        it('past the bound it does not wait again: the next open is refused at once', async () => {
            const { client } = linked({ linkWaitMs: 5 });
            const pty = client.ptyPort();
            const w = watched(pty);
            pty.open({ cwd: '/w', command: 'bash' });
            await tick(30);
            w.exits.length = 0;
            pty.open({ cwd: '/w', command: 'bash' });
            await tick();
            expect(w.exits).toHaveLength(1);
        });

        it('a refused open that the link then reaches is not started as well', async () => {
            const { client, sent, answer } = linked({ linkWaitMs: 5 });
            const pty = client.ptyPort();
            pty.open({ cwd: '/w', command: 'bash' });
            await tick(30);
            const up = client.linkUp();
            answer('pty.list', []);
            await up;
            expect(opens(sent)).toEqual([]);
        });

        it('the link going down while it waits refuses at once', async () => {
            const { client } = linked();
            const pty = client.ptyPort();
            const w = watched(pty);
            const opened = pty.open({ cwd: '/w', command: 'bash' });
            client.linkDown('the host went');
            await tick();
            expect(w.exits).toEqual([[opened.id, -1]]);
        });

        it('a kill while it waits: never started, and it ends', async () => {
            const { client, sent, answer } = linked();
            const pty = client.ptyPort();
            const w = watched(pty);
            const opened = pty.open({ cwd: '/w', command: 'bash' });
            expect(pty.kill(opened.id)).toBe(true);
            await tick();
            expect(w.exits.map(([id]) => id)).toEqual([opened.id]);
            const up = client.linkUp();
            answer('pty.list', []);
            await up;
            expect(opens(sent)).toEqual([]);
        });

        it('an open during the reconcile is not reported gone by it: it was not in the list because it was not open yet', async () => {
            const { client, sent, answer } = linked();
            const pty = client.ptyPort();
            const w = watched(pty);
            const up = client.linkUp();
            const opened = pty.open({ cwd: '/w', command: 'bash' });
            answer('pty.list', []);
            await up;
            expect(w.exits).toEqual([]);
            expect(opens(sent).map((f) => f.args[0])).toEqual([opened.id]);
        });

        it('a reconcile that fails refuses what waited, in words', async () => {
            const { client, sent } = linked();
            const pty = client.ptyPort();
            const w = watched(pty);
            const opened = pty.open({ cwd: '/w', command: 'bash' });
            const up = client.linkUp();
            const list = sent.find((f) => f.kind === 'call' && f.method === 'pty.list') as Extract<SpawnFrame, { kind: 'call' }>;
            client.linkFrame({ kind: 'result', id: list.id, ok: false, reason: 'no', code: 'ESPAWNHOST' } as never);
            await up.catch(() => {});
            await tick();
            expect(w.exits).toEqual([[opened.id, -1]]);
        });
    });

    it('cwd reports travel too (an interactive terminal\'s OSC-7, for the cwd resume)', async () => {
        const { client, answer } = linked();
        const up = client.linkUp();
        answer('pty.list', []);
        await up;
        const pty = client.ptyPort();
        const cwds: string[] = [];
        pty.onCwd?.((_id, cwd) => cwds.push(cwd));
        const t = pty.open({ cwd: '/w' });
        client.linkFrame({ kind: 'event', channel: 'pty.cwd', payload: { id: t.id, cwd: '/w/app' } });
        expect(cwds).toEqual(['/w/app']);
    });
});

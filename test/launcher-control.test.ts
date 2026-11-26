import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import type { LineTransport } from '../src/core/line-transport.js';
import { callLauncher, launcherReachable, type LauncherWire } from '../src/main/launcher-control.js';

/*
 * THE LAUNCHER'S CONTROL WIRE, FROM TYPESCRIPT (Tynn #1058 L4). The client asks the launcher to start the host (the
 * directory's Start: `launcher.ensureHost`), and the host asks it to start the Genie browser (`launcher.startBrowser`).
 * The wire is native/launcher/src/control.rs: `<runtime>/launcher.json` names the endpoint, `<runtime>/launcher.token` is
 * the token, the hello carries an offer on track `launcher`, then one call and its result.
 */
const runtime = join('home', '.genie', 'runtime');

function fakeLauncher(answer: (frame: Record<string, unknown>) => Record<string, unknown> | null) {
    const sent: Record<string, unknown>[] = [];
    let listener: ((text: string) => void) | null = null;
    const closers: (() => void)[] = [];
    let closed = false;
    const transport: LineTransport = {
        send: (text) => {
            const frame = JSON.parse(text) as Record<string, unknown>;
            sent.push(frame);
            const reply = answer(frame);
            if (reply) queueMicrotask(() => listener?.(JSON.stringify(reply)));
        },
        onMessage: (l) => { listener = l; return () => { listener = null; }; },
        onClose: (l) => { closers.push(l); return () => {}; },
        close: () => { closed = true; for (const c of closers) c(); },
        trusted: () => {},
    };
    return { transport, sent, closed: () => closed };
}

const files = (over: Record<string, string | null> = {}) => (file: string): string | null => {
    const name = file.split(/[\\/]/).pop()!;
    const table: Record<string, string | null> = {
        'launcher.json': JSON.stringify({ pid: 4242, endpoint: '\\\\.\\pipe\\genie-launcher-S-1-5-21', build: '2026.11.26-1', schema: '2026.11.25' }),
        'launcher.token': 'tok\n',
        ...over,
    };
    return table[name] ?? null;
};

const welcome = { kind: 'welcome', track: 'launcher', build: '2026.11.26-1', schema: '2026.11.25', minSchema: '2026.10.26', capabilities: ['launcher@1'] };

describe('one call on the launcher\'s wire', () => {
    it('hello with the token and an offer on track launcher, then the call; the result is the answer, and the link is closed', async () => {
        const fake = fakeLauncher((f) => (f.kind === 'hello' ? welcome : f.kind === 'call' ? { kind: 'result', id: f.id, ok: true, value: { how: 'started', pid: 9, build: '2026.11.26-1' } } : null));
        const endpoints: string[] = [];
        const wire: LauncherWire = { runtimeDir: runtime, readFile: files(), alive: (pid) => pid === 4242, connectTo: async (e) => { endpoints.push(e); return fake.transport; } };
        await expect(callLauncher(wire, 'launcher.ensureHost')).resolves.toEqual({ ok: true, value: { how: 'started', pid: 9, build: '2026.11.26-1' } });
        expect(endpoints).toEqual(['\\\\.\\pipe\\genie-launcher-S-1-5-21']);
        expect(fake.sent[0]).toMatchObject({ kind: 'hello', auth: { kind: 'token', token: 'tok' }, track: 'launcher' });
        expect(typeof fake.sent[0]!.schema).toBe('string');
        expect(fake.sent[1]).toMatchObject({ kind: 'call', method: 'launcher.ensureHost', args: [] });
        expect(fake.closed()).toBe(true);
    });

    it('a refusal or a failed result is the launcher\'s own words', async () => {
        const refusing = fakeLauncher(() => ({ kind: 'refused', reason: 'this launcher answers only its own user\'s programs (wrong token)' }));
        await expect(callLauncher({ runtimeDir: runtime, readFile: files(), alive: () => true, connectTo: async () => refusing.transport }, 'launcher.startBrowser'))
            .resolves.toEqual({ ok: false, reason: 'this launcher answers only its own user\'s programs (wrong token)' });
        const failing = fakeLauncher((f) => (f.kind === 'hello' ? welcome : { kind: 'result', id: f.id, ok: false, reason: 'No browser is installed on this computer.' }));
        await expect(callLauncher({ runtimeDir: runtime, readFile: files(), alive: () => true, connectTo: async () => failing.transport }, 'launcher.startBrowser'))
            .resolves.toEqual({ ok: false, reason: 'No browser is installed on this computer.' });
    });

    it('no launcher (no launcher.json, a dead pid, no token): not reachable, and nothing is dialled', async () => {
        let dialled = 0;
        const connectTo = async (): Promise<LineTransport> => { dialled += 1; throw new Error('never'); };
        for (const wire of [
            { runtimeDir: runtime, readFile: files({ 'launcher.json': null }), alive: () => true, connectTo },
            { runtimeDir: runtime, readFile: files(), alive: () => false, connectTo },
            { runtimeDir: runtime, readFile: files({ 'launcher.token': null }), alive: () => true, connectTo },
        ] satisfies LauncherWire[]) {
            expect(launcherReachable(wire)).toBe(false);
            await expect(callLauncher(wire, 'launcher.status')).resolves.toMatchObject({ ok: false, code: 'no-launcher' });
        }
        expect(dialled).toBe(0);
    });

    it('a launcher that never answers is given up on in bounded time, in words', async () => {
        const silent = fakeLauncher(() => null);
        await expect(callLauncher({ runtimeDir: runtime, readFile: files(), alive: () => true, connectTo: async () => silent.transport, timeoutMs: 20 }, 'launcher.status'))
            .resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/did not answer/) });
        expect(silent.closed()).toBe(true);
    });
});

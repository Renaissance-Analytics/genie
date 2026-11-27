import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { HostDirectory, localHostState, readPairedHosts, type HostDirectoryState } from '../src/main/host-directory-window.js';
import type { HostDirectoryInput } from '../src/core/host-directory.js';

/*
 * THE HOST DIRECTORY'S WINDOW SIDE (Tynn #1058 L4). Start asks the launcher for the host; the window never starts one. Once
 * the launcher answers, the client links (untilLinked). A Start that fails says the launcher's words and stays.
 */
const stopped: HostDirectoryInput = { profile: 'both', local: { kind: 'stopped', build: '2026.11.26-1' }, paired: [], launcher: true };

function rig(answer: () => Promise<{ ok: true; value: unknown } | { ok: false; reason: string }>) {
    const pushed: HostDirectoryState[] = [];
    let asked = 0;
    const dir = new HostDirectory({ input: () => stopped, ensureHost: () => { asked += 1; return answer(); }, openLog: async () => null, push: (s) => pushed.push(s) });
    return { dir, pushed, asked: () => asked };
}

describe('Start', () => {
    it('asks the launcher once, is busy while it does, and links when it answers', async () => {
        let linked = false;
        const r = rig(async () => ({ ok: true, value: { how: 'started', pid: 9 } }));
        void r.dir.untilLinked().then(() => { linked = true; });
        await r.dir.act('start');
        expect(r.asked()).toBe(1);
        expect(r.pushed[0]?.busy).toBe('local');
        expect(r.pushed.at(-1)).toMatchObject({ busy: null, notice: { ok: true } });
        // The result on the row itself: running (green), with nothing left to press, while its window opens.
        expect(r.pushed.at(-1)?.view.hosts[0]).toMatchObject({ id: 'local', state: 'running', dot: 'green', action: null });
        await Promise.resolve();
        expect(linked).toBe(true);
    });

    it('a launcher that cannot start it: its words, the row failed with them, and no link', async () => {
        let linked = false;
        const r = rig(async () => ({ ok: false, reason: 'The new host exited before it answered.' }));
        void r.dir.untilLinked().then(() => { linked = true; });
        await r.dir.act('start');
        const last = r.pushed.at(-1)!;
        expect(last.notice).toEqual({ ok: false, text: 'The new host exited before it answered.' });
        expect(last.view.hosts[0]).toMatchObject({ state: 'failed', detail: 'The new host exited before it answered.', action: { kind: 'open-log' } });
        await Promise.resolve();
        expect(linked).toBe(false);
    });

    it('a second press while one runs asks nothing more', async () => {
        let release: () => void = () => {};
        const r = rig(() => new Promise((ok) => { release = () => ok({ ok: true, value: null }); }));
        const first = r.dir.act('start');
        await r.dir.act('start');
        release();
        await first;
        expect(r.asked()).toBe(1);
    });
});

describe('what the directory reads', () => {
    it('the paired addresses from device-hosts.json, and nothing from a missing or broken file', () => {
        const runtime = join('h', 'runtime');
        expect(readPairedHosts(runtime, (f) => (f === join(runtime, 'device-hosts.json') ? JSON.stringify({ hosts: ['wss://a:1', 7, 'ws://b:2'] }) : null))).toEqual(['wss://a:1', 'ws://b:2']);
        expect(readPairedHosts(runtime, () => null)).toEqual([]);
        expect(readPairedHosts(runtime, () => '{not json')).toEqual([]);
    });

    it('the local host: a launched client named a host build (stopped) or none (the client profile)', () => {
        const base = { legacyFailure: null, runtimeDir: 'rt', alive: () => true, read: () => null };
        expect(localHostState({ ...base, launchedHostBuild: '2026.11.26-1' })).toEqual({ profile: 'both', local: { kind: 'stopped', build: '2026.11.26-1' } });
        expect(localHostState({ ...base, launchedHostBuild: null })).toEqual({ profile: 'client', local: { kind: 'none' } });
    });

    it('a live host of another engine protocol is incompatible, never replaced; the single-app install\'s failed start says its reason', () => {
        const live = JSON.stringify({ pid: 5, endpoint: 'e', protocol: 999, build: 'x', startedAt: 1 });
        expect(localHostState({ launchedHostBuild: '2026.11.26-1', legacyFailure: null, runtimeDir: 'rt', alive: () => true, read: (f) => (f.endsWith('host.json') ? live : null) }).local).toMatchObject({ kind: 'incompatible', protocol: 999 });
        expect(localHostState({ launchedHostBuild: undefined, legacyFailure: 'the host process could not be started', runtimeDir: 'rt', alive: () => true, read: () => null })).toEqual({ profile: 'both', local: { kind: 'failed', reason: 'the host process could not be started' } });
    });
});

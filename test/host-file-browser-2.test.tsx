import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Baton, PairingPins, ShareLinks } from '../src/core/remote.js';
import { inMemoryPair, parseMessage, type ClientTransport, type PreAuth, type WireMessage } from '../src/core/remote-protocol.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import { fileEntriesOf } from '../src/renderer/components/HostPathPicker.js';

/**
 * EVERY FILE AND FOLDER INPUT READS THE HOST, PART 2 (Tynn #835). The clone's parent, the Tynn envelope's parent, Locate
 * repo, an alert's own sound and the inbox's attachments are picked IN THE WINDOW over the host's disk — the native
 * dialogs are gone — so a window driving another machine picks on THAT machine. Adding to the host stays the owner's.
 */

let dir: string;
let api: HostApi & { calls: string[] };
let accept: (c: ReturnType<typeof inMemoryPair>['server']) => void;

function wire(t: ClientTransport) {
    const inbox: WireMessage[] = [];
    const waiters: Array<(m: WireMessage) => void> = [];
    t.onMessage((text) => { const r = parseMessage(text); if (!r.ok) throw new Error(r.reason); const w = waiters.shift(); if (w) w(r.message); else inbox.push(r.message); });
    const next = () => (inbox.length > 0 ? Promise.resolve(inbox.shift()!) : new Promise<WireMessage>((r) => waiters.push(r)));
    let id = 0;
    return {
        hello: async () => { t.send(JSON.stringify({ kind: 'hello', auth: { kind: 'relay' } })); return next(); },
        call: async (method: string, ...args: unknown[]) => { t.send(JSON.stringify({ kind: 'call', id: ++id, method, args })); return next(); },
    };
}
const as = async (who: PreAuth) => { const pair = inMemoryPair(); accept({ ...pair.server, preAuth: who }); const c = wire(pair.client); await c.hello(); return c; };
const OWNER: PreAuth = { label: 'me', isOwner: true, workspaceId: null, readonly: false };

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-hfb2-'));
    const calls: string[] = [];
    api = {
        calls,
        invoke: async (method, args) => { calls.push(`${method} ${JSON.stringify(args)}`); return { ok: true }; },
        onEvent: () => () => {},
        workspaceOfAgent: () => null,
        workspacePaths: () => ({ tynn: '/w/tynn', fancy: '/w/fancy' }),
    };
    new RemoteHost({
        api, hostName: 'alphar', baton: new Baton(), pins: new PairingPins({ now: Date.now, random: Math.random }),
        shares: new ShareLinks({ host: 'alphar.invalid', now: Date.now, random: () => 's' }), devices: await DeviceStore.open(dir, { now: Date.now, random: () => 't' }),
        transport: { onConnection: (cb) => { accept = cb; return () => {}; } },
    });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('adding to the host, from any window — the owner’s', () => {
    it('the owner previews a clone and a Tynn envelope with the PARENT picked in the window, and lists Tynn projects', async () => {
        const o = await as(OWNER);
        expect(await o.call('workspaces.previewAddFromGit', 'https://example.com/a.git', '/w')).toMatchObject({ ok: true });
        expect(await o.call('workspaces.tynnProjects')).toMatchObject({ ok: true });
        expect(await o.call('workspaces.previewAddFromTynn', '42', '/w')).toMatchObject({ ok: true });
        expect(api.calls).toEqual(['workspaces.previewAddFromGit ["https://example.com/a.git","/w"]', 'workspaces.tynnProjects []', 'workspaces.previewAddFromTynn ["42","/w"]']);
    });

    it('a guest is refused each (CONTROL: the same calls passed for the owner)', async () => {
        const g = await as({ label: 'Pat', isOwner: false, workspaceId: null, readonly: false });
        for (const [method, ...args] of [['workspaces.previewAddFromGit', 'https://example.com/a.git', '/w'], ['workspaces.tynnProjects'], ['workspaces.previewAddFromTynn', '42', '/w']] as const) {
            expect(await g.call(method, ...args)).toMatchObject({ ok: false, reason: `${method} changes alphar itself; only its owner can` });
        }
    });
});

describe('Locate repo — a write in its own workspace', () => {
    it('a guest of tynn may not locate a repo in fancy', async () => {
        const g = await as({ label: 'Pat', isOwner: false, workspaceId: 'tynn', readonly: false });
        await g.call('baton.take');
        expect(await g.call('workspaces.locateRepo', 'fancy', 'app', '/w/fancy/app')).toMatchObject({ ok: false, reason: 'fancy is not the workspace this link shares' });
        expect(await g.call('workspaces.locateRepo', 'tynn', 'app', '/w/tynn/app')).toMatchObject({ ok: true });
    });
});

describe('the picker shows only what may be picked', () => {
    it('with extensions (an alert sound): other files are listed but disabled; folders stay open', () => {
        const entries = fileEntriesOf({ ok: true, path: '/s', entries: [{ path: '/s/more', name: 'more', kind: 'dir' }, { path: '/s/ding.WAV', name: 'ding.WAV', kind: 'file' }, { path: '/s/notes.txt', name: 'notes.txt', kind: 'file' }] }, ['wav', 'mp3']);
        expect(entries).toEqual([
            { path: '/s/more', name: 'more', kind: 'dir' },
            { path: '/s/ding.WAV', name: 'ding.WAV', kind: 'file', hasChildren: false },
            { path: '/s/notes.txt', name: 'notes.txt', kind: 'file', hasChildren: false, disabled: true },
        ]);
    });
});

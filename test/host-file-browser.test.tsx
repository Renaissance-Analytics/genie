import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Baton, PairingPins, ShareLinks } from '../src/core/remote.js';
import { inMemoryPair, parseMessage, type ClientTransport, type PreAuth, type WireMessage } from '../src/core/remote-protocol.js';
import { listHostDir } from '../src/main/host-fs.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import { fileEntriesOf, HostPathPickerForm } from '../src/renderer/components/HostPathPicker.js';

/**
 * EVERY FILE AND FOLDER INPUT READS THE HOST (Tynn #835; the owner, 2026-10-19: FileBrowser "is what we should be using
 * for all of our file inputs because it needs to read the host it's connecting to, not the machine the client is running
 * on"). Genie 1's #199: one host listing, one picker over react-fancy's FileBrowser, every native dialog replaced.
 *
 * The listing lives on the host and travels the remote protocol as a READ, so a window driving another machine browses
 * THAT machine's disk. The owner sees the whole disk (Genie 1's approved scope: a paired owner already has terminals); a
 * guest sees only inside the workspace(s) it was given.
 */

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-host-fs-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const fwd = (p: string) => p.replace(/\\/g, '/');

describe('listHostDir — one folder of the host, on demand', () => {
    it('lists a folder’s direct children: folders first, then files, by name; absolute, forward-slashed paths', async () => {
        await mkdir(join(dir, 'beta'));
        await mkdir(join(dir, 'Alpha'));
        await writeFile(join(dir, 'zeta.txt'), 'z');
        await writeFile(join(dir, 'a.md'), 'a');
        const r = await listHostDir(fwd(dir));
        expect(r).toEqual({
            ok: true,
            path: fwd(dir),
            entries: [
                { path: `${fwd(dir)}/Alpha`, name: 'Alpha', kind: 'dir' },
                { path: `${fwd(dir)}/beta`, name: 'beta', kind: 'dir' },
                { path: `${fwd(dir)}/a.md`, name: 'a.md', kind: 'file' },
                { path: `${fwd(dir)}/zeta.txt`, name: 'zeta.txt', kind: 'file' },
            ],
        });
    });

    it('a symlink is listed but never followed (a leaf)', async () => {
        await mkdir(join(dir, 'real'));
        try {
            await symlink(join(dir, 'real'), join(dir, 'link'), 'junction');
        } catch {
            return; // a platform that cannot make one here has nothing to prove
        }
        const r = await listHostDir(fwd(dir));
        expect(r.ok && r.entries.find((e) => e.name === 'link')).toMatchObject({ kind: 'file' });
    });

    it('the root: Windows lists its drives; elsewhere it is /', async () => {
        expect(await listHostDir('/', { platform: 'win32', drives: async () => ['C:/', 'D:/'] })).toEqual({
            ok: true,
            path: '/',
            entries: [{ path: 'C:/', name: 'C:', kind: 'dir' }, { path: 'D:/', name: 'D:', kind: 'dir' }],
        });
    });

    it('refuses a relative path and says why; a folder that is not there says so', async () => {
        expect(await listHostDir('repos/app')).toEqual({ ok: false, reason: 'repos/app is not an absolute path on this machine' });
        const gone = await listHostDir(`${fwd(dir)}/missing`);
        expect(gone.ok).toBe(false);
        expect(gone.ok ? '' : gone.reason).toContain('missing');
    });
});

// ---------------------------------------------------------------- over the remote protocol
const WS_PATH = '/w/tynn';
function fakeApi(): HostApi & { calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        invoke: async (method, args) => { calls.push(`${method} ${JSON.stringify(args)}`); return method === 'host.listDir' ? { ok: true, path: args[0], entries: [] } : { ok: true }; },
        onEvent: () => () => {},
        workspaceOfAgent: () => null,
        workspacePaths: () => ({ tynn: WS_PATH, fancy: '/w/fancy' }),
    };
}
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

describe('host.listDir over the remote protocol', () => {
    let api: ReturnType<typeof fakeApi>;
    let accept: (c: ReturnType<typeof inMemoryPair>['server']) => void;
    beforeEach(async () => {
        api = fakeApi();
        new RemoteHost({
            api, hostName: 'alphar', baton: new Baton(), pins: new PairingPins({ now: Date.now, random: Math.random }),
            shares: new ShareLinks({ host: 'alphar.invalid', now: Date.now, random: () => 's' }), devices: await DeviceStore.open(dir, { now: Date.now, random: () => 't' }),
            transport: { onConnection: (cb) => { accept = cb; return () => {}; } },
        });
    });
    const as = async (who: PreAuth) => { const pair = inMemoryPair(); accept({ ...pair.server, preAuth: who }); const c = wire(pair.client); await c.hello(); return c; };

    it('the owner browses the whole disk', async () => {
        const c = await as({ label: 'me', isOwner: true, workspaceId: null, readonly: false });
        expect(await c.call('host.listDir', '/')).toMatchObject({ ok: true });
        expect(await c.call('host.listDir', '/etc')).toMatchObject({ ok: true });
    });

    it('a guest of one workspace browses inside it — and nowhere else (CONTROL: inside passes)', async () => {
        const c = await as({ label: 'Pat', isOwner: false, workspaceId: 'tynn', readonly: true });
        expect(await c.call('host.listDir', '/w/tynn/repos')).toMatchObject({ ok: true });
        expect(await c.call('host.listDir', '/w/tynn')).toMatchObject({ ok: true });
        expect(await c.call('host.listDir', '/w/fancy')).toMatchObject({ ok: false, reason: '/w/fancy is outside what this link shares' });
        expect(await c.call('host.listDir', '/w/tynn-other')).toMatchObject({ ok: false });
        expect(await c.call('host.listDir', '/w/tynn/../fancy')).toMatchObject({ ok: false });
        expect(await c.call('host.listDir', '/')).toMatchObject({ ok: false });
        // On Linux case matters: /w/TYNN is NOT /w/tynn, and must not pass as it.
        expect(await c.call('host.listDir', '/w/TYNN')).toMatchObject({ ok: false });
    });

    it('a guest of the whole host browses inside its workspaces, not the disk', async () => {
        const c = await as({ label: 'Pat', isOwner: false, workspaceId: null, readonly: false });
        expect(await c.call('host.listDir', '/w/fancy/src')).toMatchObject({ ok: true });
        expect(await c.call('host.listDir', '/home')).toMatchObject({ ok: false });
    });

    it('adding a workspace is the owner’s: previewAdd takes the PICKED path; a guest is refused', async () => {
        const owner = await as({ label: 'me', isOwner: true, workspaceId: null, readonly: false });
        expect(await owner.call('workspaces.previewAdd', '/w/new')).toMatchObject({ ok: true });
        expect(api.calls).toContain('workspaces.previewAdd ["/w/new"]');
        const guest = await as({ label: 'Pat', isOwner: false, workspaceId: null, readonly: false });
        expect(await guest.call('workspaces.previewAdd', '/w/new')).toMatchObject({ ok: false, reason: 'workspaces.previewAdd changes alphar itself; only its owner can' });
    });
});

// ---------------------------------------------------------------- the picker
describe('the picker — react-fancy FileBrowser over the host listing', () => {
    it('maps the host listing to FileBrowser entries (folders expandable, files leaves)', () => {
        expect(fileEntriesOf({ ok: true, path: '/w', entries: [{ path: '/w/a', name: 'a', kind: 'dir' }, { path: '/w/b.md', name: 'b.md', kind: 'file' }] })).toEqual([
            { path: '/w/a', name: 'a', kind: 'dir' },
            { path: '/w/b.md', name: 'b.md', kind: 'file', hasChildren: false },
        ]);
    });

    it('a refused listing is an error FileBrowser shows on that folder, in the host’s words', () => {
        expect(() => fileEntriesOf({ ok: false, reason: '/w/fancy is outside what this link shares' })).toThrow('/w/fancy is outside what this link shares');
    });

    it('Choose is offered once something is picked, naming it (CONTROL: nothing picked, nothing to choose)', () => {
        const base = { mode: 'directory' as const, listDir: async () => ({ ok: true as const, path: '/', entries: [] }), onPick: () => {}, onCancel: () => {} };
        const none = renderToStaticMarkup(<HostPathPickerForm {...base} />);
        expect(none).toMatch(/data-action="pick-path" disabled=""/);
        const some = renderToStaticMarkup(<HostPathPickerForm {...base} initialSelection="/w/new" />);
        expect(some).not.toMatch(/data-action="pick-path" disabled=""/);
        expect(some).toContain('data-action="pick-path"');
        expect(some).toContain('/w/new');
    });
});

import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { folderNameProblem, hostFolder, parentOf, rootLabel, rootsOf } from '../src/core/host-path.js';
import { Baton, PairingPins, ShareLinks } from '../src/core/remote.js';
import { capabilityOf, inMemoryPair, parseMessage, type ClientTransport, type PreAuth, type WireMessage } from '../src/core/remote-protocol.js';
import { listHostDir, makeHostDir } from '../src/main/host-fs.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import { HostPathPickerForm, newFolderHandler, PickerNav } from '../src/renderer/components/HostPathPicker.js';

/**
 * THE FOLDER PICKER GOES ANYWHERE AND MAKES A FOLDER (the owner, 2026-10-22: "I am unable to create a folder or navigate
 * to other folders outside of the user root unless I manually put the path in the folder picker").
 *
 * It opens where pickerStart says, and from there: Up to the parent, the machine's roots (its drives on Windows, `/`
 * elsewhere), a typed path; and in a folder picker, New folder — made on the HOST (the machine this window drives,
 * through the remote protocol when that is another one), then shown and selected.
 */

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-folder-picker-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const fwd = (p: string) => p.replace(/\\/g, '/');

describe('where Up goes, and what the roots are', () => {
    it('Up is the parent; a drive’s parent is the drive list; the root has none', () => {
        expect(parentOf('C:/Users/me')).toBe('C:/Users');
        expect(parentOf('C:/Users')).toBe('C:/');
        expect(parentOf('C:/')).toBe('/');
        expect(parentOf('C:')).toBe('/');
        expect(parentOf('C:\\Users\\me\\')).toBe('C:/Users');
        expect(parentOf('/home/me')).toBe('/home');
        expect(parentOf('/home')).toBe('/');
        expect(parentOf('/')).toBeNull();
    });

    it('a folder as the host reads it: forward slashes, a bare drive is its root, no trailing slash but on a root', () => {
        expect(hostFolder('C:')).toBe('C:/');
        expect(hostFolder('d:\\')).toBe('d:/');
        expect(hostFolder('C:\\Users\\me\\')).toBe('C:/Users/me');
        expect(hostFolder('/home/me/')).toBe('/home/me');
        expect(hostFolder('')).toBe('/');
        expect(hostFolder('/')).toBe('/');
    });

    it('the roots: the drives the host lists at `/` on Windows; `/` itself elsewhere (CONTROL: a POSIX `/` is not drives)', () => {
        expect(rootsOf({ ok: true, path: '/', entries: [{ path: 'C:/' }, { path: 'D:/' }] })).toEqual(['C:/', 'D:/']);
        expect(rootsOf({ ok: true, path: '/', entries: [{ path: '/bin' }, { path: '/home' }] })).toEqual(['/']);
        expect(rootsOf({ ok: false, reason: 'nope' })).toEqual(['/']);
        expect(rootLabel('C:/')).toBe('C:');
        expect(rootLabel('/')).toBe('/');
    });

    it('a new folder’s name, in the picker’s own words (CONTROL: an ordinary name passes)', () => {
        expect(folderNameProblem('site')).toBeNull();
        expect(folderNameProblem('my site.v2')).toBeNull();
        expect(folderNameProblem('   ')).toBe('Enter a name.');
        expect(folderNameProblem('a/b')).toBe('A name cannot contain / or \\.');
        expect(folderNameProblem('a\\b')).toBe('A name cannot contain / or \\.');
        expect(folderNameProblem('..')).toBe('That name is reserved.');
        expect(folderNameProblem('.')).toBe('That name is reserved.');
    });
});

describe('the host reads a bare drive as its root', () => {
    it('`C:` lists the drive’s root — not the folder Windows last used on C', async () => {
        // A Windows-only fact of node: readdir('C:') reads the process's cwd on C. Elsewhere there is nothing to prove.
        if (process.platform !== 'win32') return;
        const bare = await listHostDir('C:');
        const root = await listHostDir('C:/');
        expect(bare).toEqual(root);
    });
});

describe('makeHostDir — New folder, made on the host', () => {
    it('makes the folder inside the parent and answers its path (CONTROL: it was not there before)', async () => {
        const parent = fwd(dir);
        expect(await readdir(dir)).toEqual([]);
        expect(await makeHostDir(parent, 'site')).toEqual({ ok: true, path: `${parent}/site` });
        expect((await stat(join(dir, 'site'))).isDirectory()).toBe(true);
    });

    it('refuses a name that would leave the parent, or is empty, or reserved — and makes nothing', async () => {
        const parent = fwd(dir);
        expect(await makeHostDir(parent, '../escape')).toEqual({ ok: false, reason: 'A name cannot contain / or \\.' });
        expect(await makeHostDir(parent, '..')).toEqual({ ok: false, reason: 'That name is reserved.' });
        expect(await makeHostDir(parent, '')).toEqual({ ok: false, reason: 'Enter a name.' });
        expect(await readdir(dir)).toEqual([]);
    });

    it('an existing name is said so, and the folder there is left alone', async () => {
        await mkdir(join(dir, 'site'));
        expect(await makeHostDir(fwd(dir), 'site')).toEqual({ ok: false, reason: '“site” already exists here.' });
    });

    it('refuses a relative parent, and the drive list (pick a drive first)', async () => {
        expect(await makeHostDir('repos', 'site')).toEqual({ ok: false, reason: 'repos is not an absolute path on this machine' });
        expect(await makeHostDir('/', 'site', { platform: 'win32' })).toEqual({ ok: false, reason: 'Open a drive to make a folder in it.' });
    });
});

// ---------------------------------------------------------------- over the remote protocol
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

describe('host.mkdir over the remote protocol — the owner’s, like adding a workspace', () => {
    let calls: string[];
    let accept: (c: ReturnType<typeof inMemoryPair>['server']) => void;
    beforeEach(async () => {
        calls = [];
        const api: HostApi = {
            invoke: async (method, args) => { calls.push(`${method} ${JSON.stringify(args)}`); return { ok: true, path: `${String(args[0])}/${String(args[1])}` }; },
            onEvent: () => () => {},
            workspaceOfAgent: () => null,
            workspacePaths: () => ({ tynn: '/w/tynn' }),
        };
        new RemoteHost({
            api, hostName: 'alphar', baton: new Baton(), pins: new PairingPins({ now: Date.now, random: Math.random }),
            shares: new ShareLinks({ host: 'alphar.invalid', now: Date.now, random: () => 's' }), devices: await DeviceStore.open(dir, { now: Date.now, random: () => 't' }),
            transport: { onConnection: (cb) => { accept = cb; return () => {}; } },
        });
    });
    const as = async (who: PreAuth) => { const pair = inMemoryPair(); accept({ ...pair.server, preAuth: who }); const c = wire(pair.client); await c.hello(); return c; };

    it('is a write', () => {
        expect(capabilityOf('host.mkdir')).toBe('write');
    });

    it('the owner, driving, makes a folder on the host (CONTROL for the guest below)', async () => {
        const o = await as({ label: 'me', isOwner: true, workspaceId: null, readonly: false });
        await o.call('baton.take');
        expect(await o.call('host.mkdir', '/w', 'site')).toMatchObject({ ok: true, value: { ok: true, path: '/w/site' } });
        expect(calls).toEqual(['host.mkdir ["/w","site"]']);
    });

    it('a guest is refused — even inside its own workspace — and the host is never asked', async () => {
        const g = await as({ label: 'Pat', isOwner: false, workspaceId: 'tynn', readonly: false });
        await g.call('baton.take');
        expect(await g.call('host.mkdir', '/w/tynn', 'site')).toMatchObject({ ok: false, reason: 'host.mkdir changes alphar itself; only its owner can' });
        expect(calls).toEqual([]);
    });
});

// ---------------------------------------------------------------- the picker
const listDir = async () => ({ ok: true as const, path: '/', entries: [] });
const base = { listDir, onPick: () => {}, onCancel: () => {} };

describe('the picker — Up, the roots, a typed path, New folder', () => {
    it('shows the folder it is in, with Up to its parent', () => {
        const html = renderToStaticMarkup(<HostPathPickerForm {...base} mode="directory" initialPath="C:/Users/me" />);
        expect(html).toContain('data-action="picker-up"');
        expect(html).toMatch(/data-action="picker-up"[^>]*title="Up to C:\/Users"/);
        expect(html).toContain('data-picker-path="C:/Users/me"');
    });

    it('Up is disabled at the root — there is nothing above it (CONTROL: enabled anywhere else, above)', () => {
        const html = renderToStaticMarkup(<HostPathPickerForm {...base} mode="directory" initialPath="/" />);
        expect(html).toMatch(/data-action="picker-up"[^>]*disabled=""/);
        const below = renderToStaticMarkup(<HostPathPickerForm {...base} mode="directory" initialPath="/home" />);
        expect(below).not.toMatch(/data-action="picker-up"[^>]*disabled=""/);
    });

    it('the roots are one click each: the drives on Windows, `/` elsewhere', () => {
        const drives = renderToStaticMarkup(<PickerNav path="C:/Users" roots={['C:/', 'D:/']} onNavigate={() => {}} />);
        expect(drives).toContain('data-picker-root="C:/"');
        expect(drives).toContain('data-picker-root="D:/"');
        expect(drives).toContain('>D:<');
        const posix = renderToStaticMarkup(<PickerNav path="/home" roots={['/']} onNavigate={() => {}} />);
        expect(posix).toContain('data-picker-root="/"');
        expect(posix).not.toContain('data-picker-root="C:/"');
    });

    it('a typed path is still accepted (the path bar’s edit)', () => {
        const html = renderToStaticMarkup(<HostPathPickerForm {...base} mode="directory" initialPath="/home" />);
        expect(html).toContain('aria-label="Edit path"');
    });

    it('New folder is offered in a folder picker that can make one (CONTROL: not when picking files, not without the host call)', () => {
        const mkdirOk = async (parent: string, name: string) => ({ ok: true as const, path: `${parent}/${name}` });
        expect(renderToStaticMarkup(<HostPathPickerForm {...base} mode="directory" initialPath="/home" mkdir={mkdirOk} />)).toContain('New folder');
        expect(renderToStaticMarkup(<HostPathPickerForm {...base} mode="file" initialPath="/home" mkdir={mkdirOk} />)).not.toContain('New folder');
        expect(renderToStaticMarkup(<HostPathPickerForm {...base} mode="directory" initialPath="/home" />)).not.toContain('New folder');
    });

    it('creating one asks the HOST to make it in the current folder, then selects it', async () => {
        const asked: string[] = [];
        const selected: string[] = [];
        const create = newFolderHandler(async (parent, name) => { asked.push(`${parent}|${name}`); return { ok: true, path: `${parent}/${name}` }; }, (p) => selected.push(p));
        await create({ parentPath: 'C:/_Projects', name: 'site' });
        expect(asked).toEqual(['C:/_Projects|site']);
        expect(selected).toEqual(['C:/_Projects/site']);
    });

    it('a refusal is the form’s error in the host’s words, and nothing is selected', async () => {
        const selected: string[] = [];
        const create = newFolderHandler(async () => ({ ok: false, reason: '“site” already exists here.' }), (p) => selected.push(p));
        await expect(create({ parentPath: '/w', name: 'site' })).rejects.toThrow('“site” already exists here.');
        expect(selected).toEqual([]);
    });
});

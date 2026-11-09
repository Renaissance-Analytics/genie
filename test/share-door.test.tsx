import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Baton, PairingPins } from '../src/core/remote.js';
import { capabilityOf, inMemoryPair, parseMessage, type ServerConnection, type WireMessage } from '../src/core/remote-protocol.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import { ShareWorkspaceForm } from '../src/renderer/components/ShareWorkspaceModal.js';
import { TitleBar } from '../src/renderer/components/TitleBar.js';
import { WorkspaceTabs } from '../src/renderer/components/WorkspaceTabs.js';
import { connectRemote } from '../src/renderer/remote-bridge.js';
import { shareDoor } from '../src/renderer/share-door.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

/*
 * A VISIBLE WAY TO SHARE (Tynn #587; the owner, 2026-11-09: "I have no UX at all for creating a link for a user"). Whatever is
 * selected, on this machine or driving another: the host being shared makes the link, for itself, and it takes the baton and
 * the owner's rights. A guest is never offered it, and the host refuses one that asks anyway.
 */
const SHARES = ['tynnNetwork.shares.list', 'tynnNetwork.shares.mint', 'tynnNetwork.shares.revoke'] as const;
const MINT = [{ workspaceId: null, capability: 'readonly', expiresInDays: 3 }];

let dir: string;
let devices: DeviceStore;
let invoke: ReturnType<typeof vi.fn>;
let accept: (c: ServerConnection) => void;
let host: RemoteHost;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-share-door-'));
    let n = 0;
    devices = await DeviceStore.open(dir, { now: Date.now, random: () => `share-${++n}` });
    invoke = vi.fn(async () => ({ ok: true, links: [] }));
    const api: HostApi = { invoke: invoke as unknown as HostApi['invoke'], onEvent: () => () => {}, workspaceOfAgent: () => 'ws' };
    host = new RemoteHost({ api, hostName: 'share-host', baton: new Baton(), devices, pins: new PairingPins({ now: Date.now, random: () => 0.482913 }), confirm: allowEveryPairing,
        transport: { onConnection: (l) => { accept = l; return () => {}; } } });
});
afterEach(async () => { await devices.flushed(); await rm(dir, { recursive: true, force: true }); });

async function wire(pre: ServerConnection['preAuth'] | undefined, hello: object) {
    const pair = inMemoryPair();
    const inbox: WireMessage[] = [];
    pair.client.onMessage((t) => { const r = parseMessage(t); if (r.ok) inbox.push(r.message); });
    accept(pre ? { ...pair.server, preAuth: pre } : pair.server);
    pair.client.send(JSON.stringify({ kind: 'hello', ...hello }));
    await vi.waitFor(() => expect(inbox.some((m) => m.kind === 'welcome')).toBe(true));
    let id = 0;
    return async (method: string, args: unknown[] = []) => {
        const n = ++id;
        pair.client.send(JSON.stringify({ kind: 'call', id: n, method, args }));
        await vi.waitFor(() => expect(inbox.some((m) => m.kind === 'result' && m.id === n)).toBe(true));
        return inbox.find((m) => m.kind === 'result' && m.id === n) as { ok: boolean; reason?: string };
    };
}
const device = () => { host.issuePin(); return wire(undefined, { auth: { kind: 'pin', code: '482913', label: 'pilot' } }); };

describe('the host being shared decides', () => {
    it('reading its links is a read; making or revoking one is a change', () => {
        expect(capabilityOf('tynnNetwork.shares.list')).toBe('read');
        expect(capabilityOf('tynnNetwork.shares.mint')).toBe('write');
        expect(capabilityOf('tynnNetwork.shares.revoke')).toBe('write');
    });

    it('its owner, driving, makes a link on the host; the host is what is asked', async () => {
        const call = await device();
        expect(await call('baton.take', [{}])).toMatchObject({ ok: true });
        expect(await call('tynnNetwork.shares.mint', MINT)).toMatchObject({ ok: true });
        expect(invoke).toHaveBeenCalledExactlyOnceWith('tynnNetwork.shares.mint', MINT, expect.anything());
    });

    it('without the baton it is told to take it, and nothing is made', async () => {
        const call = await device();
        expect(await call('tynnNetwork.shares.mint', MINT)).toMatchObject({ ok: false, reason: expect.stringContaining('baton') });
        expect(invoke).not.toHaveBeenCalled();
    });

    it('its links are listed for the owner without taking the baton', async () => {
        const call = await device();
        expect(await call('tynnNetwork.shares.list', [null])).toMatchObject({ ok: true });
        expect(invoke).toHaveBeenCalledOnce();
    });

    it.each([
        ['a guest of the whole host', { label: 'g', isOwner: false, workspaceId: null, readonly: false }],
        ['a guest of one workspace', { label: 'g', isOwner: false, workspaceId: 'ws', readonly: false }],
        ['a read-only guest', { label: 'g', isOwner: false, workspaceId: 'ws', readonly: true }],
    ] as const)('%s is refused every one, and the host is never asked', async (_name, pre) => {
        const call = await wire(pre, { auth: { kind: 'relay' } });
        await call('baton.take', [{}]);
        for (const method of SHARES) expect(await call(method, [null]), method).toMatchObject({ ok: false });
        expect(invoke).not.toHaveBeenCalled();
    });

    it('CONTROL: a read-only link of the owner\'s can look, and cannot make one', async () => {
        const call = await wire({ label: 'o', isOwner: true, workspaceId: null, readonly: true }, { auth: { kind: 'relay' } });
        expect(await call('tynnNetwork.shares.list', [null])).toMatchObject({ ok: true });
        expect(await call('tynnNetwork.shares.mint', MINT)).toMatchObject({ ok: false, reason: expect.stringContaining('read-only') });
    });

    it('a remote window\'s client asks that host, and a refusal is an answer rather than a throw', async () => {
        const pair = inMemoryPair();
        accept({ ...pair.server, remoteAddress: 'relay:x', preAuth: { label: 'o', isOwner: true, workspaceId: null, readonly: false } });
        const client = connectRemote(pair.client, { kind: 'relay' }, 'o');
        expect(await client.ready).toEqual({ ok: true });
        const shares = (client as unknown as { shares: { list(id: string | null): Promise<unknown>; mint(i: object): Promise<unknown>; revoke(id: string): Promise<unknown> } }).shares;
        expect(await shares.list(null)).toEqual({ ok: true, links: [] });
        expect(invoke).toHaveBeenCalledExactlyOnceWith('tynnNetwork.shares.list', [null], expect.anything());
        expect(await shares.mint({ workspaceId: null, capability: 'control', expiresInDays: 7 })).toMatchObject({ ok: false, reason: expect.stringContaining('baton') });
        client.close();
    });
});

describe('which door a window has', () => {
    const own = { list: vi.fn() }, remote = { list: vi.fn() };
    it('this machine\'s own, when nothing is connected', () => {
        expect(shareDoor({ connected: false, isOwner: false, own: own as never, remote: remote as never })).toBe(own);
    });
    it('the host\'s, when its owner is connected', () => {
        expect(shareDoor({ connected: true, isOwner: true, own: own as never, remote: remote as never })).toBe(remote);
    });
    it('none for a guest: never offered, and never this machine\'s instead', () => {
        expect(shareDoor({ connected: true, isOwner: false, own: own as never, remote: remote as never })).toBeUndefined();
    });
});

describe('where it is', () => {
    const strip = (over: object) => renderToStaticMarkup(
        <WorkspaceTabs designed={{ tabs: [] } as never} agents={[]} current={{ kind: 'view', view: 'home' }} canDesign={false} hasSettings={false} onView={() => {}} onAdd={() => {}} onOpenAgent={() => {}} {...over} />,
    );
    it('in the workspace\'s strip, whatever is selected', () => {
        expect(strip({ onShare: () => {} })).toContain('data-action="share-workspace"');
        expect(strip({ onShare: () => {}, current: { kind: 'agent', id: 'a' } })).toContain('data-action="share-workspace"');
    });
    it('CONTROL: a guest\'s strip has none', () => { expect(strip({})).not.toContain('data-action="share-workspace"'); });

    const bar = (over: object) => renderToStaticMarkup(<TitleBar route="genie://dashboard" workstation={{ name: 'alphar', healthy: true }} onNavigate={() => {}} onOpenPalette={() => {}} {...over} />);
    it('Share this workstation in the title bar, said in words', () => {
        const html = bar({ share: { onShare: () => {} } });
        expect(html).toContain('data-action="share-workstation"');
        expect(html).toMatch(/Share this workstation/);
    });
    it('CONTROL: a guest\'s title bar has none', () => { expect(bar({})).not.toContain('data-action="share-workstation"'); });

    const form = (over: object) => renderToStaticMarkup(<ShareWorkspaceForm workspaceName="alphar" links={[]} minted={null} problem={null} busy={false} onMint={() => {}} onRevoke={async () => ({ ok: true })} onClose={() => {}} {...over} />);
    it('opened on the workstation, there is no workspace to choose', () => {
        expect(form({ workstation: true })).not.toContain('data-share-reach');
    });
    it('CONTROL: opened on a workspace, the choice is there', () => { expect(form({})).toContain('data-share-reach'); });
    it('what cannot work is said, with the fix, on the same form', () => {
        expect(form({ problem: 'Tynn did not let this Genie list share links: sign in to Tynn' })).toMatch(/sign in to Tynn/);
    });

    const read = (p: string) => readFileSync(new URL(`../src/renderer/${p}`, import.meta.url), 'utf8');
    it('the app gives both the door the host decided', () => {
        const app = read('App.tsx');
        expect(app).toMatch(/const shares = shareDoor\(/);
        expect(read('Shell.tsx')).toMatch(/share=\{onShareWorkstation \? \{ onShare: onShareWorkstation \} : undefined\}/);
        expect(read('Shell.tsx')).toMatch(/onShare=\{workspaceOps\?\.onShare\}/);
    });
});

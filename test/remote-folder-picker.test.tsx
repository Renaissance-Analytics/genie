// @vitest-environment happy-dom
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pickerStart } from '../src/core/add-workspace.js';
import { Baton, PairingPins } from '../src/core/remote.js';
import { capabilityOf, inMemoryPair, type ServerConnection } from '../src/core/remote-protocol.js';
import { buildHostApi } from '../src/main/host-api.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import type { GenieBridge } from '../src/renderer/bridge.js';
import { HostPathPickerForm } from '../src/renderer/components/HostPathPicker.js';
import { EMPTY_FEATURES, forgetHost } from '../src/renderer/features.js';
import { useHostHome } from '../src/renderer/host-home.js';
import { connectRemote } from '../src/renderer/remote-bridge.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';
import { protocolContractDeps } from './support/protocol-contract-deps.js';

/**
 * A REMOTE WINDOW PICKS FROM THE REMOTE'S DISK (Tynn #527; the owner, over a remote connection: "Where should the Tynn
 * envelope be created?" opened at THIS machine's `C:/Users/glenn`, and the remote answered "C:/Users/glenn is not an
 * absolute path on this machine").
 *
 * The listing already went through the remote (`host.listDir`). The START did not: the window asked its first bridge —
 * this machine's — for the home folder, kept the answer, and a remote bridge had no `home` to replace it with. So the
 * picker opened at the client's home on a machine where that path does not exist. Now:
 *  - the home is the home of the bridge the window drives NOW; a previous bridge's answer is never kept, even one that
 *    lands late;
 *  - the remote answers its own home (`host.home`, a read); a guest is answered the folder it was given;
 *  - the previous host's settings (the Primary workspace — a path on that host) are not kept for the next one.
 */

// ------------------------------------------------------------------ the window's home, per bridge
let container: HTMLElement;
let root: Root;
beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

function Probe({ bridge }: { readonly bridge: GenieBridge | undefined }) {
    const home = useHostHome(bridge);
    return <span data-home={home ?? ''} />;
}
const shown = () => container.querySelector('[data-home]')!.getAttribute('data-home');
const listDir = async (path: string) => ({ ok: true as const, path, entries: [] });
const bridgeWith = (home?: () => Promise<string>) => ({ host: { listDir, ...(home ? { home } : {}) } }) as unknown as GenieBridge;
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

describe('the home a picker starts at is the home of the bridge this window drives now', () => {
    it('CONTROL: the local window gets this machine’s home', async () => {
        await act(async () => root.render(<Probe bridge={bridgeWith(async () => 'C:\\Users\\glenn')} />));
        await flush();
        expect(shown()).toBe('C:\\Users\\glenn');
    });

    it('switching to a remote that cannot say its home does NOT keep the client’s (the owner’s C:/Users/glenn)', async () => {
        await act(async () => root.render(<Probe bridge={bridgeWith(async () => 'C:\\Users\\glenn')} />));
        await flush();
        expect(shown()).toBe('C:\\Users\\glenn');
        await act(async () => root.render(<Probe bridge={bridgeWith()} />));
        await flush();
        expect(shown()).toBe('');
    });

    it('switching to a remote that answers: the remote’s home', async () => {
        await act(async () => root.render(<Probe bridge={bridgeWith(async () => 'C:\\Users\\glenn')} />));
        await flush();
        await act(async () => root.render(<Probe bridge={bridgeWith(async () => '/home/wish')} />));
        await flush();
        expect(shown()).toBe('/home/wish');
    });

    it('the client’s answer landing AFTER the switch is dropped (the remote’s stays)', async () => {
        let answerLocal: (home: string) => void = () => {};
        const local = bridgeWith(() => new Promise<string>((resolve) => { answerLocal = resolve; }));
        await act(async () => root.render(<Probe bridge={local} />));
        await act(async () => root.render(<Probe bridge={bridgeWith(async () => '/home/wish')} />));
        await flush();
        expect(shown()).toBe('/home/wish');
        await act(async () => { answerLocal('C:\\Users\\glenn'); await Promise.resolve(); });
        await flush();
        expect(shown()).toBe('/home/wish');
    });
});

describe('the previous host’s settings are not the next host’s', () => {
    const fromClient = { ...EMPTY_FEATURES, settings: { values: { primary_workspace: 'C:\\_Projects' } } };
    it('the Primary workspace (a path on the PREVIOUS host) is forgotten on a switch — numbered snapshot or not', () => {
        expect(forgetHost({ ...fromClient, seq: 7 }).settings.values).toBeNull();
        expect(forgetHost({ ...fromClient, seq: 7 }).seq).toBeUndefined();
        expect(forgetHost(fromClient).settings.values).toBeNull();
    });
    it('CONTROL: nothing else is dropped', () => {
        const kept = forgetHost({ ...fromClient, seq: 7 });
        expect(kept.knowledge).toBe(fromClient.knowledge);
        expect(kept.browser).toBe(fromClient.browser);
    });
});

// ------------------------------------------------------------------ over the remote protocol
const WS = '/w/tynn';
describe('host.home over the remote protocol', () => {
    let dir: string;
    let devices: DeviceStore;
    let calls: Array<{ method: string; args: unknown[] }>;
    let accept: (c: ServerConnection) => void = () => {};
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie2-remote-picker-'));
        calls = [];
        const api: HostApi = {
            invoke: async (method, args) => {
                calls.push({ method, args });
                if ((method as string) === 'host.home') return '/home/wish';
                if (method === 'host.listDir') return { ok: true, path: args[0], entries: [{ path: `${String(args[0])}/repos`, name: 'repos', kind: 'dir' }] };
                if (method === 'host.mkdir') return { ok: true, path: `${String(args[0])}/${String(args[1])}` };
                return { ok: true };
            },
            onEvent: () => () => {},
            workspaceOfAgent: () => null,
            workspacePaths: () => ({ tynn: WS }),
        };
        devices = await DeviceStore.open(dir, { now: () => 1, random: () => 'tok' });
        new RemoteHost({ confirm: allowEveryPairing,
            api, hostName: 'alphar', baton: new Baton(), pins: new PairingPins({ now: () => 1, random: () => 0.482913 }), devices,
            transport: { onConnection: (cb) => { accept = cb; return () => {}; } },
        });
    });
    afterEach(async () => { await devices.flushed(); await rm(dir, { recursive: true, force: true }); });
    const dial = async (preAuth?: { label: string; isOwner: boolean; workspaceId: string | null; readonly: boolean }) => {
        const pair = inMemoryPair();
        accept(preAuth ? { ...pair.server, preAuth } : pair.server);
        const remote = connectRemote(pair.client, { kind: 'relay' } as never, 'laptop');
        expect(await remote.ready).toEqual({ ok: true });
        return remote;
    };
    const owner = { label: 'me', isOwner: true, workspaceId: null, readonly: false };

    it('is a read', () => {
        expect(capabilityOf('host.home' as never)).toBe('read');
    });

    it('the remote bridge asks the REMOTE for its home', async () => {
        const { bridge } = await dial(owner);
        expect(typeof bridge.host?.home).toBe('function');
        expect(await bridge.host!.home!()).toBe('/home/wish');
        expect(calls.filter((c) => c.method === 'host.home')).toHaveLength(1);
    });

    it('a guest of one workspace is answered that workspace’s folder — the host’s home is not asked', async () => {
        const { bridge } = await dial({ label: 'Pat', isOwner: false, workspaceId: 'tynn', readonly: false });
        expect(await bridge.host!.home!()).toBe(WS);
        expect(calls.filter((c) => c.method === 'host.home')).toEqual([]);
    });

    it('the host answers its own home folder', async () => {
        const api = buildHostApi(protocolContractDeps(dir));
        expect(await api.invoke('host.home' as never, [])).toBe(homedir());
    });

    it('the picker opened over the remote starts at the remote’s home and lists, goes Up and makes folders THERE', async () => {
        const remote = await dial(owner);
        await remote.takeBaton();
        const { bridge } = remote;
        const start = pickerStart({ primaryWorkspace: '', home: await bridge.host!.home!() });
        expect(start).toBe('/home/wish');
        await act(async () => root.render(
            <HostPathPickerForm mode="directory" initialPath={start} listDir={(p) => bridge.host!.listDir(p)} mkdir={(parent, name) => bridge.host!.mkdir!(parent, name)} onPick={() => {}} onCancel={() => {}} />,
        ));
        await flush();
        const listed = () => calls.filter((c) => c.method === 'host.listDir').map((c) => c.args[0]);
        expect(listed()).toContain('/home/wish');
        expect(listed().some((p) => /^[A-Za-z]:/.test(String(p)))).toBe(false);
        expect(container.querySelector('[data-picker-path]')!.getAttribute('data-picker-path')).toBe('/home/wish');
        await act(async () => { (container.querySelector('[data-action="picker-up"]') as HTMLButtonElement).click(); });
        await flush();
        expect(container.querySelector('[data-picker-path]')!.getAttribute('data-picker-path')).toBe('/home');
        expect(listed()).toContain('/home');
        expect(await bridge.host!.mkdir!('/home/wish', 'site')).toEqual({ ok: true, path: '/home/wish/site' });
        expect(calls.filter((c) => c.method === 'host.mkdir').map((c) => c.args)).toEqual([['/home/wish', 'site']]);
    });
});

import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IpcMainEvent } from 'electron';
import { expect, vi } from 'vitest';
import { LOCAL_FRAME_CHANNELS, type LocalFramePort, type LocalFrameReply } from '../../src/core/local-frame.js';
import { Baton, PairingPins } from '../../src/core/remote.js';
import { inMemoryPair, transportHub, type PreAuth, type ServerConnection, type WireMessage } from '../../src/core/remote-protocol.js';
import { localProtocolDoor, type LocalDoorContents } from '../../src/main/local-protocol-door.js';
import { DeviceStore } from '../../src/main/remote-devices.js';
import { RemoteHost } from '../../src/main/remote-host.js';
import { buildHostApi } from '../../src/main/host-api.js';
import { connectRemote } from '../../src/renderer/remote-bridge.js';
import { localTransport } from '../../src/renderer/local-transport.js';
import { protocolContractDeps } from './protocol-contract-deps.js';
import { allowEveryPairing } from './allow-every-pairing.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
class Contents extends EventEmitter {
    mainFrame = { send: (_channel: string, _action: LocalFrameReply, _connection: string, _text: string) => {} };
    isDestroyed() { return false; }
}

/** The actual admitted door, real host/API and same renderer client, with only host resource sources injected. */
export async function resourceDoor(cleanups: Array<() => Promise<void>>, sources: Record<string, unknown> = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'genie-p4-resources-'));
    let seq = 0;
    const devices = await DeviceStore.open(dir, { now: Date.now, random: () => `synthetic-resource-device-${++seq}` });
    const api = buildHostApi(protocolContractDeps(dir)), invoke = vi.spyOn(api, 'invoke');
    const ipc = new EventEmitter(), door = localProtocolDoor(ipc);
    let accept!: (connection: ServerConnection) => void;
    const hub = transportHub({ onConnection: listener => { accept = listener; return () => {}; } }); hub.add(door);
    new RemoteHost(Object.assign({ api, hostName: 'resource-fixture', devices, baton: new Baton(), pins: new PairingPins({ now: Date.now }), confirm: allowEveryPairing, transport: hub }, sources));
    const closes: Array<() => void> = [], serialized: string[] = [], calls: Array<{ method: string; args: unknown[] }> = [];
    const rewrite = { frame: (text: string) => text };
    cleanups.push(async () => { for (const close of closes) close(); door.dispose(); await tick(); await devices.flushed(); await rm(dir, { recursive: true, force: true }); });
    function port(): LocalFramePort {
        const contents = new Contents(), listeners = new Set<Parameters<LocalFramePort['onFrame']>[0]>();
        contents.mainFrame.send = (_channel, action, handle, text) => {
            const delivered = action === 'frame' ? rewrite.frame(text) : text;
            serialized.push(delivered); queueMicrotask(() => { for (const l of listeners) l(action, handle, delivered); });
        };
        door.admit(contents as unknown as LocalDoorContents);
        return {
            onFrame: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
            send: (action, handle, text) => {
                if (action === 'frame') { serialized.push(text); const m = JSON.parse(text); if (m.kind === 'call') calls.push(m); }
                queueMicrotask(() => ipc.emit(LOCAL_FRAME_CHANNELS.toHost, { sender: contents, senderFrame: contents.mainFrame } as unknown as IpcMainEvent, action, handle, text));
            },
        };
    }
    async function raw(proof?: PreAuth | 'tailnet', mobile = false) {
        const p = proof === undefined ? null : inMemoryPair(), transport = p?.client ?? localTransport(port());
        const frames: WireMessage[] = [], waiting = new Map<number, (r: WireMessage) => void>();
        transport.onMessage(text => { const r: WireMessage = JSON.parse(text); frames.push(r); if (r.kind === 'result') waiting.get(r.id)?.(r); });
        closes.push(() => transport.close());
        if (p) accept({ ...p.server, ...(proof && proof !== 'tailnet' ? { preAuth: proof } : {}) });
        const auth = proof === undefined ? { kind: 'local' } : proof === 'tailnet' ? { kind: 'token', token: devices.pair('test owner').token } : { kind: 'relay' };
        transport.send(JSON.stringify({ kind: 'hello', auth, ...(mobile ? { profile: 'mobile' } : {}) })); await tick();
        expect(frames.some(f => f.kind === 'welcome')).toBe(true); await devices.flushed();
        let id = 0;
        return { transport, frames, call(method: string, args: unknown[]) {
            const next = ++id;
            const done = new Promise<WireMessage>(resolve => { waiting.set(next, r => { waiting.delete(next); resolve(r); }); });
            transport.send(JSON.stringify({ kind: 'call', id: next, method, args }));
            // An unrecognized method closes the transport instead of answering: make the initial red immediate.
            const refused = frames.find(f => f.kind === 'refused');
            if (refused) return Promise.resolve(refused);
            return Promise.race([done, tick().then(() => {
                const refusedAfter = frames.find(f => f.kind === 'refused');
                return refusedAfter ?? done;
            })]);
        } };
    }
    async function client(proof?: PreAuth) {
        const p = proof ? inMemoryPair() : null, transport = p?.client ?? localTransport(port());
        if (p && proof) accept({ ...p.server, preAuth: proof });
        const c = connectRemote(transport, { kind: proof ? 'relay' : 'local' }, 'resource-fixture');
        closes.push(() => c.close()); expect(await c.ready).toEqual({ ok: true }); return c;
    }
    return { raw, client, invoke, serialized, calls, rewrite };
}

export function resultValue<T>(r: WireMessage): T {
    expect(r).toMatchObject({ kind: 'result', ok: true }); return (r as { value: T }).value;
}

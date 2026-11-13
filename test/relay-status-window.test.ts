import { describe, expect, it } from 'vitest';
import { memoryPair } from '../src/core/line-transport.js';
import type { ClientTransport } from '../src/core/remote-protocol.js';
import { RelayHostReplica } from '../src/main/relay-host-replica.js';
import { RelayHostService, type RelayHostServicePorts, type RelayHostView } from '../src/main/relay-host-service.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { startRelayHost, type RelayHostHandle, type RelayHostStatus } from '../src/main/tynn-network.js';

/*
 * THE WINDOW SHOWS THE HOST'S RELAY STATUS AS IT IS NOW (Tynn #656). On a drone whose first relay ticket failed, genie-host
 * held "unavailable: Tynn could not be reached (…)" while the window read "connecting" for good. The window's `register`
 * reply carried the status of the moment it was answered ("connecting": the link had just started) and the failure's
 * event followed a moment later. A socket hands both frames over in one read; the event was applied at once, the reply
 * only after the read (its promise settles on a later turn) — so the older reply overwrote the newer event, and nothing
 * changed again to correct it.
 */

const TYNN = 'https://tynn.test';
const REASON = 'Tynn could not be reached (fetch failed)';

/** The window's end of the link: frames pass as they come, or are held and then handed over in ONE read, as a socket does. */
function socketLike(raw: ClientTransport) {
    const listeners = new Set<(text: string) => void>();
    const held: string[] = [];
    let holding = false;
    raw.onMessage((text) => { if (holding) held.push(text); else for (const l of [...listeners]) l(text); });
    return {
        transport: { send: (m: string) => raw.send(m), onMessage: (l: (t: string) => void) => { listeners.add(l); return () => listeners.delete(l); }, onClose: (l: () => void) => raw.onClose(l), close: () => raw.close() } as ClientTransport,
        hold: () => { holding = true; },
        held: () => held.map((t) => JSON.parse(t) as { kind: string; channel?: string; payload?: RelayHostView; value?: RelayHostView }),
        /** Every held frame in one read: synchronously, in order. */
        release: () => { holding = false; const frames = held.splice(0, held.length); for (const text of frames) for (const l of [...listeners]) l(text); },
    };
}

async function until(cond: () => boolean, ms = 2_000): Promise<void> {
    const end = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > end) throw new Error('timed out');
        await new Promise((r) => setTimeout(r, 1));
    }
}
const settle = () => new Promise((r) => setTimeout(r, 10));

/** genie-host's relay host, its engine and a window's replica over the real link; `start` is the link genie-host would run. */
async function rig(start: RelayHostServicePorts['start']) {
    let server: SessionEngineServer | null = null;
    const service: RelayHostService = new RelayHostService({
        account: () => ({ host: () => TYNN, status: () => ({ signedIn: true }), request: async () => ({ ok: true, status: 200, json: async () => ({}) }) as never }),
        workstation: {
            identity: async () => ({ workstationId: 'ws_me', fingerprint: 'fp' }),
            ensure: async () => ({ ok: true, workstationId: 'ws_me' }) as never,
            legacyDone: async () => null,
        },
        enabled: () => true,
        readRole: async () => 'drone',
        start,
        // As genie-host wires it: every change to every local window.
        onChange: () => server?.relayHostEvent(service.status()),
    });
    server = new SessionEngineServer({ token: 't', build: 'b', relayHost: service });
    const [h, raw] = memoryPair();
    server.accept(h, { local: true });
    const wire = socketLike(raw);
    const client = new SessionEngineClient({});
    expect(await client.connect(wire.transport, 't')).toMatchObject({ ok: true });
    return { service, wire, replica: client.relayHost() };
}

/** The real link (startRelayHost) with a first ticket that settles only after the register reply has gone out. */
function realLink(ticket: () => Promise<{ ticket: string; relayEndpoint: string }>, handles: RelayHostHandle[]): RelayHostServicePorts['start'] {
    return ({ workstationId, fingerprint, onStatus }) => {
        const handle = startRelayHost({
            ports: { ticket, keys: async () => [], introspect: async () => false },
            socket: () => { throw new Error('no relay is dialled without a ticket'); },
            workstationId,
            fingerprint,
            sign: () => Buffer.from('sig'),
            onStatus,
            ticketRetry: { minMs: 60_000, maxMs: 60_000 },
        });
        handles.push(handle);
        return handle;
    };
}

describe('the window\'s relay status follows genie-host\'s (Tynn #656)', () => {
    it('a first ticket that fails: the window shows "unavailable" with the host\'s reason, never "connecting"', async () => {
        const handles: RelayHostHandle[] = [];
        const r = await rig(realLink(() => new Promise((_, reject) => setTimeout(() => reject(new Error(REASON)), 5)), handles));
        r.wire.hold();
        const registered = r.replica.register(null);
        await until(() => r.wire.held().some((f) => f.kind === 'event' && f.channel === 'relayHost.event' && f.payload?.relay.state === 'unavailable'));
        // The gauge: the race is really here — the reply says "connecting" and the failure's event comes after it.
        const frames = r.wire.held();
        const reply = frames.findIndex((f) => f.kind === 'result');
        const failed = frames.findIndex((f) => f.kind === 'event' && f.payload?.relay.state === 'unavailable');
        expect(reply).toBeGreaterThanOrEqual(0);
        expect(frames[reply]!.value!.relay).toEqual({ state: 'connecting' });
        expect(failed).toBeGreaterThan(reply);
        r.wire.release();
        await registered;
        await settle();
        expect(r.service.status().relay).toEqual({ state: 'unavailable', reason: REASON });
        expect(r.replica.relay()).toEqual({ state: 'unavailable', reason: REASON });
        handles.forEach((h) => h.stop());
    });

    it('CONTROL: a link still asking for its first ticket shows "connecting" in the window, as on the host', async () => {
        const handles: RelayHostHandle[] = [];
        const r = await rig(realLink(() => new Promise(() => {}), handles));
        r.wire.hold();
        const registered = r.replica.register(null);
        await until(() => r.wire.held().some((f) => f.kind === 'result'));
        r.wire.release();
        await registered;
        await settle();
        expect(r.service.status().relay).toEqual({ state: 'connecting' });
        expect(r.replica.relay()).toEqual({ state: 'connecting' });
        handles.forEach((h) => h.stop());
    });

    it('CONTROL: a link that comes up shows "reachable" through that relay in the window', async () => {
        let onStatus: ((s: RelayHostStatus) => void) | null = null;
        const r = await rig((input) => {
            onStatus = input.onStatus;
            input.onStatus({ state: 'connecting' });
            return { status: () => ({ state: 'connecting' }), stop: () => {}, revalidate: async () => {} };
        });
        await r.replica.register(null);
        await settle();
        expect(r.replica.relay()).toEqual({ state: 'connecting' });
        onStatus!({ state: 'reachable', relay: 'wss://relay.test' });
        await settle();
        expect(r.replica.relay()).toEqual({ state: 'reachable', relay: 'wss://relay.test' });
    });
});

describe('the window\'s replica keeps the newest of genie-host\'s views', () => {
    const view = (epoch: string, rev: number, relay: RelayHostStatus): RelayHostView => ({ workstation: null, role: 'drone', relay, epoch, rev });

    it('an older view of the same host, arriving last, does not replace a newer one', () => {
        const replica = new RelayHostReplica(async () => null);
        replica.deliver(view('h1', 3, { state: 'unavailable', reason: REASON }));
        replica.deliver(view('h1', 2, { state: 'connecting' }));
        expect(replica.relay()).toEqual({ state: 'unavailable', reason: REASON });
    });

    it('CONTROL: a view as new or newer replaces it; a restarted genie-host (a new epoch) starts over', () => {
        const replica = new RelayHostReplica(async () => null);
        replica.deliver(view('h1', 3, { state: 'connecting' }));
        replica.deliver(view('h1', 3, { state: 'unavailable', reason: REASON }));
        expect(replica.relay()).toEqual({ state: 'unavailable', reason: REASON });
        replica.deliver(view('h1', 4, { state: 'reachable', relay: 'wss://relay.test' }));
        expect(replica.relay()).toEqual({ state: 'reachable', relay: 'wss://relay.test' });
        replica.deliver(view('h2', 0, { state: 'connecting' }));
        expect(replica.relay()).toEqual({ state: 'connecting' });
    });

    it('genie-host numbers every change, so a reply taken before a change is older than that change\'s event', async () => {
        let onStatus: ((s: RelayHostStatus) => void) | null = null;
        const events: RelayHostView[] = [];
        let service: RelayHostService | null = null;
        service = new RelayHostService({
            account: () => ({ host: () => TYNN, status: () => ({ signedIn: true }), request: async () => ({ ok: true, status: 200, json: async () => ({}) }) as never }),
            workstation: { identity: async () => ({ workstationId: 'ws_me', fingerprint: 'fp' }), ensure: async () => ({ ok: true, workstationId: 'ws_me' }) as never, legacyDone: async () => null },
            enabled: () => true,
            readRole: async () => 'drone',
            start: (input) => { onStatus = input.onStatus; input.onStatus({ state: 'connecting' }); return { status: () => ({ state: 'connecting' }), stop: () => {}, revalidate: async () => {} }; },
            onChange: () => { events.push(service!.status()); },
        });
        await service.register();
        const before = service.status();
        onStatus!({ state: 'unavailable', reason: REASON });
        const after = events.at(-1)!;
        expect(after.relay).toEqual({ state: 'unavailable', reason: REASON });
        expect(after.epoch).toBe(before.epoch);
        expect(after.rev).toBeGreaterThan(before.rev);
    });
});

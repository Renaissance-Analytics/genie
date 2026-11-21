import { describe, expect, it } from 'vitest';
import { RelayHostService, type RelayHostServicePorts, type RelayHostView } from '../src/main/relay-host-service.js';
import { startRelayHost, type RelayHostHandle, type RelayHostStatus } from '../src/main/tynn-network.js';

/*
 * THE WINDOW SHOWS THE HOST'S RELAY STATUS AS IT IS NOW (Tynn #656). On a drone whose first relay ticket failed, genie-host
 * held "unavailable: Tynn could not be reached (…)" while the window read "connecting" for good. The window's `register`
 * reply carried the status of the moment it was answered ("connecting": the link had just started) and the failure's
 * event followed a moment later. A socket hands both frames over in one read; the event was applied at once, the reply
 * only after the read (its promise settles on a later turn) — so the older reply overwrote the newer event, and nothing
 * changed again to correct it.
 *
 * Since Tynn #961 (2g-3c) the window keeps no replica of it and the engine link carries none of it: Settings reads genie-host's
 * relay host whole, from the features genie-host draws (features.snapshot), and its role from the host summary. What is left to
 * hold is genie-host's own reading, which is what every window now shows.
 */

const TYNN = 'https://tynn.test';
const REASON = 'Tynn could not be reached (fetch failed)';

async function until(cond: () => boolean, ms = 2_000): Promise<void> {
    const end = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > end) throw new Error('timed out');
        await new Promise((r) => setTimeout(r, 1));
    }
}
const settle = () => new Promise((r) => setTimeout(r, 10));

/** genie-host's relay host; `start` is the link genie-host would run. */
function rig(start: RelayHostServicePorts['start']) {
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
        onChange: () => {},
    });
    return { service };
}

/** The real link (startRelayHost) with a first ticket that settles only after the register reply has gone out. */
function realLink(ticket: () => Promise<{ ticket: string; relayEndpoint: string }>, handles: RelayHostHandle[]): RelayHostServicePorts['start'] {
    return ({ workstationId, fingerprint, onStatus }) => {
        const handle = startRelayHost({
            signedInHere: () => 'user_1',
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

describe('genie-host\'s relay status, which every window shows (Tynn #656)', () => {
    it('a first ticket that fails: "unavailable" with the reason, never "connecting"', async () => {
        const handles: RelayHostHandle[] = [];
        const r = rig(realLink(() => new Promise((_, reject) => setTimeout(() => reject(new Error(REASON)), 5)), handles));
        await r.service.register(null);
        await until(() => r.service.status().relay.state === 'unavailable');
        await settle();
        expect(r.service.status().relay).toEqual({ state: 'unavailable', reason: REASON });
        handles.forEach((h) => h.stop());
    });

    it('CONTROL: a link still asking for its first ticket is "connecting"', async () => {
        const handles: RelayHostHandle[] = [];
        const r = rig(realLink(() => new Promise(() => {}), handles));
        await r.service.register(null);
        await settle();
        expect(r.service.status().relay).toEqual({ state: 'connecting' });
        handles.forEach((h) => h.stop());
    });

    it('CONTROL: a link that comes up is "reachable" through that relay', async () => {
        let onStatus: ((s: RelayHostStatus) => void) | null = null;
        const r = rig((input) => {
            onStatus = input.onStatus;
            input.onStatus({ state: 'connecting' });
            return { status: () => ({ state: 'connecting' }), stop: () => {}, revalidate: async () => {} };
        });
        await r.service.register(null);
        expect(r.service.status().relay).toEqual({ state: 'connecting' });
        onStatus!({ state: 'reachable', relay: 'wss://relay.test' });
        expect(r.service.status().relay).toEqual({ state: 'reachable', relay: 'wss://relay.test' });
    });
});

describe('genie-host numbers its relay host\'s views', () => {
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

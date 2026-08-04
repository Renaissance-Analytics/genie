import { afterEach, describe, expect, it, vi } from 'vitest';
import { mobileEmit, setEventSockets } from '../bus';

/**
 * The HOST → REMOTE-client transport for Hosting-Manager parity. On the host,
 * `broadcastDevServerChanged()` and `broadcastDevSiteProgress()` (main/ipc.ts) each
 * add a `mobileEmit(...)` alongside their local broadcast — the SAME pattern
 * `broadcastWorkspacesChanged` already uses — so a REMOTE window driving this host
 * learns a site changed / is coming up over `/ws/events`. This pins the exact
 * frames those helpers put on the wire, which the client re-emits via
 * PASSTHROUGH_EVENTS (`dev-server:changed` / `dev-server:site-progress`) onto the
 * local channels the Site Manager already subscribes to.
 *
 * Asserted at the bus seam rather than through ipc.ts on purpose: importing the
 * root main/ipc.ts drags the whole app bootstrap (background.ts, which locks the
 * single instance at module load) in, so this tests the transport contract
 * directly — the frame shape is what must not drift.
 */

interface FakeSocket {
    readyState: number;
    send: ReturnType<typeof vi.fn>;
}
const makeSocket = (): FakeSocket => ({ readyState: 1, send: vi.fn() });
const asSockets = (s: unknown) => new Set([s]) as unknown as Parameters<typeof setEventSockets>[0];

afterEach(() => setEventSockets(null));

describe('dev-server events reach remote clients over /ws/events', () => {
    it('fans dev-server:site-progress with its full payload to connected sockets', () => {
        const sock = makeSocket();
        setEventSockets(asSockets(sock));

        const progress = {
            workspaceId: 'w1',
            siteId: 's1',
            name: 'web',
            genName: 'web.gen',
            phase: 'building' as const,
            log: 'step 1/3',
        };
        mobileEmit('dev-server:site-progress', progress);

        expect(sock.send).toHaveBeenCalledWith(
            JSON.stringify({ type: 'dev-server:site-progress', payload: progress }),
        );
    });

    it('fans a payload-less dev-server:changed to connected sockets', () => {
        const sock = makeSocket();
        setEventSockets(asSockets(sock));

        mobileEmit('dev-server:changed');

        expect(sock.send).toHaveBeenCalledWith(JSON.stringify({ type: 'dev-server:changed' }));
    });

    it('never sends to a socket that is not OPEN (readyState !== 1)', () => {
        const closing = { readyState: 2, send: vi.fn() };
        setEventSockets(asSockets(closing));
        mobileEmit('dev-server:changed');
        expect(closing.send).not.toHaveBeenCalled();
    });
});

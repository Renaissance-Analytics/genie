import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * genie#586 — "a workspace's lists moved" has TWO audiences, and it only ever
 * had one.
 *
 * `broadcastLocal` fans to this client's own windows and deliberately SKIPS
 * host-bound ones (their lists belong to another machine's db, so a local change
 * pushed into them would overwrite what they show). That is right, and it is
 * also why a REMOTE window's badge and panel never moved: nothing put the event
 * on `/ws/events`, so the host's own change never reached the client driving it.
 *
 * `mobileEmit` is the second audience — the same pairing `broadcastAgentsChanged`
 * and `broadcastDevServerChanged` already use, and a no-op when no remote is
 * connected. The client re-emits it onto its local channel via
 * PASSTHROUGH_EVENTS, so a remote panel refreshes push-style like a local one.
 *
 * Asserted here rather than through main/ipc.ts on purpose: importing the root
 * ipc.ts drags the whole Electron app bootstrap in, which is exactly why this
 * helper does not live there any more.
 */

const remote = vi.hoisted(() => ({ broadcastLocal: vi.fn() }));
vi.mock('../../remote', () => remote);

import { broadcastListsChanged } from '../announce';
import { setEventSockets } from '../../mobile/bus';

interface FakeSocket {
    readyState: number;
    send: ReturnType<typeof vi.fn>;
}
const makeSocket = (): FakeSocket => ({ readyState: 1, send: vi.fn() });
const asSockets = (s: unknown) => new Set([s]) as unknown as Parameters<typeof setEventSockets>[0];

beforeEach(() => remote.broadcastLocal.mockReset());
afterEach(() => setEventSockets(null));

describe('broadcastListsChanged', () => {
    it('still tells this machine’s own (non-host) windows', () => {
        broadcastListsChanged('w1');
        expect(remote.broadcastLocal).toHaveBeenCalledWith('lists:changed', { workspaceId: 'w1' });
    });

    it('ALSO puts it on /ws/events so a remote window driving this host hears it', () => {
        const sock = makeSocket();
        setEventSockets(asSockets(sock));

        broadcastListsChanged('w1');

        expect(sock.send).toHaveBeenCalledWith(
            JSON.stringify({ type: 'lists:changed', payload: { workspaceId: 'w1' } }),
        );
    });

    it('names the workspace on the wire — a panel must not re-read for another project', () => {
        const sock = makeSocket();
        setEventSockets(asSockets(sock));

        broadcastListsChanged('other-ws');

        const frame = JSON.parse(sock.send.mock.calls[0][0] as string) as {
            payload: { workspaceId: string };
        };
        expect(frame.payload.workspaceId).toBe('other-ws');
    });
});

import { describe, expect, it } from 'vitest';
import { workstationConnectState } from '../workstation-status';
import type { ConnectableWorkstation } from '../genie';

/**
 * The Hosts popover's WORKSTATIONS section must reflect the Genie Cloud
 * Controller's real host readiness (`status`) — it may only offer "Connect" for
 * a genuinely `active`, entitled host. These lock in the status→UI mapping so a
 * `provisioning`/`unreachable`/`terminated`/`locked` host can never be dialled
 * into a "relay handshake timed out".
 */

const ws = (over: Partial<ConnectableWorkstation>): ConnectableWorkstation => ({
    id: 'ws1',
    name: 'NewDawn',
    status: 'active',
    relay_endpoint: 'wss://relay.tynn.ai',
    connectable: true,
    capability: 'control',
    scopes: ['host:all'],
    source: 'owner',
    ...over,
});

describe('workstationConnectState', () => {
    it('enables Connect only for an active, entitled, connectable host', () => {
        const st = workstationConnectState(ws({ status: 'active', connectable: true, source: 'owner' }));
        expect(st.canConnect).toBe(true);
        expect(st.label).toBe('Connect');
        expect(st.dotColor).toBe('#22c55e');
        expect(st.showRetry).toBe(false);
    });

    it('disables Connect while provisioning (host not answering yet)', () => {
        const st = workstationConnectState(ws({ status: 'provisioning', connectable: false }));
        expect(st.canConnect).toBe(false);
        expect(st.label).toBe('Starting…');
        expect(st.dotColor).toBe('#eab308');
        expect(st.showRetry).toBe(true);
    });

    it('disables Connect (offers retry) when a live host went unreachable', () => {
        const st = workstationConnectState(ws({ status: 'unreachable', connectable: false }));
        expect(st.canConnect).toBe(false);
        expect(st.label).toBe('Unreachable');
        expect(st.dotColor).toBe('#f87171');
        expect(st.showRetry).toBe(true);
    });

    it('is the reported bug: an active-looking row whose host is down never offers Connect', () => {
        // The GCC now reports the down host as `unreachable`/`provisioning` even
        // if Tynn's stale `connectable` flag is still true — the status gate wins.
        const st = workstationConnectState(ws({ status: 'unreachable', connectable: true }));
        expect(st.canConnect).toBe(false);
    });

    it('disables Connect for locked and terminated lifecycle states', () => {
        expect(workstationConnectState(ws({ status: 'locked' })).label).toBe('Locked');
        expect(workstationConnectState(ws({ status: 'locked' })).canConnect).toBe(false);
        expect(workstationConnectState(ws({ status: 'terminated' })).label).toBe('Terminated');
        expect(workstationConnectState(ws({ status: 'terminated' })).canConnect).toBe(false);
    });

    it('shows "No access" for an active host the member is not entitled to', () => {
        const st = workstationConnectState(
            ws({ status: 'active', connectable: false, source: null, capability: null }),
        );
        expect(st.canConnect).toBe(false);
        expect(st.label).toBe('No access');
    });

    it('never enables Connect for an active host Tynn marks not-connectable', () => {
        const st = workstationConnectState(ws({ status: 'active', connectable: false, source: 'grant' }));
        expect(st.canConnect).toBe(false);
    });

    it('fails closed on an unknown/future status, echoing what the backend said', () => {
        const st = workstationConnectState(ws({ status: 'suspended', connectable: true }));
        expect(st.canConnect).toBe(false);
        expect(st.label).toBe('Unavailable');
        expect(st.title).toContain('suspended');
    });
});

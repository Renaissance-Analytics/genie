/**
 * Pure UI-state resolver for a Virtual Workstation row in the Hosts picker's
 * WORKSTATIONS section. Kept free of React/DOM so it can be unit-tested under
 * the Node test environment — master.tsx maps the result onto the status dot +
 * Connect button.
 *
 * Why this exists: the Genie Cloud Controller now reports REAL host readiness on
 * the `status` field — `provisioning` (infra up, host not yet answering),
 * `active` (host answering /readyz + fresh heartbeat), or `unreachable` (a live
 * host went stale) — plus lifecycle states like `terminated`/`locked`. Before
 * this gate the popover keyed "Connect" purely off Tynn's `connectable` flag,
 * which could still be true for a workstation whose HOST was down, so the popover
 * offered "Connect" and the dial then failed with "relay handshake timed out".
 *
 * The rule: only ever enable Connect when the host is genuinely `active` AND the
 * member is entitled (a live grant/role — `source !== null`) AND Tynn still marks
 * the row `connectable`. Every other status renders a DISABLED control that names
 * the real state, so a down/starting host can't be dialled into a timeout.
 */
import type { ConnectableWorkstation } from './genie';

/** Status-dot palette (matches the Hosts rows' green/amber/red/grey scheme). */
const DOT = {
    ready: '#22c55e', // green — connectable now
    pending: '#eab308', // amber — coming up (provisioning)
    error: '#f87171', // red — was up, now unreachable
    idle: '#52525b', // grey — locked / terminated / unknown / no access
} as const;

export interface WorkstationConnectState {
    /** Whether the Connect button should be enabled (host active + entitled). */
    canConnect: boolean;
    /** Button label — "Connect" when connectable, else the reason it isn't. */
    label: string;
    /** Hover title / tooltip explaining the state (used on dot + button). */
    title: string;
    /** Status-dot colour (hex). */
    dotColor: string;
    /** Offer an inline retry (rescan) affordance — for the transient states a
     *  refresh can clear (starting up / a host that may recover). */
    showRetry: boolean;
}

/**
 * Resolve the Connect-button + status-dot state for one workstation row.
 * Drives off the GCC/Tynn `status` readiness string; entitlement comes from a
 * non-null `source`; `connectable` is Tynn's own final gate (kept as a
 * belt-and-suspenders so we never enable Connect when the server withholds it).
 */
export function workstationConnectState(
    ws: Pick<ConnectableWorkstation, 'status' | 'connectable' | 'source'>,
): WorkstationConnectState {
    const entitled = ws.source !== null;

    switch (ws.status) {
        case 'active':
            if (ws.connectable && entitled) {
                return {
                    canConnect: true,
                    label: 'Connect',
                    title: 'Connect to this workstation over the Tynn relay',
                    dotColor: DOT.ready,
                    showRetry: false,
                };
            }
            // Host is up but the member has no live entitlement (or Tynn withheld
            // connectability) — surface no-access rather than a Connect that 403s.
            return {
                canConnect: false,
                label: 'No access',
                title: 'You do not currently have access to connect to this workstation',
                dotColor: DOT.idle,
                showRetry: false,
            };
        case 'provisioning':
            return {
                canConnect: false,
                label: 'Starting…',
                title: 'The workstation host is starting up — it will be connectable in a moment',
                dotColor: DOT.pending,
                showRetry: true,
            };
        case 'unreachable':
            return {
                canConnect: false,
                label: 'Unreachable',
                title: 'The workstation host stopped responding — retry once it recovers',
                dotColor: DOT.error,
                showRetry: true,
            };
        case 'locked':
            return {
                canConnect: false,
                label: 'Locked',
                title: 'This workstation is locked by its owner',
                dotColor: DOT.idle,
                showRetry: false,
            };
        case 'terminated':
            return {
                canConnect: false,
                label: 'Terminated',
                title: 'This workstation has been terminated',
                dotColor: DOT.idle,
                showRetry: false,
            };
        default:
            // Unknown / future status: fail closed (no Connect) but stay honest
            // about what the backend reported.
            return {
                canConnect: false,
                label: 'Unavailable',
                title: `Unavailable — ${ws.status}`,
                dotColor: DOT.idle,
                showRetry: false,
            };
    }
}

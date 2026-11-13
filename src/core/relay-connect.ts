import { skewSentence } from './drone-version.js';

/**
 * CONNECTING TO A TYNN WORKSTATION, STEP BY STEP (the owner, 2026-10-28, on beta.50's window: "So is the actually
 * connecting UX [ugly]"). beta.50 titled the window with the raw `relay:<id>`, opened the tailnet host/PIN form under it,
 * and said a bare red "workstation not connected" when the machine was offline. A person should see the machine's NAME,
 * what is happening, and — offline — a plain sentence with Retry.
 *
 * The three steps are the three things that really happen, in order (main/main.ts `genie:relay-open`, then the host's
 * welcome): Tynn mints a grant (`tynn`), the relay connects this machine to that one (`relay`), and that machine's Genie
 * checks the grant and lets this window in (`host`).
 *
 * Genie 1 (v0.7.0-beta.342) connected first and showed one line in the popover — "…" on the button, then the error
 * (master.tsx HostsPanel `openWorkstation` :4998-5010, the button :5134); its window came up only once connected (workstation-open.ts:80-85).
 * Genie 2 opens the window at once, so the window says the steps Genie 1 kept to a "…".
 */
export type RelayStep = 'tynn' | 'relay' | 'host';
export type RelayConnect =
    | { readonly kind: 'working'; readonly step: RelayStep }
    /**
     * `skew` (Tynn #651): the drone runs a Genie older than this Pilot needs: its build (`null`: it did not say) and this
     * Pilot's, to update it to. Said in place of the reason, which is the drone's protocol words.
     */
    | { readonly kind: 'failed'; readonly step: RelayStep; readonly reason: string; readonly offline?: boolean; readonly skew?: { readonly drone: string | null; readonly pilot: string | null } }
    /** The drone went away after it was up (an upgrade's restart, a quit): the window dials again by itself (Tynn #651). */
    | { readonly kind: 'reconnecting' };
export interface RelayConnectView {
    readonly title: string;
    readonly steps: ReadonlyArray<{ readonly step: RelayStep; readonly label: string; readonly status: 'done' | 'working' | 'failed' | 'waiting' }>;
    readonly problem: string | null;
    /** What is happening that needs no click ("aion is restarting, reconnecting…"); `null` otherwise. */
    readonly notice: string | null;
}

const ORDER: readonly RelayStep[] = ['tynn', 'relay', 'host'];

/** A machine with no name we know is "your workstation" — never its id. */
const shown = (name: string | null): string => (name && name.trim() !== '' ? name.trim() : 'your workstation');

/**
 * The relay's `no-host`: the machine is not connected to the relay. What it takes on that machine, in one sentence: Genie
 * running, signed in to Tynn, and Remote access on (it is off by default, and the relay link runs only while it is on —
 * main.ts `applyRelayHost`).
 */
export function offlineSentence(name: string | null): string {
    return `${shown(name)} is offline: it needs Genie running, signed in, and Remote access on.`;
}

export function relayConnectView(name: string | null, state: RelayConnect): RelayConnectView {
    const who = shown(name);
    const labels: Record<RelayStep, string> = {
        tynn: 'Ask Tynn for a way in',
        relay: `Reach ${who}`,
        host: `Open ${who}’s Genie`,
    };
    if (state.kind === 'reconnecting') {
        return {
            title: `Connecting to ${who}`,
            steps: ORDER.map((step) => ({ step, label: labels[step], status: step === 'host' ? 'working' as const : 'done' as const })),
            problem: null,
            notice: `${who} is restarting, reconnecting…`,
        };
    }
    const at = ORDER.indexOf(state.step);
    return {
        title: `Connecting to ${who}`,
        steps: ORDER.map((step, i) => ({
            step,
            label: labels[step],
            status: i < at ? 'done' : i > at ? 'waiting' : state.kind === 'failed' ? 'failed' : 'working',
        })),
        problem: state.kind !== 'failed' ? null : state.skew ? skewSentence(name, state.skew) : state.offline ? offlineSentence(name) : state.reason,
        notice: null,
    };
}

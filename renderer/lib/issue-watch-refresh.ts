/**
 * The state of the "refresh IssueWatch now" control.
 *
 * TYNN OWNS THE RATE LIMIT — one window per workspace, shared by every agent and
 * the human — so this renders what came back and never invents a wait. A
 * countdown computed here would disagree with the server's the moment another
 * Genie window, or an agent calling `checkIssues(refresh)`, spent the window
 * first; the disagreement shows up as a button that looks ready and is refused.
 *
 * PURE.
 */

export interface RefreshOutcome {
    refreshed: boolean;
    reason: 'refreshed' | 'cooldown' | 'failed' | 'unavailable';
    error?: string;
    cooldown: { seconds: number; nextAllowedAt: string | null; label: string };
}

export interface RefreshControlState {
    disabled: boolean;
    label: string;
    /** `wait` is the system working, not a fault — see `tone` at the call site. */
    tone: 'idle' | 'ok' | 'wait' | 'error';
    /** The failure text, when there is one, shown rather than summarised. */
    detail?: string;
    /**
     * This outcome must be SHOWN, not merely tinted.
     *
     * The owner reported the button "doesn't do anything at all". It had run
     * and failed: the whole report was a rose border and a `title` tooltip,
     * which is indistinguishable from an untouched button unless you hover it.
     * A control that reports a failure only on hover has not reported it.
     *
     * False for a cooldown on purpose — the limit doing its job is information,
     * and announcing it like a fault trains people to ignore the real ones.
     */
    announce?: boolean;
}

export function refreshControlState({
    busy,
    last,
}: {
    busy: boolean;
    last: RefreshOutcome | null;
}): RefreshControlState {
    if (busy) return { disabled: true, label: 'Refreshing…', tone: 'idle' };
    if (!last) return { disabled: false, label: 'Refresh now', tone: 'idle' };

    if (last.reason === 'failed' || last.reason === 'unavailable') {
        // Tynn never charged the window for a request it did not serve, so
        // there is nothing to wait for and retrying immediately is correct.
        return {
            disabled: false,
            label: 'Refresh now',
            tone: 'error',
            announce: true,
            // NEVER INVENT A CAUSE. This used to fall back to "Could not reach
            // Tynn", which is a specific claim and often the wrong one — a
            // refusal because Genie is not SIGNED IN, or because the workspace
            // is unknown, has nothing to do with reachability, and sends
            // someone to check their network over a sign-in problem. When the
            // outcome did not say why, say exactly that.
            detail: last.error ?? 'The refresh did not happen, and Genie was not told why.',
        };
    }

    const waiting = last.cooldown.seconds > 0;
    return {
        disabled: waiting,
        label: waiting ? `Next refresh in ${last.cooldown.label}` : 'Refresh now',
        // A refusal is the limit doing its job. Calling it an error would train
        // the owner to ignore the real ones.
        tone: last.reason === 'refreshed' ? 'ok' : waiting ? 'wait' : 'idle',
        detail:
            last.reason === 'cooldown' && waiting
                ? 'Someone already refreshed this workspace — the window is shared.'
                : undefined,
    };
}

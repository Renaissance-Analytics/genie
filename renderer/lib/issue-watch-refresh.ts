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
            detail: last.error ?? 'Could not reach Tynn.',
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

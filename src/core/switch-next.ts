import type { AccountWindowRow } from './accounts-view.js';

/**
 * WHICH ACCOUNT TO SWITCH TO NEXT (Tynn #988; the owner, 2026-11-20: the other accounts are "sorted by the account I should
 * switch to next based on remaining amount and reset date on rate limits"). Pure: it orders the accounts it is given (the
 * popover gives it every account but the signed-in one) and touches nothing.
 *
 * - An account's HEADROOM is its tightest window's share left: spent (over) is 0, and a window past its reset (Refreshed,
 *   or a reading whose reset time has gone by) has its room back, 100. A window never reported says nothing.
 * - The most headroom first. Within a CLOSE CALL (CLOSE_CALL_PCT of the leader of its group) the earliest reset of the
 *   tightest window goes first: its remaining allowance is the one that would otherwise be lost at the reset.
 * - Then the accounts with no figure at all (in the order given: room not known), then the spent ones, the soonest back first.
 */
export const CLOSE_CALL_PCT = 10;

interface Standing { readonly headroom: number | null; readonly resetsAtMs: number }

function standingOf(windows: readonly AccountWindowRow[], now: number): Standing {
    let headroom: number | null = null;
    let resetsAtMs = Number.NEGATIVE_INFINITY;
    for (const w of windows) {
        if ('unknown' in w) continue;
        const back = w.refreshed || w.resetsAtMs <= now;
        const left = back ? 100 : w.over ? 0 : Math.max(0, Math.min(100, w.leftPct));
        const reset = back ? Number.NEGATIVE_INFINITY : w.resetsAtMs;
        // The tightest window binds; of two equally tight, the later reset is when the account is really free again.
        if (headroom === null || left < headroom || (left === headroom && reset > resetsAtMs)) { headroom = left; resetsAtMs = reset; }
    }
    return { headroom, resetsAtMs };
}

export function rankSwitchNext<T extends { readonly windows: readonly AccountWindowRow[] }>(accounts: readonly T[], now: number): T[] {
    const rows = accounts.map((account, order) => ({ account, order, ...standingOf(account.windows, now) }));
    const roomy = rows.filter((r) => r.headroom !== null && r.headroom > 0).sort((a, b) => b.headroom! - a.headroom! || a.order - b.order);
    const unknown = rows.filter((r) => r.headroom === null);
    const spent = rows.filter((r) => r.headroom === 0).sort((a, b) => a.resetsAtMs - b.resetsAtMs || a.order - b.order);
    const ranked: typeof rows = [];
    // Close calls are grouped from the top down: each group is its leader and every account within CLOSE_CALL_PCT of it.
    for (let i = 0; i < roomy.length;) {
        const leader = roomy[i]!.headroom!;
        let j = i;
        while (j < roomy.length && leader - roomy[j]!.headroom! < CLOSE_CALL_PCT) j++;
        ranked.push(...roomy.slice(i, j).sort((a, b) => a.resetsAtMs - b.resetsAtMs || b.headroom! - a.headroom! || a.order - b.order));
        i = j;
    }
    return [...ranked, ...unknown, ...spent].map((r) => r.account);
}

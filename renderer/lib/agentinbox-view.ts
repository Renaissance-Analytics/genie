/**
 * PURE view logic for the AgentInbox human panel (genie #64).
 *
 * Extracted from `AgentInboxFlyout.tsx` so the ordering rule, the headcount pill
 * and the persisted read state are unit-testable — the renderer has no jsdom
 * harness, so only framework-free helpers are covered (see vitest.config.ts).
 *
 * READ/UNREAD IS A CLIENT CONCEPT. The human panel's read state is the VIEWER's
 * own: which rows *this person on this device* has looked at. It is never
 * derived from the host broker's agent ACK cursors — those are the AGENTS' read
 * position and drive a different surface entirely (the header's agent-lag badge,
 * `agentLagCount()`). Conflating them meant the human "reading" a thread implied
 * an agent had, and vice versa. So this state lives in localStorage, keyed by
 * `currentConnKey()` — the same per-window/per-workstation bucket
 * `renderer/lib/view-state.ts` uses — and the host never sees it.
 */

/** The human panel's sender identity token (mirrors the broker's `AGENTINBOX_HUMAN`). */
export const HUMAN_ID = 'human';

/**
 * The broker's DM PAIR key for two participants — order-independent, so the key
 * the panel sends to delete a thread is byte-identical to the one the host
 * echoes back on `agentinbox:cleared`. Mirrors the broker's own `pairKey()`.
 */
export function sortedPairKey(a: string, b: string): string {
    return [a, b].sort().join('|');
}

/**
 * Map a broker DM PAIR key (`<idA>|<idB>`, sorted — what `dmThreads()` and the
 * `agentinbox:cleared` push report) onto the panel's ROW key.
 *
 * A human↔agent thread and the human's DM with that same agent are deliberately
 * ONE row (`d:<agentId>`); an agent↔agent thread the human only observes is a
 * `p:` row. Without this, a `cleared` push for a pair would miss the row whose
 * read state and selection it needs to invalidate.
 */
export function rowKeyOfPairKey(pairKey: string): string {
    const sep = pairKey.indexOf('|');
    if (sep < 0) return `p:${pairKey}`;
    const a = pairKey.slice(0, sep);
    const b = pairKey.slice(sep + 1);
    if (a === HUMAN_ID) return `d:${b}`;
    if (b === HUMAN_ID) return `d:${a}`;
    return `p:${[a, b].sort().join('|')}`;
}

/** Last-activity stamp of a list row. `seq` is the broker's monotonic counter. */
export interface RowActivityStamp {
    ts: number;
    seq: number;
}

/**
 * Order list rows by LAST ACTIVITY, newest first — the panel's only sort, for
 * channels and DMs alike. Ties within a millisecond break on `seq` (monotonic,
 * so the order is total and deterministic). Rows with no activity yet (a channel
 * nobody has posted in) sink below every row that has some, keeping their
 * relative order. Returns a NEW array.
 */
export function sortByActivityDesc<T>(
    rows: readonly T[],
    activityOf: (row: T) => RowActivityStamp | undefined,
): T[] {
    return [...rows].sort((x, y) => {
        const a = activityOf(x);
        const b = activityOf(y);
        if (!a && !b) return 0;
        if (!a) return 1;
        if (!b) return -1;
        return b.ts - a.ts || b.seq - a.seq;
    });
}

/**
 * The headcount pill's `active/total`. "Active" is an agent whose terminal is
 * live (`online`); `away` (pty exited, spec retained) and `offline` count only
 * toward the total.
 */
export function headcountOf(agents: readonly { status: string }[]): {
    active: number;
    total: number;
} {
    return {
        active: agents.filter((a) => a.status === 'online').length,
        total: agents.length,
    };
}

/**
 * Most rows the persisted read state keeps. Row keys are per-conversation, and
 * agents churn (every new agent is a new DM row), so an uncapped blob would grow
 * without bound in a long-lived workstation. The rows with the HIGHEST seq —
 * i.e. the most recently active — survive a prune.
 */
export const SEEN_CAP = 300;

/** localStorage key for a window's read state, bucketed by its connection. */
export function seenStorageKey(connKey: string): string {
    return `genie.agentinbox.seen.${connKey}`;
}

/** Parse a persisted blob into the seen map; anything malformed reads as empty. */
export function parseSeenState(json: string | null | undefined): Map<string, number> {
    const out = new Map<string, number>();
    if (!json) return out;
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        return out;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'number' && Number.isFinite(value)) out.set(key, value);
    }
    return prune(out);
}

/** Serialize the seen map for localStorage, pruned to {@link SEEN_CAP}. */
export function serializeSeenState(map: ReadonlyMap<string, number>): string {
    return JSON.stringify(Object.fromEntries(prune(map)));
}

/** Keep only the `SEEN_CAP` most-recently-active rows. */
function prune(map: ReadonlyMap<string, number>): Map<string, number> {
    if (map.size <= SEEN_CAP) return new Map(map);
    const kept = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, SEEN_CAP);
    return new Map(kept);
}

/**
 * Mark a row seen up to `seq`. MONOTONIC — scrolling back through old history
 * must never un-read a row. Returns the SAME map when nothing moved, so a React
 * state setter can skip the re-render.
 */
export function markSeen(
    map: ReadonlyMap<string, number>,
    rowKey: string,
    seq: number,
): Map<string, number> {
    if ((map.get(rowKey) ?? -1) >= seq) return map as Map<string, number>;
    return new Map(map).set(rowKey, seq);
}

/**
 * Drop a row from the read state — the conversation was deleted, so keeping its
 * high-water mark would silently pre-read a future thread that reuses the key.
 * Returns the SAME map when the row was absent.
 */
export function forgetSeen(
    map: ReadonlyMap<string, number>,
    rowKey: string,
): Map<string, number> {
    if (!map.has(rowKey)) return map as Map<string, number>;
    const next = new Map(map);
    next.delete(rowKey);
    return next;
}

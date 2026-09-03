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
import type { AgentType } from './genie';
import { isTuiId } from '../../main/agents/registry';

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

/**
 * Collapse a BURST of calls into one run (genie #66).
 *
 * A mass delete emits one `cleared` push per target — deliberately, so each
 * window's per-key cache invalidation stays exact. But the directory refetch
 * that follows is 3 requests, and on a remote Host they cross the relay, so N
 * targets would mean 3N round trips for a single user action. This collapses the
 * REFETCH while leaving the per-key invalidation untouched.
 *
 * Not a poll: nothing fires unless an event scheduled it.
 */
export function makeCoalescer(
    run: () => void,
    delayMs = 40,
): { schedule: () => void; cancel: () => void } {
    let timer: ReturnType<typeof setTimeout> | null = null;
    return {
        schedule() {
            if (timer !== null) return; // a run is already queued for this burst
            timer = setTimeout(() => {
                timer = null;
                run();
            }, delayMs);
        },
        cancel() {
            if (timer === null) return;
            clearTimeout(timer);
            timer = null;
        },
    };
}

/**
 * MULTI-SELECT (genie #66). A selected row is held as one opaque token so a
 * single `Set<string>` can mix channels and DM threads; `partitionWipeTargets`
 * turns the set back into the host's batch shape.
 *
 * `<kind>:<key>` — and the key itself contains separators (a channel key is
 * `ws1:general`, a pair key is `a|b`), so parsing MUST split on the first
 * delimiter only.
 */
export function wipeToken(kind: 'channel' | 'dm', key: string): string {
    return `${kind}:${key}`;
}

/**
 * Split selection tokens into the `wipeMany` call shape. Deduped, and malformed
 * or empty tokens are dropped rather than forwarded as junk to the host.
 */
export function partitionWipeTargets(tokens: readonly string[]): {
    channelKeys: string[];
    pairKeys: string[];
} {
    const channels = new Set<string>();
    const pairs = new Set<string>();
    for (const token of tokens) {
        const sep = token.indexOf(':');
        if (sep <= 0) continue;
        const kind = token.slice(0, sep);
        const key = token.slice(sep + 1);
        if (!key) continue;
        if (kind === 'channel') channels.add(key);
        else if (kind === 'dm') pairs.add(key);
    }
    return { channelKeys: [...channels], pairKeys: [...pairs] };
}

/** Add or remove a token, returning a NEW set (never mutating the input). */
export function toggleSelection(
    selected: ReadonlySet<string>,
    token: string,
): Set<string> {
    const next = new Set(selected);
    if (!next.delete(token)) next.add(token);
    return next;
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

// --- agent identity, as a PERSON reads it (Tynn #254) ------------------------

/** The AI TUI an agent runs, as the directory reports it. */
export type AgentTuiId = AgentType;

/** The two pieces a human-facing agent row renders. */
export interface AgentDisplay {
    /** Which provider LOGO to draw, or null for the human / a departed agent. */
    provider: AgentTuiId | null;
    /** The agent's NAME. Never a ref, never a chat-id. */
    name: string;
}

/** The directory fields this module needs. Loose, so it stays framework-free. */
interface AgentLike {
    agentType?: string;
    label?: string;
    purpose?: string;
}

/**
 * How an agent is shown to a PERSON: the provider's logo, plus the name.
 *
 * Three rules, and each one removes something that was on screen before:
 *
 *  - the NAME is `purpose` (`tynn`), not `label` (`claude · tynn`). The provider
 *    is the logo now, so repeating it in the text is the same fact twice — and
 *    it is the half that made every row start with the same word.
 *  - the PROVIDER is returned as an id, not a two-letter code. Initials made
 *    `claude:tynn` and `codex:tynn` read as `cl` and `cx` beside identical
 *    names; a logo is what actually tells them apart at a glance.
 *  - the chat-id has NO field here at all. It is addressing, not identity, and
 *    a shape that cannot carry it cannot leak it.
 *
 * A departed agent (present in a thread, gone from the directory) keeps its
 * logged label rather than rendering blank — a DM with somebody has to say who.
 *
 * `isTuiId` is the registry's membership test, deliberately rather than a local
 * one. The local one was `'claude' || 'codex' || 'custom'` — the provider set of
 * the day, frozen. `kiwi` and `genie` were registered later and fell straight
 * through it, so their rows drew the two-letter initials meant for a HUMAN or a
 * departed agent. Nothing errored; the logo was simply never asked for
 * (genie#261).
 */
export function agentDisplayOf(agent: AgentLike | undefined, fallback = ''): AgentDisplay {
    const provider = isTuiId(agent?.agentType) ? agent.agentType : null;
    const name = agent?.purpose?.trim() || agent?.label?.trim() || fallback;
    return { provider, name };
}

/**
 * The two-letter code for a participant with NO provider logo — the human, and
 * an agent that has left the directory. Kept because those rows still need
 * something in the avatar circle.
 */
export function avatarInitials(source: string): string {
    return source.replace(/[^a-z0-9]/gi, '').slice(0, 2).toLowerCase() || '??';
}

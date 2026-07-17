/**
 * IssueWatch → agent pings (feature: per-agent + per-workspace ping handling).
 *
 * When a server-fed IssueWatch delta lands (see `applyPushedDelta`), some agents
 * should be told about it — but NOT every opted-in agent, or a busy workspace
 * would have five terminals all reacting to one issue. This module is the PURE
 * core of that decision: it resolves WHICH agents receive a workspace's ping and
 * HOW each reacts, plus the change-detection that keeps a re-sent-but-unchanged
 * delta from spamming. It holds no electron / db / broker references so every
 * branch is unit-tested; the effectful sinks (glow a terminal, wake an idle
 * agent) are injected by the caller.
 */

/** How an agent reacts to an IssueWatch ping. */
export type IssueWatchAction = 'notify' | 'wake';

/** A candidate agent's IssueWatch settings (from its `terminal_specs.meta_json`). */
export interface IssueWatchAgent {
    /** The agent terminal's id (its spec id). */
    terminalId: string;
    /** `issuewatch_handle` — this agent participates in IssueWatch pings. */
    handle: boolean;
    /** `issuewatch_action` — how it reacts when it receives one. */
    action: IssueWatchAction;
}

/** A resolved recipient of a workspace's ping. */
export interface IssueWatchRecipient {
    terminalId: string;
    action: IssueWatchAction;
}

/**
 * The effectful sinks the dispatcher drives. Injected so the routing rule stays
 * pure/testable and the electron-facing effects (terminal glow, pty nudge) live
 * at the edge.
 */
export interface IssueWatchDispatchSinks {
    /** Glow a terminal so the user/agent notices the ping. */
    notify: (terminalId: string) => void;
    /** Inject an idle-only wake nudge; returns true iff the agent was idle and
     *  the nudge was actually sent (a mid-turn agent is never touched). */
    wake: (terminalId: string) => boolean;
}

/**
 * Resolve which of a workspace's agents receive its IssueWatch ping.
 *
 *   - When the workspace's DESIGNATED handler set is NON-EMPTY, only agents in
 *     that set receive it — AND only if they also have `issuewatch_handle` true
 *     (a designated-but-not-handle-enabled agent is excluded).
 *   - When the designated set is EMPTY, fall back to ALL `issuewatch_handle`
 *     agents in the workspace.
 *
 * Pure — no ordering guarantees beyond the input agent order.
 */
export function resolveIssueWatchRecipients(
    designated: readonly string[],
    agents: readonly IssueWatchAgent[],
): IssueWatchRecipient[] {
    const enabled = agents.filter((a) => a.handle);
    const set = new Set(designated);
    const scoped = set.size > 0 ? enabled.filter((a) => set.has(a.terminalId)) : enabled;
    return scoped.map((a) => ({ terminalId: a.terminalId, action: a.action }));
}

/**
 * Dispatch a resolved recipient list through the injected sinks: `wake` agents
 * get an idle-only nudge, `notify` agents get a terminal glow. The wake sink
 * itself decides whether the agent is idle (fail-safe); this just routes.
 */
export function dispatchIssueWatchPings(
    recipients: readonly IssueWatchRecipient[],
    sinks: IssueWatchDispatchSinks,
): void {
    for (const r of recipients) {
        if (r.action === 'wake') sinks.wake(r.terminalId);
        else sinks.notify(r.terminalId);
    }
}

/** The minimal item shape the change-detector needs (a subset of the feed row). */
export interface SignedItem {
    key: string;
    updatedAt: string;
}

/**
 * A signature of a workspace's feed — each item's key mapped to its updatedAt.
 * Stored per workspace so the next delta can tell whether anything genuinely
 * changed (see {@link hasNewOrChangedItems}).
 */
export function feedSignature(items: readonly SignedItem[]): Map<string, string> {
    const sig = new Map<string, string>();
    for (const it of items) sig.set(it.key, it.updatedAt);
    return sig;
}

/**
 * Did this feed gain a NEW item or an UPDATED one versus the prior signature?
 *
 *   - `prev` undefined ⇒ the workspace's FIRST snapshot this session: treat it as
 *     a baseline and DON'T ping (a reconnect / app-boot snapshot must not fire a
 *     ping-storm for pre-existing items).
 *   - Otherwise, ping iff some item's key is new OR its updatedAt advanced. A
 *     pure removal (an item disappeared, nothing added/updated) is NOT a ping —
 *     there's nothing new to act on.
 */
export function hasNewOrChangedItems(
    prev: ReadonlyMap<string, string> | undefined,
    items: readonly SignedItem[],
): boolean {
    if (!prev) return false;
    for (const it of items) {
        const before = prev.get(it.key);
        if (before === undefined || it.updatedAt > before) return true;
    }
    return false;
}

/** The canned wake nudge injected to an idle handler when an IssueWatch ping
 *  fires — benign + self-describing, like the WhisperChat wake text, so a turn it
 *  starts is obviously an IssueWatch wake and not smuggled instructions. */
export function issueWatchWakeText(): string {
    return 'A watched GitHub item changed (IssueWatch); open the IssueWatch panel to see what needs attention.';
}

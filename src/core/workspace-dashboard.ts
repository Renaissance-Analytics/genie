import { heartbeat, type ActivityFeed, type FeedItem } from './activity-feed.js';
import { groupByWorkspace, statusOf, type AgentRow, type AgentState, type Fidelity, type StatusCell } from './dashboard-view.js';
import { deckBand, isStale, type DeckItem } from './deck.js';
import { ageOf } from './delivery.js';

/**
 * THE WORKSPACE DASHBOARD — the workspace's first tab: A LANE PER AGENT. No React in sight.
 *
 * The owner, 2026-10-20: *"this workspace dashboard is useless. Each agent should have a full lane that shows me a
 * heartbeat of activity. Not some stupid card that contains my msg … THINK BETTER."* Asked rows or columns
 * (q_99659edf), he chose ROWS: each lane full width; state, heartbeat, plan and now on the left, the feed running right.
 *
 * Every agent of the workspace gets a lane — stopped ones too — in the board's order (waiting, broken, working, idle):
 *
 *   - its state, and how long it has been in it (from its feed: since its turn began, its question was parked …);
 *   - a HEARTBEAT: rows per minute over the last 30 minutes, read against the window's clock so it slides;
 *   - PLAN: the session's latest plan event (step of, and the step in progress) — Genie's `plan` tool feeds it;
 *   - NOW: the tool or command running this second;
 *   - its own waiting-on-you: its questions and approvals on the Deck, each to open;
 *   - a LIVE FEED of its real session events, newest first — edits with ± lines, commands, replies, tool calls, turn
 *     ends — and a filed handoff at its time;
 *   - stopped: its last activity, and Start.
 *
 * It REPLACES the cards (running agents only), the workspace "Waiting on you" band and "Last finished" — which read the
 * last `imDone` handoff, so for an agent answering in chat it never updated. Finished is now the session's turn ends.
 *
 * What was not reported is `null` and renders as nothing (§5: never a dash, never a zero). A lane whose feed has not
 * arrived claims nothing — no flat heartbeat (that would say "quiet"), no "stopped".
 */

export interface LaneWaiting {
    id: string;
    title: string;
}

export interface LaneFeedItem extends FeedItem {
    /** `now`, `3m`, `1h 5m` — empty when the row carries no time. */
    age: string;
}

export interface DashLane {
    id: string;
    name: string;
    provider: string;
    fidelity: Fidelity;
    state: AgentState;
    /** The state word; `Stopped` for an agent with no running session. */
    word: string;
    tone: StatusCell['tone'];
    /** No running session (from its feed). `false` until the feed says so. */
    stopped: boolean;
    /** How long in its state: `14m`; `null` = not known. */
    inState: string | null;
    /** A stopped agent's last activity: `2h 5m`; `null` otherwise. */
    lastActive: string | null;
    /** What is wrong, when broken; what it asks, when waiting with nothing on the Deck yet. */
    detail: string | null;
    /** 30 bars, oldest first; `null` until its feed arrives. */
    heartbeat: number[] | null;
    /** The rows in those 30 minutes. */
    beats: number;
    plan: { step: string; doing: string | null } | null;
    /** The tool or command running this second; only while working. */
    now: string | null;
    waiting: readonly LaneWaiting[];
    feed: readonly LaneFeedItem[];
}

export interface WorkspaceDashboardView {
    /** EVERY agent of the workspace, for the header's agents strip (a pill each, idle ones too), in the board's order. */
    strip: ReadonlyArray<{ id: string; name: string; fidelity: Fidelity; state: AgentState; word: string }>;
    lanes: readonly DashLane[];
    /** What waits on you in this workspace that belongs to NO lane (a flow's question): it has no other way in here. */
    waiting: readonly LaneWaiting[];
    /** The workspace has no agents at all: "No agents in X." and + Add agent. */
    noAgents: boolean;
}

export function workspaceDashboard(input: {
    rows: readonly AgentRow[];
    workspaceId: string;
    deckItems: readonly DeckItem[];
    feeds?: Readonly<Record<string, ActivityFeed>>;
    now: number;
}): WorkspaceDashboardView {
    const { now } = input;
    const feeds = input.feeds ?? {};
    const [group] = groupByWorkspace(input.rows, [input.workspaceId]);
    const mine = group?.rows ?? [];
    const ids = new Set(mine.map((r) => r.id));
    const open = deckBand(input.deckItems).filter((item) => item.workspaceId === input.workspaceId && !isStale(item));

    const lanes = mine.map((row): DashLane => {
        const feed = feeds[row.id] ?? null;
        const status = statusOf(row);
        // Stopped only when its feed SAYS it has no session — and an agent waiting or broken is that first.
        const stopped = feed !== null && !feed.running && row.state !== 'waiting' && row.state !== 'broken';
        const items: LaneFeedItem[] = (feed?.items ?? []).map((i) => ({ ...i, age: ageOf(i.at, now) }));
        // A FILED handoff joins the feed at its time (it is shown only when one is filed).
        if (row.handoff) {
            const h = row.handoff;
            const handoff: LaneFeedItem = { id: `handoff:${row.id}`, at: h.at, kind: 'handoff', text: h.text, by: null, plus: null, minus: null, status: null, age: ageOf(h.at, now) };
            const at = items.findIndex((i) => i.at !== null && i.at < h.at);
            items.splice(at < 0 ? items.length : at, 0, handoff);
        }
        const bars = feed ? heartbeat(feed.beats, now) : null;
        const plan = feed?.plan
            ? { step: `${feed.plan.step}/${feed.plan.of}`, doing: feed.plan.doing }
            : row.step ? { step: row.step, doing: row.target } : null;
        return {
            id: row.id,
            name: row.name,
            provider: row.provider,
            fidelity: row.fidelity,
            state: row.state,
            word: stopped ? 'Stopped' : status.word,
            tone: stopped ? 'muted' : status.tone,
            stopped,
            inState: feed && feed.since !== null && !stopped ? ageOf(feed.since, now) : null,
            lastActive: stopped && feed!.lastAt !== null ? ageOf(feed!.lastAt, now) : null,
            detail: row.state === 'broken' ? row.reason : row.state === 'waiting' ? row.ask : null,
            heartbeat: bars,
            beats: bars ? bars.reduce((s, n) => s + n, 0) : 0,
            plan,
            now: row.state === 'working' ? row.tool ?? null : null,
            waiting: open.filter((item) => item.agentId === row.id).map((item) => ({ id: item.id, title: item.title })),
            feed: items,
        };
    });

    const strip = mine.map((row) => ({ id: row.id, name: row.name, fidelity: row.fidelity, state: row.state, word: statusOf(row).word }));
    const waiting = open.filter((item) => item.agentId === null || !ids.has(item.agentId)).map((item) => ({ id: item.id, title: item.title }));
    return { strip, lanes, waiting, noAgents: mine.length === 0 };
}

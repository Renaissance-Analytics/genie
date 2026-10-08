import { sessionFidelity, type AgentSession, type SessionFidelity, type ToolCall } from '../../main/agentsession/model';

/**
 * THE WORKFLOW DASHBOARD's projection — `genie://dashboard?group=workspace`.
 *
 * The owner's question for this surface: *"what is being produced, and by whom?"* That is
 * deliberately NOT the Deck's question (*"does anything need me?"*), and the split is the
 * owner's own ruling: the Deck is a queue you clear, the Dashboard is a board you read. A
 * fact that demands a human belongs on the Deck; the same agent appears here without
 * demanding anything.
 *
 * Every rule below is from the spec board, not from my own view of what a dashboard should
 * be. Two of them overrule the earlier agent-written design, and both are noted at the site.
 *
 * ## Why this file is pure and separate from the component
 *
 * `deck-view.ts` set the precedent and the reason holds: decisions trapped in JSX can only be
 * reached by an E2E shard. The sort order, the status vocabulary, the context threshold and
 * what counts as a delivery are all decisions. The component is the render only.
 */

/** The states a row can be in, IN THE ORDER THE BOARD SORTS THEM. */
export const STATE_ORDER = ['waiting', 'broken', 'working', 'idle', 'remote'] as const;

export type DashboardState = (typeof STATE_ORDER)[number];

/**
 * CONTEXT IS SHOWN ONLY FROM HERE UP — 80% of a 200k window.
 *
 * The board: *"Context shows on the Dashboard only at 80% and above."* Below that it is
 * noise, and §6.2's rule about silence applies to numbers as well as signals: a column of
 * comfortable figures trains people to stop reading the one that matters. 178k/200k is a
 * reason to act now; 40k is not a reason to do anything.
 */
export const CONTEXT_SHOW_FROM_K = 160;

/** And from here it is red rather than amber — compaction is imminent. */
const CONTEXT_CRITICAL_FROM_K = 180;

/** What each kind of delivery is drawn with. The board's own mapping. */
export const DELIVERY_ICON = {
    commit: 'git-commit-horizontal',
    file: 'file-code',
    handoff: 'arrow-right-left',
    answer: 'message-square-reply',
} as const;

export type DeliveryKind = keyof typeof DELIVERY_ICON;

export interface DashboardDelivery {
    kind: DeliveryKind;
    /** The artifact itself — a filename, a short sha, a peer, a sentence. */
    main: string;
    /** Context for it, or null. A commit subject; where a handoff went. */
    sub: string | null;
    /** Monospace for a commit or a path; sans for prose. The board's distinction. */
    mono: boolean;
    /** When it was produced, for the row's age column. */
    at: number;
}

export interface DashboardContext {
    /** Thousands, as the board labels it: `182k`. */
    label: string;
    /** Fraction of the window, for the bar. */
    pct: number;
    level: 'warn' | 'critical';
}

export interface DashboardRow {
    agentId: string;
    specId: string | null;
    name: string;
    provider: string | null;
    fidelity: SessionFidelity;
    state: DashboardState;
    /** `Working` / `Active` / `Waiting on you` / `Broken` / `Idle` / `Quiet` / `Unreachable`. */
    statusWord: string;
    /** The question, the reason, or how long — whichever the state makes true. Null when
     *  there is nothing honest to add. */
    statusDetail: string | null;
    /** `3/4` — where the agent is in its own plan. Null when there is no plan to read. */
    step: string | null;
    /** The in-progress plan step. Null when absent, and ALWAYS null on a broken row. */
    target: string | null;
    delivery: DashboardDelivery | null;
    /**
     * Whether a context cell is DRAWN for this agent at all.
     *
     * Separate from `context` being null, and the distinction is §6.3 versus §6.1: an Observed
     * agent has no context cell (absence of a control), where a declared agent below the
     * threshold has an empty one (a figure not worth showing yet). Collapsing the two would
     * either promise an Observed agent a reading it can never give, or hide the column.
     */
    showsContextCell: boolean;
    context: DashboardContext | null;
    /** null ⇒ Genie cannot attribute this agent's comms. NEVER render 0 for it — see the
     *  note on the collaboration join in the designer brief §8.1. */
    collaborators: number | null;
    error: string | null;
}

export interface DashboardWorkspace {
    id: string;
    name: string;
    path: string;
}

export interface DashboardGroup {
    key: string;
    name: string;
    path: string;
    /** `3 agents · 1 waiting · 1 broken`. */
    summary: string;
    /** False for the group holding agents that belong to no workspace (`genie`). */
    isWorkspace: boolean;
    /** A real workspace with no agents — offers Add agent rather than disappearing. */
    isEmpty: boolean;
    rows: DashboardRow[];
}

export interface DashboardFigures {
    waiting: number;
    broken: number;
    working: number;
    idle: number;
}

export interface DashboardView {
    groups: DashboardGroup[];
    figures: DashboardFigures;
}

export interface DashboardInput {
    now: number;
    workspaces: DashboardWorkspace[];
}

function stateOf(s: AgentSession): DashboardState {
    // Broken outranks the turn state: an agent with an error is not "working" however
    // recently it moved, and the board gives it no target for the same reason.
    if (s.error) return 'broken';
    if (s.turn.state === 'awaiting-input' || s.turn.state === 'awaiting-approval') return 'waiting';
    if (s.turn.state === 'idle') return 'idle';
    return 'working';
}

/** How long the current state has held, as the board writes it: `12m`, `1h`. */
function since(now: number, at: number): string | null {
    const ms = now - at;
    if (ms < 0) return null;
    const mins = Math.floor(ms / 60_000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function statusOf(
    s: AgentSession,
    state: DashboardState,
    fidelity: SessionFidelity,
    now: number,
): { word: string; detail: string | null } {
    if (state === 'broken') return { word: 'Broken', detail: s.error };
    if (state === 'waiting') {
        // THE QUESTION ITSELF, not a count. A row that says "1 question" has to be opened to
        // be understood, which defeats a board you read.
        const asked = s.approvals[0]?.name ?? null;
        return { word: 'Waiting on you', detail: asked };
    }
    const observed = fidelity === 'observed';
    if (state === 'working') return { word: observed ? 'Active' : 'Working', detail: since(now, s.turn.since) };
    return { word: observed ? 'Quiet' : 'Idle', detail: since(now, s.turn.since) };
}

/** The last SEGMENT of a path. A row has no room for `/w/main/acp/ipc.ts`, and the question
 *  the cell answers is "which file", not "where". */
function basename(path: string): string | null {
    const parts = path.split(/[\\/]/).filter((p) => p.length > 0);
    return parts.length > 0 ? parts[parts.length - 1]! : null;
}

/** The tool kinds that PRODUCE something. A read is not a delivery — the board's wording is
 *  "the last thing it actually produced", which excludes looking. */
const PRODUCING_KINDS = new Set(['edit', 'write', 'create', 'delete', 'move']);

function pathOf(call: ToolCall): string | null {
    const input = call.rawInput;
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
    const record = input as Record<string, unknown>;
    for (const key of ['file_path', 'filePath', 'path']) {
        const value = record[key];
        if (typeof value === 'string' && value.trim().length > 0) return value;
    }
    return null;
}

/**
 * The latest delivery, from what the agent has reported.
 *
 * Today that means a finished edit, which `ToolCall.rawInput` made readable (genie#843). The
 * board also shows `commit`, `handoff` and `answer` deliveries; those need a repo watch, the
 * AgentInbox thread and the turn-final message respectively, and this returns null rather than
 * guessing at them — a wrong delivery is worse than a blank cell, because the cell is the one
 * piece of history the surface exists to keep.
 */
function deliveryOf(s: AgentSession): DashboardDelivery | null {
    let best: { call: ToolCall; at: number } | null = null;
    for (const call of s.tools) {
        if (call.status !== 'success') continue;
        if (call.kind === null || !PRODUCING_KINDS.has(call.kind)) continue;
        const path = pathOf(call);
        if (!path) continue;
        // BY THE STAMP, not by array position: order is arrival order, and two calls that run
        // concurrently can finish out of it.
        const at = call.at ?? 0;
        if (!best || at > best.at) best = { call, at };
    }
    if (!best) return null;
    const name = basename(pathOf(best.call)!);
    if (!name) return null;
    return { kind: 'file', main: name, sub: null, mono: true, at: best.at };
}

function contextOf(s: AgentSession): DashboardContext | null {
    const used = s.usage?.contextUsed ?? null;
    const max = s.usage?.contextMax ?? null;
    if (used === null) return null;
    const k = Math.round(used / 1000);
    if (k < CONTEXT_SHOW_FROM_K) return null;
    return {
        label: `${k}k`,
        pct: max && max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 100,
        level: k >= CONTEXT_CRITICAL_FROM_K ? 'critical' : 'warn',
    };
}

function planOf(s: AgentSession, state: DashboardState): { step: string | null; target: string | null } {
    // A broken agent gets neither. The board: "A broken row replaces its target with the route
    // to fix it" — a stale target beside a dead agent reads as current work.
    if (state === 'broken' || !s.plan || s.plan.length === 0) return { step: null, target: null };
    const index = s.plan.findIndex((e) => e.status === 'in-progress');
    if (index === -1) return { step: null, target: null };
    return { step: `${index + 1}/${s.plan.length}`, target: s.plan[index]!.title };
}

function rowOf(s: AgentSession, now: number): DashboardRow {
    const state = stateOf(s);
    const fidelity = sessionFidelity(s);
    const status = statusOf(s, state, fidelity, now);
    const { step, target } = planOf(s, state);
    const observed = fidelity === 'observed';
    return {
        agentId: s.agentId,
        specId: s.specId,
        name: s.session.name,
        provider: s.session.provider,
        fidelity,
        state,
        statusWord: status.word,
        statusDetail: status.detail,
        step,
        target,
        delivery: deliveryOf(s),
        // An Observed agent reports no usage, so the cell is not drawn at all rather than
        // drawn empty — §6.3, and the same discipline as its missing Conversation tab.
        showsContextCell: !observed,
        context: observed ? null : contextOf(s),
        // Null until the comms attribution exists: `whisper_messages` keys on the terminal's
        // own id, not `workspace_agents.id`, and that join breaks for a dormant agent. Brief
        // §8.1. A confident 0 here would claim an agent works alone.
        collaborators: null,
        error: s.error,
    };
}

function summaryOf(rows: DashboardRow[]): string {
    const bits: string[] = [];
    if (rows.length) bits.push(`${rows.length} ${rows.length === 1 ? 'agent' : 'agents'}`);
    const count = (state: DashboardState) => rows.filter((r) => r.state === state).length;
    if (count('waiting')) bits.push(`${count('waiting')} waiting`);
    if (count('broken')) bits.push(`${count('broken')} broken`);
    return bits.join(' · ');
}

export function dashboardView(sessions: AgentSession[], input: DashboardInput): DashboardView {
    const rank = (state: DashboardState) => STATE_ORDER.indexOf(state);
    const sort = (rows: DashboardRow[]) =>
        [...rows].sort((a, b) => {
            const byState = rank(a.state) - rank(b.state);
            // TIES BREAK ON NAME, not on arrival. A board that reshuffles equal rows between
            // renders is unreadable at twenty agents, and `since` changes every tick.
            return byState !== 0 ? byState : a.name.localeCompare(b.name);
        });

    const groups: DashboardGroup[] = [];

    // The OS agent first — it belongs to no workspace, and the board puts it above them with
    // its own label rather than inventing a workspace for it.
    const loose = sessions.filter((s) => !s.session.workspaceId);
    if (loose.length) {
        const rows = sort(loose.map((s) => rowOf(s, input.now)));
        groups.push({
            key: '__loose__',
            name: rows.length === 1 ? rows[0]!.name : 'Not in a workspace',
            path: 'default agent · not in a workspace',
            summary: summaryOf(rows),
            isWorkspace: false,
            isEmpty: false,
            rows,
        });
    }

    for (const workspace of input.workspaces) {
        const rows = sort(
            sessions.filter((s) => s.session.workspaceId === workspace.id).map((s) => rowOf(s, input.now)),
        );
        groups.push({
            key: workspace.id,
            name: workspace.name,
            path: workspace.path,
            summary: summaryOf(rows),
            isWorkspace: true,
            // Kept rather than hidden: a workspace that disappears when its agents stop is one
            // you cannot start work in. The board gives it an Add agent affordance.
            isEmpty: rows.length === 0,
            rows,
        });
    }

    const all = groups.flatMap((g) => g.rows);
    const tally = (state: DashboardState) => all.filter((r) => r.state === state).length;

    return {
        groups,
        figures: {
            waiting: tally('waiting'),
            broken: tally('broken'),
            working: tally('working'),
            idle: tally('idle'),
        },
    };
}

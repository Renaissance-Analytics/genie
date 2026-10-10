/**
 * THE DASHBOARD'S DECISIONS, with no React in sight.
 *
 * Every rule the board encodes — the sort, the status vocabulary, which cells exist for
 * which fidelity, when context appears — lives here as a pure function, so it can be tested
 * without a DOM. A decision taken inside a component is a decision nobody checks, and the
 * previous build put most of them there.
 *
 * ## What the Dashboard IS
 *
 * *"What is being produced, and by whom?"* A board you READ. It has **no resolving control
 * anywhere** — no approve, no deny, no answer, no composer, not even in a row tray. A
 * waiting row links to its Deck item and is answered there. The Deck resolves; the Dashboard
 * shows. `A`/`D` are deliberately unbound on this surface.
 *
 * ## The rule that governs every cell
 *
 * A number Genie cannot see renders as **NOTHING** — never a dash, never a zero. A dash
 * reads as zero, and a zero is a confident claim: a `0` in a collaborator cell says this
 * agent works alone. The opposite also holds: `[]` and `0` from a *declared* agent are
 * FACTS. Those two cases are different types here, not a convention.
 */

/** What Genie can see of an agent. Decides which cells exist at all, not just their values. */
export type Fidelity =
    /** Speaks ACP. Reports plan, deliveries, comms, usage. */
    | 'declared'
    /** A TUI the user opened via Take Over. Genie sees activity and nothing else. */
    | 'observed'
    /** On another workstation. Presence only. */
    | 'remote';

export type AgentState = 'waiting' | 'broken' | 'working' | 'idle' | 'remote';

export type DeliveryKind = 'commit' | 'file' | 'handoff' | 'answer';

export interface Delivery {
    kind: DeliveryKind;
    /** The commit sha, path, target or answer text. */
    main: string;
    sub: string | null;
    /** Only ever from a real diff. Never estimated — see `plus`/`minus` in the tests. */
    plus: number | null;
    minus: number | null;
    age: string;
}

export interface AgentRow {
    id: string;
    name: string;
    provider: string;
    workspaceId: string;
    fidelity: Fidelity;
    state: AgentState;
    /** `Working 12m` / `Idle 42m` — the duration half. */
    duration: string | null;
    /** The question text, when waiting. */
    ask: string | null;
    /** Why it is broken, and what fixes it. */
    reason: string | null;
    fixes: readonly string[];
    /** `4/7` — a plan step, when the agent reports one. */
    step: string | null;
    target: string | null;
    /** Byte activity for an observed agent. A measurement, where a target is a claim. */
    activity: readonly number[] | null;
    delivery: Delivery | null;
    /** `null` = Genie cannot attribute it. NEVER 0 — a zero claims the agent works alone. */
    collaborators: number | null;
    /** Traffic on a link within the last 30s. */
    commsLive: boolean;
    /** Tokens used. `null` = not reported (an observed agent never reports it). */
    contextUsed: number | null;
    contextSize: number | null;
}

/** Context is a *warning*, not a readout — it appears only once it is worth acting on. */
export const CONTEXT_WARN_AT = 160_000;
export const CONTEXT_DANGER_AT = 180_000;

/**
 * Sort order: **waiting → broken → working → idle → remote**.
 *
 * The board overruled a commissioned design that sorted by delivery recency and argued
 * explicitly against demanding rows first. The board wins: an agent that has stopped and is
 * waiting on a human is the only state where the human is the bottleneck, so it leads.
 */
const STATE_ORDER: Record<AgentState, number> = {
    waiting: 0, broken: 1, working: 2, idle: 3, remote: 4,
};

export interface StatusCell {
    /** The word. `Working`/`Idle` for declared; `Active`/`Quiet` for observed. */
    word: string;
    /** The detail beside it: a duration, the question, the failure reason. */
    detail: string | null;
    tone: 'ok' | 'warn' | 'bad' | 'muted';
}

/**
 * The status word and its detail.
 *
 * Declared and observed use DIFFERENT vocabularies on purpose. `Working` is a claim about
 * what an agent is doing, which Genie only knows when the agent says so. For a TUI it can
 * see bytes and nothing else, so `Active` — the grammar carries the epistemology.
 */
export function statusOf(row: AgentRow): StatusCell {
    if (row.fidelity === 'remote') {
        return { word: 'Unreachable', detail: row.reason, tone: 'muted' };
    }
    switch (row.state) {
        case 'waiting':
            return { word: 'Waiting on you', detail: row.ask, tone: 'warn' };
        case 'broken':
            return { word: 'Broken', detail: row.reason, tone: 'bad' };
        case 'working':
            return { word: row.fidelity === 'observed' ? 'Active' : 'Working', detail: row.duration, tone: 'ok' };
        default:
            return { word: row.fidelity === 'observed' ? 'Quiet' : 'Idle', detail: row.duration, tone: 'muted' };
    }
}

export type ContextCell = { used: number; size: number; pct: number; tone: 'warn' | 'bad' } | null;

/**
 * The context cell, or `null` for "render nothing".
 *
 * Three separate reasons to render nothing, and they are not the same thing:
 *  - an **observed** agent never reports context, so the cell does not exist for it;
 *  - a declared agent that has not reported yet is `null` — unknown, not zero;
 *  - a declared agent **below the threshold** is fine, and a readout nobody needs is noise.
 *
 * Only the third is "nothing is wrong". The first two are "we cannot see", and neither may
 * render a dash, because a dash reads as zero.
 */
export function contextOf(row: AgentRow): ContextCell {
    if (row.fidelity !== 'declared') return null;
    if (row.contextUsed === null || row.contextSize === null || row.contextSize <= 0) return null;
    if (row.contextUsed < CONTEXT_WARN_AT) return null;

    return {
        used: row.contextUsed,
        size: row.contextSize,
        pct: Math.round((row.contextUsed / row.contextSize) * 100),
        tone: row.contextUsed >= CONTEXT_DANGER_AT ? 'bad' : 'warn',
    };
}

export type CommsCell = { count: number; live: boolean } | null;

/**
 * The comms cell, or `null`.
 *
 * Observed and remote agents have no comms cell at all — not an empty one. And a declared
 * agent whose collaborator count could not be attributed renders **nothing**, because a `0`
 * would claim it works alone when the truth is that Genie could not join the table.
 */
export function commsOf(row: AgentRow): CommsCell {
    if (row.fidelity !== 'declared') return null;
    if (row.collaborators === null) return null;
    return { count: row.collaborators, live: row.commsLive };
}

/** What occupies the "current target" column — they are mutually exclusive. */
export type TargetCell =
    | { kind: 'target'; step: string | null; text: string }
    | { kind: 'activity'; bars: readonly number[] }
    | { kind: 'fixes'; fixes: readonly string[] }
    | null;

export function targetOf(row: AgentRow): TargetCell {
    // A broken row replaces its target with the route to fix it. What it *was* doing is no
    // longer the useful fact.
    if (row.state === 'broken' && row.fixes.length > 0) return { kind: 'fixes', fixes: row.fixes };
    if (row.fidelity === 'observed' && row.activity) return { kind: 'activity', bars: row.activity };
    if (row.target) return { kind: 'target', step: row.step, text: row.target };
    return null;
}

export interface WorkspaceGroup {
    workspaceId: string;
    rows: readonly AgentRow[];
    /** `4 agents · 1 waiting · 1 broken` — omits a clause that is zero rather than saying 0. */
    summary: string;
    /** True when the workspace has no agents, which offers "Add agent" rather than a blank. */
    empty: boolean;
}

export function groupByWorkspace(
    rows: readonly AgentRow[],
    workspaceIds: readonly string[],
): readonly WorkspaceGroup[] {
    return workspaceIds.map((workspaceId) => {
        const mine = rows
            .filter((r) => r.workspaceId === workspaceId)
            .slice()
            .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]);

        const count = (s: AgentState): number => mine.filter((r) => r.state === s).length;
        const parts: string[] = [];
        if (mine.length > 0) parts.push(`${mine.length} ${mine.length === 1 ? 'agent' : 'agents'}`);
        if (count('waiting') > 0) parts.push(`${count('waiting')} waiting`);
        if (count('broken') > 0) parts.push(`${count('broken')} broken`);

        return { workspaceId, rows: mine, summary: parts.join(' · '), empty: mine.length === 0 };
    });
}

export interface SummaryChip {
    label: string;
    state: AgentState;
}

/**
 * The header chips.
 *
 * A state with no agents in it produces **no chip** rather than `0 broken`. Signals appear
 * only when true; a strip of zeroes is furniture that trains people to stop reading it.
 */
export function summaryChips(rows: readonly AgentRow[]): readonly SummaryChip[] {
    const label: Record<AgentState, string> = {
        waiting: 'waiting on you', broken: 'broken', working: 'working', idle: 'idle', remote: 'unreachable',
    };
    const order: AgentState[] = ['waiting', 'broken', 'working', 'idle', 'remote'];

    return order.flatMap((state) => {
        const n = rows.filter((r) => r.state === state).length;
        return n > 0 ? [{ label: `${n} ${label[state]}`, state }] : [];
    });
}

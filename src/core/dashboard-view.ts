import type { CommsLink } from './comms.js';
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
    /**
     * Seconds since the most recent message on any of this agent's links.
     *
     * `null` = the edge is real but its recency is NOT observable, which is a different
     * claim from "it has been quiet" and must not render as one.
     *
     * This replaced a `commsLive: boolean`. The boolean was *derived* — "traffic in the
     * last 30s" is `age <= 30` — and keeping both let them disagree: a fixture with zero
     * collaborators and `commsLive: true` asserted traffic on a link that did not exist, and
     * the suite was green about it. One fact, stored once.
     */
    commsAgeSeconds: number | null;
    /** Each collaborator link (peer id, count, age), newest first — the collaborator reveal's lanes. `null` = not measured. */
    links?: readonly CommsLink[] | null | undefined;
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

/**
 * How recently an edge carried traffic. Structurally Fancy's `ActivityLevel`, declared here
 * so that `src/core` stays free of anything that imports React — the assignment is checked
 * at the component boundary instead.
 *
 * `'unseen'` exists in the component and is deliberately NOT in this union: it means "it
 * moved and you have not looked", which is a badge, and **the Deck is the only surface that
 * carries badges**.
 */
export type CommsLevel = 'live' | 'recent' | 'quiet';

/** The board's own words: "a violet pulsing dot when a link carried traffic in the last 30s". */
export const COMMS_LIVE_WITHIN = 30;
/**
 * Beyond live, still part of what is happening now. Five minutes is roughly one turn, so
 * inside it a link belongs to the current work; past it the honest word is quiet.
 */
export const COMMS_RECENT_WITHIN = 300;

export type CommsCell = { count: number; level: CommsLevel | null } | null;

/**
 * The comms cell, or `null` for "this cell does not exist".
 *
 * **Three different nothings live in this one function**, and collapsing any two of them is
 * the mistake §5 is about:
 *
 *  1. **No cell.** An observed or remote agent does not report collaborators, so the cell is
 *     absent — not empty, not zero.
 *  2. **No cell.** A declared agent whose count could not be attributed. `0` here would say
 *     it works alone, when the truth is Genie could not join the table.
 *  3. **A cell with no light.** `level: null` — the count is a fact we hold, the recency is
 *     not. `ActivityLight` renders nothing for it, because a grey dot asserts "quiet".
 *
 * And the case that is NOT nothing: a measured `0`. The agent told us it works alone, which
 * is information, and suppressing it would be indistinguishable from never having looked.
 * With no collaborators there is no edge, so there is no recency either — whatever the clock
 * says, a light there would be traffic on a link that does not exist.
 */
export function commsOf(row: AgentRow): CommsCell {
    if (row.fidelity !== 'declared') return null;
    if (row.collaborators === null) return null;

    const level: CommsLevel | null =
        row.collaborators === 0 || row.commsAgeSeconds === null ? null
        : row.commsAgeSeconds <= COMMS_LIVE_WITHIN ? 'live'
        : row.commsAgeSeconds <= COMMS_RECENT_WITHIN ? 'recent'
        : 'quiet';

    return { count: row.collaborators, level };
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

/**
 * A WORKSPACE-LEVEL fault on the group header (the board: `⚠ repo site not found in moic.agi  [Locate repo]`): a
 * registered repo whose folder is not where the manifest says. One at a time — the first missing repo; the fix is a
 * door to the workspace's registry, where the path is edited. `null` when every registered repo is there, and when
 * the repos have not been read (not a fault Genie has seen).
 */
export interface WorkspaceFault {
    readonly text: string;
    readonly repo: string;
}

export function workspaceFault(repos: readonly { slug: string; missing?: boolean | undefined }[] | null, workspaceName: string): WorkspaceFault | null {
    const gone = repos?.find((r) => r.missing === true);
    if (!gone) return null;
    return { text: `repo ${gone.slug} not found in ${workspaceName}.agi`, repo: gone.slug };
}

export interface WorkspaceGroup {
    workspaceId: string;
    rows: readonly AgentRow[];
    /** `4 agents · 1 waiting · 1 broken` — omits a clause that is zero rather than saying 0. */
    summary: string;
    /** True when the workspace has no agents, which offers "Add agent" rather than a blank. */
    empty: boolean;
    /** Present only when an ops project governs this workspace (§6.1). */
    governedBy?: string;
    /** Present only when the workspace has a fault of its own (a missing repo). */
    fault?: WorkspaceFault;
}

export function groupByWorkspace(
    rows: readonly AgentRow[],
    workspaceIds: readonly string[],
    governedBy: Readonly<Record<string, string>> = {},
    faults: Readonly<Record<string, WorkspaceFault | null | undefined>> = {},
): readonly WorkspaceGroup[] {
    // Governed workspaces follow their governor (§6.1), in the given order.
    const ids = new Set(workspaceIds);
    const ordered: string[] = [];
    for (const id of workspaceIds) {
        const governor = governedBy[id];
        if (governor !== undefined && ids.has(governor)) continue;
        ordered.push(id);
        for (const child of workspaceIds) if (governedBy[child] === id) ordered.push(child);
    }
    return ordered.map((workspaceId) => {
        const mine = rows
            .filter((r) => r.workspaceId === workspaceId)
            .slice()
            .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]);

        const count = (s: AgentState): number => mine.filter((r) => r.state === s).length;
        const parts: string[] = [];
        if (mine.length > 0) parts.push(`${mine.length} ${mine.length === 1 ? 'agent' : 'agents'}`);
        if (count('waiting') > 0) parts.push(`${count('waiting')} waiting`);
        if (count('broken') > 0) parts.push(`${count('broken')} broken`);

        return { workspaceId, rows: mine, summary: parts.join(' · '), empty: mine.length === 0, ...(governedBy[workspaceId] ? { governedBy: governedBy[workspaceId]! } : {}), ...(faults[workspaceId] ? { fault: faults[workspaceId]! } : {}) };
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

export interface StatusGroup {
    state: AgentState;
    /** `Waiting on you` / `Broken` / `Working` / `Idle` / `Unreachable`. */
    label: string;
    rows: readonly AgentRow[];
}

/**
 * `By status` (the header's segmented control): one group per state in the board's order, and NO group for a
 * state with no agents — an empty heading would be a count of zero wearing a label.
 */
export function groupByStatus(rows: readonly AgentRow[]): readonly StatusGroup[] {
    const label: Record<AgentState, string> = { waiting: 'Waiting on you', broken: 'Broken', working: 'Working', idle: 'Idle', remote: 'Unreachable' };
    const order: AgentState[] = ['waiting', 'broken', 'working', 'idle', 'remote'];
    return order.flatMap((state) => {
        const mine = rows.filter((r) => r.state === state);
        return mine.length > 0 ? [{ state, label: label[state], rows: mine }] : [];
    });
}

export type FixRoute = { kind: 'restart' | 'takeover' | 'open'; agentId: string };

/**
 * What a broken row's fix button DOES. The labels come from the session's failure report (`Sign in to kimi`,
 * `Restart`, `Terminal`); two of them are verbs Genie can perform, and anything else is a route to the agent, whose
 * header carries the real controls. A button that only looks like a button is the audit finding this replaces.
 */
export function fixRoute(agentId: string, fix: string): FixRoute {
    if (fix === 'Restart') return { kind: 'restart', agentId };
    if (fix === 'Terminal') return { kind: 'takeover', agentId };
    return { kind: 'open', agentId };
}

import type { Fidelity } from './dashboard-view.js';
import { observedState, type TakeOverProbe } from './observed.js';
import type { AgentTab } from './route.js';
import type { LiveSession } from './roster.js';

/**
 * THE AGENT VIEW'S DECISIONS — tabs, the state pill, the right rail.
 *
 * ## Absence of a tab, never a disabled tab
 *
 * *"A disabled control is an accusation; a different shape is a fact."* A declared agent has
 * `Stream | Files | Changes`; an observed one has `Terminal | Activity | Files | Changes` and
 * **no Stream at all**, because Genie sees bytes from that TUI and nothing else.
 *
 * ## The failure this file is shaped around
 *
 * §0.4, which cost three releases. `sessionFidelity()` returned `observed` for every agent, so
 * every agent rendered `Activity | Files | Changes` and a **finished Conversation UI was
 * unreachable**. One condition hid an entire feature, and every test of that feature passed.
 *
 * So: `tabsFor` is a total function over the three fidelities, and the test counts which ones
 * contain `stream` rather than spot-checking the one that should.
 */

const TABS: Record<Fidelity, readonly AgentTab[]> = {
    /** Stream is first and always present. With no events it shows an empty state, not nothing. */
    declared: ['stream', 'files', 'changes'],
    /** Activity first (the board). A Stream tab here would be a tab that cannot populate. */
    observed: ['activity', 'terminal', 'files', 'changes'],
    /**
     * Presence only.
     *
     * Files and Changes come from git, which Genie can read without the remote agent's
     * cooperation. Everything else would be a claim about an unreachable machine.
     */
    remote: ['files', 'changes'],
};

export function tabsFor(fidelity: Fidelity): readonly AgentTab[] {
    return TABS[fidelity];
}

export interface StatePill {
    word: string;
    /** `m:ss` while a turn is running. `null` when there is nothing to count. */
    elapsed: string | null;
    tone: 'ok' | 'warn' | 'bad' | 'muted';
}

function clock(from: number, now: number): string {
    const total = Math.max(0, Math.floor((now - from) / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** `40s ago` / `5m ago` / `2h ago`. */
function ago(from: number, now: number): string {
    const s = Math.max(0, Math.floor((now - from) / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
}

export interface PillContext {
    /** Turns so far — the pill speaks in turns (`Turn 14 · running`). */
    turns: number;
    /** The live Take Over probe for an observed agent; its pill is a measurement (`Active · last output 40s ago`). */
    takeOver?: TakeOverProbe | null | undefined;
}

/**
 * The header's state pill, in the board's words (`Agent View.dc.html`):
 *
 *  - `Turn 14 · running` + a clock — the clock belongs only to a turn that is actually running; on an idle agent it
 *    counts up forever and reads as work in progress;
 *  - `Turn 15 · parked · waiting on you` — no clock Genie cannot measure;
 *  - `Broken · <reason>`; `Idle` after turns; `No turns yet` for a session that has not taken one; `Not started` for an
 *    agent that is registered and has no session — not "Idle", which would claim a session exists;
 *  - observed: `Active · last output 40s ago` / `Quiet · last output 5m ago` / `Quiet · no output yet` — what was measured.
 */
export function statePill(session: LiveSession | null, now: () => number, ctx: PillContext = { turns: 0 }): StatePill {
    if (ctx.takeOver) {
        const probe = ctx.takeOver;
        const state = observedState(probe.lastOutputAt, now());
        const last = probe.lastOutputAt === null ? 'no output yet' : `last output ${ago(probe.lastOutputAt, now())}`;
        return { word: `${state === 'active' ? 'Active' : 'Quiet'} · ${last}`, elapsed: null, tone: state === 'active' ? 'ok' : 'muted' };
    }
    if (!session) return { word: 'Not started', elapsed: null, tone: 'muted' };
    if (session.pendingApproval !== null) return { word: `Turn ${ctx.turns} · parked · waiting on you`, elapsed: null, tone: 'warn' };
    if (session.failure !== null) return { word: `Broken · ${session.failure.reason}`, elapsed: null, tone: 'bad' };

    const running = session.running && session.turnState === 'working';
    if (!running) return { word: ctx.turns === 0 && session.running ? 'No turns yet' : 'Idle', elapsed: null, tone: 'muted' };

    return {
        word: `Turn ${ctx.turns} · running`,
        elapsed: session.startedAt === null ? null : clock(session.startedAt, now()),
        tone: 'ok',
    };
}

export interface HeaderActions {
    /** While a turn runs: stop the agent's work (§6.2 stop — identity, persona, inbox and history kept). */
    stop: boolean;
    /** Only when broken (the board): the graceful restart that resumes the same thread. */
    restart: boolean;
    /** In the error state: the Take Over window is the terminal. */
    openTerminal: boolean;
    takeOver: boolean;
    chat: boolean;
}

/** The board's header actions by state. An observed agent is not managed: nothing to stop or restart. */
export function headerActions(session: LiveSession | null, fidelity: Fidelity): HeaderActions {
    const managed = fidelity === 'declared' && session !== null;
    const broken = managed && session.failure !== null;
    const running = managed && !broken && session.running && session.turnState === 'working';
    return { stop: running, restart: broken, openTerminal: broken, takeOver: true, chat: true };
}

export interface PlanPanel {
    step: number;
    of: number;
    doing: string;
}

/**
 * The Plan panel, or `null` for "do not draw it".
 *
 * *"Plan and context are not known yet, so they are absent, not empty."* An empty plan panel
 * reads as an agent working without a plan; the truth before the first turn is that it has not
 * said what its plan is.
 */
export function planFor(session: LiveSession | null): PlanPanel | null {
    return session?.plan ?? null;
}

export interface BudgetPanel {
    used: number;
    size: number;
    pct: number;
    /** `null` = the provider reports no cost. codex reports none — so there is no Cost ROW. */
    cost: number | null;
    turns: number;
}

/**
 * The Budget panel, or `null`.
 *
 * Absent until context has been reported, because the panel's subject is the budget and a bar
 * at 0% reads as an agent that has used nothing. The cost is separately nullable: **codex
 * reports none, so there is no Cost row at all** — not a zero, which claims the work was free,
 * and not a dash, which reads as zero.
 */
export function budgetFor(session: LiveSession | null, cost: number | null, turns: number): BudgetPanel | null {
    if (!session) return null;
    if (session.contextUsed === null || session.contextSize === null || session.contextSize <= 0) return null;

    return {
        used: session.contextUsed,
        size: session.contextSize,
        pct: Math.round((session.contextUsed / session.contextSize) * 100),
        cost,
        turns,
    };
}

/** Below this content width the rail becomes a 32px summary strip. */
export const RAIL_COLLAPSE_AT = 1100;

/**
 * Whether the right rail is collapsed. **Width only.**
 *
 * It takes one argument and that is the point: a rail that collapsed because a number went
 * missing would move the conversation sideways mid-turn, while someone is reading it. There is
 * no state it could collapse for, so there is no parameter for one — and the test asserts the
 * arity, because the failure mode is somebody adding a second argument later.
 */
export function railIsCollapsed(contentWidth: number): boolean {
    return contentWidth < RAIL_COLLAPSE_AT;
}

export type ApprovalPlacement = 'chat' | 'stream';

/**
 * WHERE a parked approval is actionable — and it is exactly one place.
 *
 * One fact can appear three times: a Deck row, a Stream row, and possibly a chat row. The rule
 * that keeps that from becoming three sets of buttons for one decision is simple and absolute:
 *
 * > **The approval renders wherever the composer is.** Everywhere else shows a MARKER.
 *
 * The chat flyout is the only place a human types to an agent — it replaces the Agent view's
 * composer — so an open chat on this agent takes the approval with it, and the Stream keeps a
 * marker saying one is parked. Pinned or overlaid makes no difference: what matters is where
 * the person is typing.
 *
 * Two live sets of buttons for one decision is not a cosmetic problem. Answering in one leaves
 * the other showing a question that has been resolved, and the reader cannot tell whether
 * their answer landed.
 */
export function approvalPlacement(agentId: string, chatSubject: string | null): ApprovalPlacement {
    return chatSubject === agentId ? 'chat' : 'stream';
}

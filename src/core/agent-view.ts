import type { Fidelity } from './dashboard-view.js';
import { observedState, type TakeOverProbe } from './observed.js';
import type { AgentTab } from './route.js';
import type { LiveSession } from './roster.js';
import { editLineCounts, type TimedEvent } from './stream-view.js';

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
    /** Shells after Changes (the owner): what it has running in the background, read from its own ledger. */
    /** Settings last (Tynn #800): the agent's persona, mode, budget and skills, out of the rail. */
    declared: ['stream', 'files', 'changes', 'shells', 'settings'],
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

/** `14:31`, in the viewer's locale — a clock time for a stamp. */
function hhmm(at: number): string {
    return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** `40s ago` / `5m ago` / `2h ago`. */
function ago(from: number, now: number): string {
    const s = Math.max(0, Math.floor((now - from) / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
}

/** The time LEFT until `at`: `m:ss`, or `h:mm:ss` from an hour; never negative (Tynn #794). */
export function limitCountdown(at: number, now: number): string {
    const total = Math.max(0, Math.floor((at - now) / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
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
 *  - `Turn 15 · parked · waiting on you 0:42` — the wait since Genie parked it (its own clock), none without the stamp;
 *  - `Broken · <reason> 14:31` — when Genie recorded the failure, none without the stamp; `Idle` after turns; `No turns yet` for a session that has not taken one; `Not started` for an
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
    if (session.pendingApproval !== null) {
        // The wait is measured from Genie's own stamp — the moment the request parked here — not guessed from the turn.
        return { word: `Turn ${ctx.turns} · parked · waiting on you`, elapsed: session.parkedAt == null ? null : clock(session.parkedAt, now()), tone: 'warn' };
    }
    // HELD FOR THE PROVIDER'S LIMIT (Tynn #794): until when, and the time left — or that it needs the person, with no
    // timer when no reset is known. Never Broken: the limit is the provider's, and Genie resumes on its own.
    const limit = session.limit;
    if (limit && limit.state === 'paused') return { word: `Paused · rate limit · resumes ${hhmm(limit.resumeAtMs)}`, elapsed: limitCountdown(limit.resumeAtMs, now()), tone: 'warn' };
    if (limit && limit.state === 'retrying') return { word: `Paused · rate limit · next try ${hhmm(limit.nextTryAtMs)}`, elapsed: limitCountdown(limit.nextTryAtMs, now()), tone: 'warn' };
    if (limit && limit.state === 'needs-person') return { word: `Paused · rate limit · needs you${limit.message ? `: ${limit.message}` : ''}`, elapsed: null, tone: 'warn' };
    // SIGNED OUT of its provider (the owner, 2026-10-18): what to do, never Broken — the header's `Log in` fixes it.
    if (session.signedOut) return { word: 'Signed out · log in to continue', elapsed: null, tone: 'warn' };
    if (session.failure !== null) {
        const when = session.failure.at == null ? '' : ` ${hhmm(session.failure.at)}`;
        return { word: `Broken · ${session.failure.reason}${when}`, elapsed: null, tone: 'bad' };
    }

    const running = session.running && session.turnState === 'working';
    if (!running) return { word: ctx.turns === 0 && session.running ? 'No turns yet' : 'Idle', elapsed: null, tone: 'muted' };

    return {
        word: `Turn ${ctx.turns} · running`,
        elapsed: session.startedAt === null ? null : clock(session.startedAt, now()),
        tone: 'ok',
    };
}

/**
 * THE PARKED DIVIDER (the board, amber, at the stream's end): `turn parked · waiting on you 0:42` while a permission
 * request waits — the wait from Genie's own stamp, none without it. `null` when nothing is parked: the divider is
 * state, not a ledger row, so it is drawn by the Stream after the rows and survives every lane filter.
 */
export function parkedDivider(session: LiveSession | null, now: () => number): string | null {
    if (!session || session.pendingApproval === null) return null;
    return session.parkedAt == null ? 'turn parked · waiting on you' : `turn parked · waiting on you ${clock(session.parkedAt, now())}`;
}

/**
 * WHETHER `Stop this turn` IS OFFERED — the Agent view's header and the chat's context line, one rule for both: a turn
 * is running on a session that is up and not broken, and its driver can end a turn with the agent kept
 * (`LiveSession.cancelTurn`). A driver that cannot (or an unknown one) gets no turn Stop: a Stop that killed the agent
 * instead was the bug (the owner, 2026-10-15). Ending the agent is "Stop agent" in its operations menu.
 */
export function turnStopOffered(session: LiveSession | null | undefined): boolean {
    if (!session) return false;
    return session.failure === null && session.running && session.turnState === 'working' && session.cancelTurn === true;
}

export interface HeaderActions {
    /** `Stop this turn` (see `turnStopOffered`): the turn ends, the agent keeps running. Never ends the session. */
    stop: boolean;
    /** Only when broken (the board): the graceful restart that resumes the same thread. */
    restart: boolean;
    /** In the error state: the Take Over window is the terminal. */
    openTerminal: boolean;
    /** While the provider's login is held for its limit (Tynn #794): the person's Resume now. */
    resumeLimit: boolean;
    /** Signed out of its provider: `Log in to <provider>` opens the provider's own login in a window of its own. */
    login: boolean;
    /** A declared agent that is not running, and not broken (broken has its restart): start it. */
    start: boolean;
    takeOver: boolean;
    chat: boolean;
}

/** The board's header actions by state. An observed agent is not managed: nothing to stop or restart. */
export function headerActions(session: LiveSession | null, fidelity: Fidelity): HeaderActions {
    const managed = fidelity === 'declared' && session !== null;
    const broken = managed && session.failure !== null;
    const start = fidelity === 'declared' && !broken && (session === null || !session.running);
    const held = managed && session.limit !== undefined && session.limit.state !== 'open';
    const login = managed && session.signedOut === true;
    return { stop: managed && turnStopOffered(session), restart: broken, openTerminal: broken, resumeLimit: held, login, start, takeOver: true, chat: true };
}

export interface PlanPanel {
    step: number;
    of: number;
    doing: string;
}

/**
 * THE PLAN'S STEPS (the board: ✓ / ◐ / ○, the current one bold) — from the agent's LATEST plan update, each with the
 * status the provider gave it (`completed`, `in_progress`, `pending`, or whatever else it said — kept, not mapped to
 * a guess). An entry Genie cannot read is dropped; a plan with no readable entry is `null`, and the panel keeps its
 * `step/of` line alone. The same entries the host counts into `step/of`, so the two never disagree.
 */
export interface PlanStep {
    content: string;
    status: string;
    current: boolean;
}

export function planSteps(rows: readonly TimedEvent[]): readonly PlanStep[] | null {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
        const event = rows[i]?.event;
        if (event?.kind !== 'plan') continue;
        const steps = event.entries.flatMap((e): PlanStep[] => {
            if (typeof e !== 'object' || e === null) return [];
            const r = e as Record<string, unknown>;
            if (typeof r['content'] !== 'string' || typeof r['status'] !== 'string') return [];
            return [{ content: r['content'], status: r['status'], current: r['status'] === 'in_progress' }];
        });
        return steps.length === 0 ? null : steps;
    }
    return null;
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
/**
 * THE APPROVAL POLICY SENTENCE (`genie-2-dashboard-design.md` §8.3): for a provider whose driver raises no approvals,
 * say so — an empty approvals history otherwise reads as "nothing needed approval" when the truth is "nothing could
 * ask". `null` for a provider that asks, and for one Genie knows nothing about.
 */
export function approvalPolicySentence(name: string, provider: string, raises: boolean | null | undefined): string | null {
    return raises === false ? `${name} proceeds without asking — ${provider} raises no approvals, so its edits are not gated by you.` : null;
}

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

export interface ContextNote {
    text: string;
    tone: 'warn' | 'bad' | 'muted';
}

/** Compaction is expected around here (the board's figure, below the 200k limit). */
export const COMPACTION_EXPECTED_AT = 190_000;

/**
 * The note under the context bar (the board): `Compaction expected near 190k. Consider a handoff before step 5.`
 * while the context is high; `Compacted at 14:20 from 189k → 46k` after a compaction; on a broken session, `Last
 * reported at 14:21. Nothing since the stream closed.` — each from facts on the wire (the usage and compaction rows
 * carry their times). `null` when nothing applies: absent, not a filler sentence.
 */
/**
 * THE PROCESS-ENDED BLOCK (the board's right column, error state): what the engine said when it died — the reason
 * the session layer recorded, the provider's recent stderr as it wrote it — and the last tool call, which has no
 * result. Only facts Genie received: no RSS, no exit code it was not given. `null` unless the session FAILED; a
 * stopped or idle session ended on purpose and gets no block.
 */
/**
 * THE PERSONA BLOCK'S CONTENT (the board's empty state): the AGENT.md's first lines as written — clipped, never
 * summarised — and whether more follow. `null` for no text: the path alone is still a fact, an empty box is not.
 */
export const PERSONA_LINES = 12;

export function personaView(text: string | null | undefined): { lines: readonly string[]; truncated: boolean } | null {
    if (typeof text !== 'string' || text.trim() === '') return null;
    const all = text.replace(/\r\n?/g, '\n').split('\n');
    while (all.length > 0 && all[all.length - 1]!.trim() === '') all.pop();
    return { lines: all.slice(0, PERSONA_LINES), truncated: all.length > PERSONA_LINES };
}

/**
 * THE TAB NOTE, right of the tabs (the board): on Files / Changes, where they open — naming the agent; on the
 * Stream, a measurement — `61 events in the last 80s` while rows arrive (the last two minutes), `Last event received
 * 14:31:02` once they stopped. Nothing when no row has a time: a sentence about timing with no times is a guess.
 */
export const LIVE_WINDOW_MS = 120_000;

export function tabNote(rows: readonly TimedEvent[], tab: string, agentName: string, now: number): { kind: 'files' | 'live' | 'last'; text: string } | null {
    if (tab === 'files' || tab === 'changes') return { kind: 'files', text: `Files and Changes open the workspace file panel, filtered to ${agentName}` };
    if (tab !== 'stream') return null;
    const timed = rows.map((r) => r.at).filter((t): t is number => t !== null);
    if (timed.length === 0) return null;
    const recent = timed.filter((t) => now - t <= LIVE_WINDOW_MS);
    if (recent.length > 0) {
        const span = Math.max(1, Math.round((now - Math.min(...recent)) / 1000));
        return { kind: 'live', text: `${recent.length} event${recent.length === 1 ? '' : 's'} in the last ${span}s` };
    }
    const last = new Date(Math.max(...timed)).toLocaleTimeString(undefined, { hour12: false });
    return { kind: 'last', text: `Last event received ${last}` };
}

/**
 * THE DIFF HEADER (the board's Inspector): `+42 −8 · 14:08:31 · edit 3 of 3` — the counts from the edit's own
 * before-and-after (none for a Write), the row's time, its place among the session's edits. `null` unless the selected
 * row is an edit.
 */
export interface DiffHeader {
    plus: number | null;
    minus: number | null;
    at: number | null;
    index: number;
    total: number;
}

export function diffHeader(rows: readonly TimedEvent[], selectedId: string | null): DiffHeader | null {
    if (selectedId === null) return null;
    const edits = rows.filter((r) => r.event.kind === 'tool' && r.event.toolKind === 'edit');
    const index = edits.findIndex((r) => r.id === selectedId);
    if (index < 0) return null;
    const row = edits[index]!;
    const counts = row.event.kind === 'tool' ? editLineCounts(row.event.rawInput) : null;
    return { plus: counts?.plus ?? null, minus: counts?.minus ?? null, at: row.at, index: index + 1, total: edits.length };
}

export interface ProcessEnded {
    reason: string;
    /** `Bash  php artisan test` — the tool and its title, or the tool alone; `null` when no tool was ever called. */
    lastTool: string | null;
    /** The engine's recent output, oldest first, joined; empty when it said nothing. */
    log: string;
    /** `exit 1` / `signal SIGKILL`, as node reported it; `null` when the process has not exited or reported neither. */
    exit: string | null;
}

export function processEnded(session: LiveSession | null, rows: readonly TimedEvent[], log: readonly string[]): ProcessEnded | null {
    if (!session || session.turnState !== 'failed') return null;
    const tool = [...rows].reverse().find((r) => r.event.kind === 'tool')?.event;
    const lastTool = tool && tool.kind === 'tool' ? [tool.name ?? '(tool not named)', tool.title].filter((s): s is string => typeof s === 'string' && s.length > 0).join('  ') : null;
    const e = session.failure?.exit ?? null;
    const exit = e === null ? null : e.signal !== null ? `signal ${e.signal}` : e.code !== null ? `exit ${e.code}` : null;
    return { reason: session.failure?.reason ?? 'the session ended without a reason Genie received', lastTool, log: log.join('\n'), exit };
}

export function contextNote(session: LiveSession | null, rows: readonly TimedEvent[], pillTone: 'ok' | 'warn' | 'bad' | 'muted'): ContextNote | null {
    if (!session) return null;
    const clockOf = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
    if (pillTone === 'bad' || session.failure !== null) {
        const lastUsage = [...rows].reverse().find((r) => r.event.kind === 'usage' && r.at !== null);
        return lastUsage && lastUsage.at !== null
            ? { text: `Last reported at ${clockOf(lastUsage.at)}. Nothing since the stream closed.`, tone: 'bad' }
            : { text: 'Nothing was reported before the stream closed.', tone: 'bad' };
    }
    if (session.contextUsed !== null && session.contextUsed >= CONTEXT_HIGH_AT) {
        const next = session.plan ? ` Consider a handoff before step ${session.plan.step + 1}.` : '';
        return { text: `Compaction expected near ${Math.round(COMPACTION_EXPECTED_AT / 1000)}k.${next}`, tone: 'warn' };
    }
    const compaction = [...rows].reverse().find((r) => r.event.kind === 'divider' && r.event.variant === 'compaction');
    if (compaction && compaction.event.kind === 'divider' && compaction.at !== null && compaction.event.before !== null && compaction.event.after !== null) {
        return { text: `Compacted at ${clockOf(compaction.at)} from ${Math.round(compaction.event.before / 1000)}k → ${Math.round(compaction.event.after / 1000)}k`, tone: 'muted' };
    }
    return null;
}

/** The board's context warning threshold — the same 160k the Dashboard's context cell appears at. */
export const CONTEXT_HIGH_AT = 160_000;

/**
 * THE RIGHT COLUMN COLLAPSES BELOW ~1100px OF CONTENT WIDTH (§4.2) into a 32px summary strip — `3/6 · 89% ctx · ⚠`
 * — expandable as a popover. **Width-triggered, never state-triggered:** a rail that collapsed because a number went
 * missing would move the conversation sideways mid-turn. An unmeasured width (first paint, server-side) is the full
 * column, so nothing jumps on arrival.
 */
export const RAIL_COLLAPSE_BELOW = 1100;

export type RailMode = 'full' | 'strip';

export function railMode(width: number | null): RailMode {
    return width !== null && width < RAIL_COLLAPSE_BELOW ? 'strip' : 'full';
}

/** The strip's text: the plan, the context pressure, a warning mark — only the parts that exist; `null` for none. */
export function railSummary(session: LiveSession | null, noteTone: 'ok' | 'warn' | 'bad' | 'muted' | null): string | null {
    if (!session) return null;
    const parts: string[] = [];
    if (session.plan) parts.push(`${session.plan.step}/${session.plan.of}`);
    if (session.contextUsed !== null && session.contextSize !== null && session.contextSize > 0) parts.push(`${Math.round((session.contextUsed / session.contextSize) * 100)}% ctx`);
    if (parts.length === 0) return null;
    if (noteTone === 'warn' || noteTone === 'bad') parts.push('⚠');
    return parts.join(' · ');
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


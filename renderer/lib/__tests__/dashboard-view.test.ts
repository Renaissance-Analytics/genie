import { describe, expect, it } from 'vitest';
import { emptyAgentSession, type AgentSession, type ToolCall } from '../../../main/agentsession/model';
import {
    CONTEXT_SHOW_FROM_K,
    dashboardView,
    DELIVERY_ICON,
    STATE_ORDER,
    type DashboardWorkspace,
} from '../dashboard-view';

/**
 * THE WORKFLOW DASHBOARD's projection — `genie://dashboard?group=workspace`.
 *
 * Every rule here comes from the owner's spec board (`Genie v2 Spec Board.dc.html` and
 * `Dashboard.dc.html` in the claude.ai/design project), not from my own reading of what a
 * dashboard should be. Where the board and the earlier agent-written design disagreed, the
 * board wins — and it disagreed on two things worth naming:
 *
 *  - **Sort order.** The agent design sorted by delivery recency and argued explicitly against
 *    putting the demanding rows first. The board sorts `waiting → broken → working → idle`.
 *  - **The collaborator reveal.** The agent design used a popover list; the board keeps peers
 *    IN PLACE in the table, draws lanes in the left gutter, and dims the rest.
 *
 * Pure, so the decisions are testable without rendering. The component is the render only.
 */

const NOW = 1_000_000;

function session(over: Partial<AgentSession> & { agentId: string }): AgentSession {
    const base = emptyAgentSession(
        {
            agentId: over.agentId,
            specId: `spec-${over.agentId}`,
            provider: 'claude',
            name: over.agentId,
            cwd: '/w',
            workspaceId: 'tynn',
        },
        NOW,
    );
    return { ...base, ...over, session: { ...base.session, ...(over.session ?? {}) } };
}

const tool = (over: Partial<ToolCall> = {}): ToolCall => ({
    id: 't1',
    name: 'Write',
    status: 'success',
    kind: 'edit',
    rawInput: { file_path: '/w/main/acp/ipc.ts' },
    result: null,
    at: NOW - 60_000,
    ...over,
});

const WS: DashboardWorkspace[] = [{ id: 'tynn', name: 'tynn', path: '~/work/tynn.agi' }];

describe('the status vocabulary is different for what Genie can and cannot see', () => {
    it('says Working / Idle for a declared agent', () => {
        const v = dashboardView(
            [
                session({ agentId: 'a', turn: { state: 'tool', since: NOW - 60_000 }, plan: [] }),
                session({ agentId: 'b', turn: { state: 'idle', since: NOW - 60_000 }, plan: [] }),
            ],
            { now: NOW, workspaces: WS },
        );
        const rows = v.groups[0]!.rows;
        expect(rows.find((r) => r.name === 'a')!.statusWord).toBe('Working');
        expect(rows.find((r) => r.name === 'b')!.statusWord).toBe('Idle');
    });

    it('says Active / Quiet for an OBSERVED agent, because it is a measurement not a claim', () => {
        /**
         * The board's wording, and it is the §6.3 rule in two words: Genie is watching a pty
         * and inferring motion. "Working" would state the agent's own position, which only a
         * declaring agent can do. An Observed agent is one with no declared fidelity — no
         * plan, no usage, no composer.
         */
        const v = dashboardView(
            [
                session({ agentId: 'obs', turn: { state: 'tool', since: NOW - 60_000 } }),
                session({ agentId: 'obs2', turn: { state: 'idle', since: NOW - 60_000 } }),
            ],
            { now: NOW, workspaces: WS },
        );
        const rows = v.groups[0]!.rows;
        expect(rows.find((r) => r.name === 'obs')!.statusWord).toBe('Active');
        expect(rows.find((r) => r.name === 'obs2')!.statusWord).toBe('Quiet');
        expect(rows.find((r) => r.name === 'obs')!.fidelity).toBe('observed');
    });

    it('carries the question itself as the detail of a waiting row', () => {
        // Not "1 question" — the question. The board shows `Allow php artisan migrate --force?`
        // in the status cell, which is what makes the row readable without opening anything.
        const v = dashboardView(
            [
                session({
                    agentId: 'wren',
                    turn: { state: 'awaiting-approval', since: NOW - 120_000 },
                    approvals: [{ id: 'ap1', name: 'Allow php artisan migrate --force?', args: {} }],
                    plan: [],
                }),
            ],
            { now: NOW, workspaces: WS },
        );
        const row = v.groups[0]!.rows[0]!;
        expect(row.statusWord).toBe('Waiting on you');
        expect(row.statusDetail).toBe('Allow php artisan migrate --force?');
    });

    it('carries the reason on a broken row, and DROPS its step and target', () => {
        /**
         * The board is explicit: *"A broken row replaces its target with the route to fix it."*
         * A stale target beside a dead agent reads as current work, which is the one thing the
         * cell must not imply.
         */
        const v = dashboardView(
            [
                session({
                    agentId: 'tern',
                    error: 'Provider sign-in expired',
                    plan: [{ id: 'p1', title: 'Migrate sessions table', status: 'in-progress' }],
                    turn: { state: 'tool', since: NOW - 60_000 },
                }),
            ],
            { now: NOW, workspaces: WS },
        );
        const row = v.groups[0]!.rows[0]!;
        expect(row.statusWord).toBe('Broken');
        expect(row.statusDetail).toBe('Provider sign-in expired');
        expect(row.target).toBeNull();
        expect(row.step).toBeNull();
    });
});

describe('ordering', () => {
    it('puts the rows that need a human first — waiting, broken, working, idle', () => {
        // The board's order, and the opposite of `deck-view`'s… no: the SAME first element and a
        // different tail. The Deck sorts blocked-first because it is a queue; the board sorts
        // this way because a human scanning for trouble reads top-down.
        expect(STATE_ORDER).toEqual(['waiting', 'broken', 'working', 'idle', 'remote']);

        const v = dashboardView(
            [
                session({ agentId: 'idle1', turn: { state: 'idle', since: NOW }, plan: [] }),
                session({ agentId: 'work1', turn: { state: 'tool', since: NOW }, plan: [] }),
                session({ agentId: 'broke1', error: 'boom', turn: { state: 'idle', since: NOW }, plan: [] }),
                session({
                    agentId: 'wait1',
                    turn: { state: 'awaiting-input', since: NOW },
                    plan: [],
                }),
            ],
            { now: NOW, workspaces: WS },
        );
        expect(v.groups[0]!.rows.map((r) => r.name)).toEqual(['wait1', 'broke1', 'work1', 'idle1']);
    });

    it('keeps a stable order inside one state rather than reshuffling on every tick', () => {
        // A board that reorders equal rows between renders is unreadable at twenty agents. Ties
        // break on name, which does not change.
        const v = dashboardView(
            [
                session({ agentId: 'zeta', turn: { state: 'tool', since: NOW }, plan: [] }),
                session({ agentId: 'alpha', turn: { state: 'tool', since: NOW }, plan: [] }),
            ],
            { now: NOW, workspaces: WS },
        );
        expect(v.groups[0]!.rows.map((r) => r.name)).toEqual(['alpha', 'zeta']);
    });
});

describe('context is shown only when it is about to matter', () => {
    it(`stays absent below ${CONTEXT_SHOW_FROM_K}k, because a healthy number is noise`, () => {
        /**
         * The board: *"Context shows on the Dashboard only at 80% and above."* Section 5 of the
         * brief is the reason — 178k/200k is a reason to act NOW, and a column of comfortable
         * numbers trains people to stop reading the one that matters.
         */
        const v = dashboardView(
            [
                session({
                    agentId: 'fine',
                    usage: { contextUsed: 40_000, contextMax: 200_000, costUsd: null },
                    plan: [],
                }),
            ],
            { now: NOW, workspaces: WS },
        );
        expect(v.groups[0]!.rows[0]!.context).toBeNull();
    });

    it('appears amber from 160k and red from 180k', () => {
        const v = dashboardView(
            [
                session({
                    agentId: 'warm',
                    usage: { contextUsed: 164_000, contextMax: 200_000, costUsd: null },
                    plan: [],
                }),
                session({
                    agentId: 'hot',
                    usage: { contextUsed: 182_000, contextMax: 200_000, costUsd: null },
                    plan: [],
                }),
            ],
            { now: NOW, workspaces: WS },
        );
        const warm = v.groups[0]!.rows.find((r) => r.name === 'warm')!.context!;
        const hot = v.groups[0]!.rows.find((r) => r.name === 'hot')!.context!;
        expect(warm.label).toBe('164k');
        expect(warm.level).toBe('warn');
        expect(hot.label).toBe('182k');
        expect(hot.level).toBe('critical');
    });

    it('is absent — not zero — when the session cannot report it', () => {
        // §6.1. `usage: null` is "cannot see", and the board's empty state says the cells are
        // "blank, not zero".
        const v = dashboardView([session({ agentId: 'blind', usage: null, plan: [] })], {
            now: NOW,
            workspaces: WS,
        });
        expect(v.groups[0]!.rows[0]!.context).toBeNull();
    });

    it('never shows a context cell for an OBSERVED agent at all', () => {
        /**
         * The board: Observed agents *"have no comms or context cells"*. Absence of the cell,
         * not an empty one — §6.3 rather than §6.1.
         *
         * NOTE ON THE FIXTURE, which is the interesting part. My first draft gave this agent a
         * 190k `usage` and asserted it was still Observed. It is not: `usage` is one of
         * `DECLARED_ONLY_FIELDS`, so an agent reporting a context window has BY DEFINITION
         * declared itself. "An Observed agent with a context reading" is unrepresentable, and
         * that is a stronger guarantee than the assertion I was reaching for — the pairing is
         * enforced by the model rather than by this view remembering to suppress it.
         *
         * So the fixture is a genuinely observed session: no composer, no plan, no usage.
         */
        const v = dashboardView([session({ agentId: 'obs' })], { now: NOW, workspaces: WS });
        const row = v.groups[0]!.rows[0]!;
        expect(row.fidelity).toBe('observed');
        expect(row.showsContextCell).toBe(false);
        expect(row.context).toBeNull();
    });

    it('draws the cell for a declared agent even when the figure is below the threshold', () => {
        // The positive control for the pair above: `showsContextCell` must not simply track
        // `context !== null`, or the column would vanish for a healthy agent and the two rules
        // (§6.1 empty vs §6.3 absent) would be the same rule.
        const v = dashboardView(
            [
                session({
                    agentId: 'fine',
                    plan: [],
                    usage: { contextUsed: 20_000, contextMax: 200_000, costUsd: null },
                }),
            ],
            { now: NOW, workspaces: WS },
        );
        const row = v.groups[0]!.rows[0]!;
        expect(row.showsContextCell).toBe(true);
        expect(row.context).toBeNull();
    });
});

describe('current target comes from the agent’s own plan', () => {
    it('is the in-progress step, with its position', () => {
        const v = dashboardView(
            [
                session({
                    agentId: 'atlas',
                    turn: { state: 'tool', since: NOW },
                    plan: [
                        { id: '1', title: 'read the spec', status: 'done' },
                        { id: '2', title: 'write the test', status: 'done' },
                        { id: '3', title: 'Passkey enrolment endpoint', status: 'in-progress' },
                        { id: '4', title: 'wire the route', status: 'pending' },
                    ],
                }),
            ],
            { now: NOW, workspaces: WS },
        );
        const row = v.groups[0]!.rows[0]!;
        expect(row.target).toBe('Passkey enrolment endpoint');
        expect(row.step).toBe('3/4');
    });

    it('is absent when the plan is empty, and absent when there is no plan at all', () => {
        // `[]` is "the agent has no plan right now"; `null` is "cannot see one". Both render as
        // nothing here, but they are different facts and the model keeps them apart.
        const none = dashboardView([session({ agentId: 'a', plan: [] })], { now: NOW, workspaces: WS });
        const blind = dashboardView([session({ agentId: 'b', plan: null })], { now: NOW, workspaces: WS });
        expect(none.groups[0]!.rows[0]!.target).toBeNull();
        expect(blind.groups[0]!.rows[0]!.target).toBeNull();
    });
});

describe('latest delivery is the last thing PRODUCED', () => {
    it('names the file an edit wrote, which is what genie#843 made possible', () => {
        const v = dashboardView(
            [session({ agentId: 'atlas', plan: [], tools: [tool()] })],
            { now: NOW, workspaces: WS },
        );
        const del = v.groups[0]!.rows[0]!.delivery!;
        expect(del.kind).toBe('file');
        expect(del.main).toBe('ipc.ts');
        expect(del.mono).toBe(true);
        expect(DELIVERY_ICON[del.kind]).toBe('file-code');
    });

    it('ignores a tool call that has not finished — a delivery is a RESULT', () => {
        const v = dashboardView(
            [session({ agentId: 'a', plan: [], tools: [tool({ status: 'pending' })] })],
            { now: NOW, workspaces: WS },
        );
        expect(v.groups[0]!.rows[0]!.delivery).toBeNull();
    });

    it('ignores a READ — looking at a file is not producing one', () => {
        // The distinction the board's wording rests on: "the last thing it actually produced".
        const v = dashboardView(
            [session({ agentId: 'a', plan: [], tools: [tool({ kind: 'read', name: 'Read' })] })],
            { now: NOW, workspaces: WS },
        );
        expect(v.groups[0]!.rows[0]!.delivery).toBeNull();
    });

    it('takes the most recent of several, by the stamp rather than by position', () => {
        // `at` exists for this. Array order is arrival order, and two calls can finish out of
        // order once they run concurrently.
        const v = dashboardView(
            [
                session({
                    agentId: 'a',
                    plan: [],
                    tools: [
                        tool({ id: 'old', at: NOW - 600_000, rawInput: { file_path: '/w/old.ts' } }),
                        tool({ id: 'new', at: NOW - 1_000, rawInput: { file_path: '/w/new.ts' } }),
                        tool({ id: 'mid', at: NOW - 300_000, rawInput: { file_path: '/w/mid.ts' } }),
                    ],
                }),
            ],
            { now: NOW, workspaces: WS },
        );
        expect(v.groups[0]!.rows[0]!.delivery!.main).toBe('new.ts');
    });

    it('keeps a WAITING agent’s last delivery rather than replacing it with the question', () => {
        /**
         * The board, twice: *"A waiting agent keeps its last delivery and shows its question as
         * status"*, and a question "is not a delivery". Overwriting it would destroy the one
         * piece of history this surface exists to preserve, and would make the board demand
         * something — which is the Deck's job.
         */
        const v = dashboardView(
            [
                session({
                    agentId: 'wren',
                    turn: { state: 'awaiting-approval', since: NOW },
                    approvals: [{ id: 'x', name: 'Allow Edit?', args: {} }],
                    plan: [],
                    tools: [tool()],
                }),
            ],
            { now: NOW, workspaces: WS },
        );
        const row = v.groups[0]!.rows[0]!;
        expect(row.statusWord).toBe('Waiting on you');
        expect(row.delivery!.main).toBe('ipc.ts');
    });

    it('is absent for an agent that has produced nothing — blank, not a dash', () => {
        const v = dashboardView([session({ agentId: 'new', plan: [], tools: [] })], {
            now: NOW,
            workspaces: WS,
        });
        expect(v.groups[0]!.rows[0]!.delivery).toBeNull();
    });
});

describe('grouping and the header summary', () => {
    it('groups by workspace and counts what needs attention', () => {
        const v = dashboardView(
            [
                session({ agentId: 'a', turn: { state: 'tool', since: NOW }, plan: [] }),
                session({ agentId: 'b', turn: { state: 'awaiting-input', since: NOW }, plan: [] }),
                session({ agentId: 'c', error: 'boom', plan: [] }),
            ],
            { now: NOW, workspaces: WS },
        );
        expect(v.groups[0]!.summary).toBe('3 agents · 1 waiting · 1 broken');
        expect(v.figures.waiting).toBe(1);
        expect(v.figures.broken).toBe(1);
    });

    it('says “1 agent”, not “1 agents”', () => {
        const v = dashboardView([session({ agentId: 'only', plan: [] })], { now: NOW, workspaces: WS });
        expect(v.groups[0]!.summary).toBe('1 agent');
    });

    it('offers Add agent for a workspace with none, rather than hiding it', () => {
        // The board's empty state: *"Workspaces with no agents offer Add agent."* A workspace
        // that vanishes when its agents stop is a workspace you cannot start work in.
        const v = dashboardView([], {
            now: NOW,
            workspaces: [{ id: 'tynn', name: 'tynn', path: '~/work/tynn.agi' }],
        });
        expect(v.groups).toHaveLength(1);
        expect(v.groups[0]!.rows).toEqual([]);
        expect(v.groups[0]!.isEmpty).toBe(true);
    });

    it('puts an agent belonging to no workspace in its own group, first', () => {
        // `genie`, the OS agent, which the board shows above the workspaces with the path
        // "default agent · not in a workspace".
        const v = dashboardView(
            [
                session({ agentId: 'atlas', plan: [] }),
                session({ agentId: 'genie', session: { workspaceId: null } as AgentSession['session'], plan: [] }),
            ],
            { now: NOW, workspaces: WS },
        );
        expect(v.groups[0]!.rows.map((r) => r.name)).toEqual(['genie']);
        expect(v.groups[0]!.isWorkspace).toBe(false);
        expect(v.groups[1]!.name).toBe('tynn');
    });
});

import { describe, expect, it } from 'vitest';
import type { LiveSession } from '../src/core/roster.js';
import {
    RAIL_COLLAPSE_AT,
    approvalPlacement,
    budgetFor,
    planFor,
    railIsCollapsed,
    statePill,
    tabsFor,
} from '../src/core/agent-view.js';

const session = (over: Partial<LiveSession> = {}): LiveSession => ({
    running: true, turnState: 'working', startedAt: Date.now() - 14_000,
    pendingApproval: null, failure: null, contextUsed: null, contextSize: null,
    lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null, model: null,
    ...over,
});

describe('tabs by fidelity — ABSENCE of a tab, not a disabled tab', () => {
    it('gives a declared agent Stream, Files and Changes, with Stream first', () => {
        expect(tabsFor('declared')).toEqual(['stream', 'files', 'changes']);
    });

    it('gives an observed agent Activity first (the board), then Terminal, and NO Stream at all', () => {
        // Genie sees bytes from that TUI and nothing else. A Stream tab there would be a tab
        // that cannot populate — and *"a disabled control is an accusation; a different shape
        // is a fact."*
        expect(tabsFor('observed')).toEqual(['activity', 'terminal', 'files', 'changes']);
        expect(tabsFor('observed')).not.toContain('stream');
    });

    it('ALWAYS includes Stream for a declared agent — counted, not spot-checked', () => {
        /**
         * §0.4, which cost three releases. `sessionFidelity()` returned `observed` for every
         * agent, so every one rendered `Activity | Files | Changes` and a finished Conversation
         * UI was unreachable. One condition hid an entire feature.
         *
         * Stream is never gated on anything beyond fidelity. With no events it shows an empty
         * state and the composer; it does not hide.
         */
        const fidelities = ['declared', 'observed', 'remote'] as const;
        const withStream = fidelities.filter((f) => tabsFor(f).includes('stream'));
        expect(withStream).toEqual(['declared']);

        // POSITIVE CONTROL: every fidelity gets SOME tabs, so the filter above is a reading
        // and not an empty set three times over.
        expect(fidelities.filter((f) => tabsFor(f).length === 0)).toEqual([]);
    });

    it('gives a remote agent the two tabs it can fill, and no composer-bearing one', () => {
        // Presence only. Files and Changes come from git, which Genie can read without the
        // agent's cooperation; everything else would be a claim about an unreachable machine.
        expect(tabsFor('remote')).toEqual(['files', 'changes']);
    });
});

describe('the state pill', () => {
    it('reads the running turn, in the board’s words, with an elapsed clock', () => {
        const now = Date.now();
        expect(statePill(session({ startedAt: now - 14_000 }), () => now, { turns: 14 })).toEqual({
            word: 'Turn 14 · running', elapsed: '0:14', tone: 'ok',
        });
    });

    it('reads the parked turn when it waits on you', () => {
        const pill = statePill(session({ turnState: 'idle', pendingApproval: { question: 'Allow migrate --force?', options: [{ id: 'allow', label: 'Allow', tone: 'ok' }] } }), () => Date.now(), { turns: 15 });
        expect(pill).toMatchObject({ word: 'Turn 15 · parked · waiting on you', tone: 'warn' });
    });

    it('reads Idle with NO clock when nothing is running', () => {
        // An elapsed timer on an idle agent counts up forever and reads as work in progress.
        const pill = statePill(session({ running: false, turnState: 'idle', startedAt: Date.now() - 600_000 }), () => Date.now(), { turns: 3 });
        expect(pill).toMatchObject({ word: 'Idle', elapsed: null });
    });

    it('does not claim a clock it cannot measure', () => {
        expect(statePill(session({ startedAt: null }), () => Date.now()).elapsed).toBeNull();
    });

    it('rolls past a minute correctly', () => {
        const now = Date.now();
        expect(statePill(session({ startedAt: now - 94_000 }), () => now).elapsed).toBe('1:34');
        expect(statePill(session({ startedAt: now - 3_600_000 }), () => now).elapsed).toBe('60:00');
    });
});

describe('the Plan panel — absent, not empty, before the first turn', () => {
    it('reports the steps the agent sent', () => {
        expect(planFor(session({ plan: { step: 3, of: 7, doing: 'Passkey enrolment endpoint' } }))).toEqual({
            step: 3, of: 7, doing: 'Passkey enrolment endpoint',
        });
    });

    it('is NULL when the agent has not reported a plan', () => {
        // *"Plan and context are not known yet, so they are ABSENT, not empty."* An empty plan
        // panel reads as an agent working without a plan; the truth is that it has not said.
        expect(planFor(session({ plan: null }))).toBeNull();
        expect(planFor(null)).toBeNull();
    });
});

describe('the Budget panel', () => {
    it('reports context and cost when both were reported', () => {
        expect(budgetFor(session({ contextUsed: 38_000, contextSize: 200_000 }), 0.91, 11)).toEqual({
            used: 38_000, size: 200_000, pct: 19, cost: 0.91, turns: 11,
        });
    });

    it('omits the COST ROW ENTIRELY when the provider reports none', () => {
        // codex reports no cost. Not a zero, not a dash — there is no Cost row at all. A `$0.00`
        // claims the work was free, and a dash reads as zero.
        const budget = budgetFor(session({ contextUsed: 38_000, contextSize: 200_000 }), null, 11);
        expect(budget?.cost).toBeNull();
    });

    it('is absent when context has not been reported, even if turns have', () => {
        // The panel's subject is the budget. With no context figure there is nothing to draw a
        // bar from, and a bar at 0% reads as an agent that has used nothing.
        expect(budgetFor(session({ contextUsed: null, contextSize: 200_000 }), 0.91, 11)).toBeNull();
    });

    it('is absent before the first turn', () => {
        expect(budgetFor(null, null, 0)).toBeNull();
    });
});

describe('the right rail collapses on WIDTH, never on state', () => {
    it('collapses below 1100px of content width and not above', () => {
        /**
         * Width-triggered, and that distinction is the whole rule: a rail that collapsed
         * because a number went missing would move the conversation sideways mid-turn, while
         * the reader is reading it.
         */
        expect(RAIL_COLLAPSE_AT).toBe(1100);
        expect(railIsCollapsed(1099)).toBe(true);
        expect(railIsCollapsed(1100)).toBe(false);
        expect(railIsCollapsed(1440)).toBe(false);
    });

    it('takes only a width — there is no state it could collapse for', () => {
        // Asserted on the SIGNATURE, because the failure mode is someone adding a second
        // argument later. A one-parameter function cannot collapse for a missing plan.
        expect(railIsCollapsed.length).toBe(1);
    });
});

describe('where an approval is actionable — exactly one place', () => {
    it('puts it in CHAT when chat is open on that agent, and in the stream otherwise', () => {
        /**
         * *"The approval renders wherever the composer is."* The chat flyout is the only place
         * a human types to an agent, so an open chat on this agent takes the approval with it
         * and the Stream keeps a marker.
         */
        expect(approvalPlacement('kai', 'kai')).toBe('chat');
        expect(approvalPlacement('kai', null)).toBe('stream');
        // Chat open on a DIFFERENT agent does not move this agent's approval.
        expect(approvalPlacement('kai', 'wren')).toBe('stream');
    });

    it('can never return both — asserted over every combination', () => {
        /**
         * Two live sets of buttons for one decision is not cosmetic: answering in one leaves
         * the other showing a resolved question, and the reader cannot tell whether their
         * answer landed.
         *
         * A single return value makes that unrepresentable, and this counts it rather than
         * trusting the type: every combination yields exactly one placement, and both
         * placements are reachable.
         */
        const combos: [string, string | null][] = [
            ['kai', 'kai'], ['kai', null], ['kai', 'wren'], ['genie', 'genie'], ['genie', null],
        ];
        const results = combos.map(([agent, chat]) => approvalPlacement(agent, chat));

        expect(results.filter((r) => r !== 'chat' && r !== 'stream')).toEqual([]);
        // POSITIVE CONTROL: both are reachable, so the function is not a constant.
        expect(new Set(results)).toEqual(new Set(['chat', 'stream']));
    });
});

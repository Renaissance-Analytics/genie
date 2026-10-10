import { describe, expect, it } from 'vitest';
import {
    CONTEXT_DANGER_AT,
    CONTEXT_WARN_AT,
    commsOf,
    contextOf,
    groupByWorkspace,
    statusOf,
    summaryChips,
    targetOf,
    type AgentRow,
} from '../src/core/dashboard-view.js';

function row(over: Partial<AgentRow> = {}): AgentRow {
    return {
        id: 'a1', name: 'atlas', provider: 'claude', workspaceId: 'tynn',
        fidelity: 'declared', state: 'working', duration: '12m',
        ask: null, reason: null, fixes: [], step: '4/7', target: 'Passkey enrolment endpoint',
        activity: null, delivery: null, collaborators: 4, commsLive: true,
        contextUsed: null, contextSize: 200_000,
        ...over,
    };
}

describe('sort order — the board overruled the designer here', () => {
    it('orders waiting → broken → working → idle → remote', () => {
        /**
         * A commissioned design sorted by delivery recency and argued explicitly AGAINST
         * demanding rows first. The board overruled it, and the reasoning is sound: a waiting
         * agent has STOPPED, and that is the only state where the human is the bottleneck.
         */
        const rows = [
            row({ id: 'i', state: 'idle' }),
            row({ id: 'r', state: 'remote', fidelity: 'remote' }),
            row({ id: 'w', state: 'working' }),
            row({ id: 'b', state: 'broken' }),
            row({ id: 'q', state: 'waiting' }),
        ];

        const [group] = groupByWorkspace(rows, ['tynn']);
        expect(group?.rows.map((r) => r.id)).toEqual(['q', 'b', 'w', 'i', 'r']);
    });

    it('summarises a group without ever saying zero', () => {
        const [group] = groupByWorkspace(
            [row({ id: '1' }), row({ id: '2', state: 'waiting' })],
            ['tynn'],
        );

        // "2 agents · 1 waiting" — and NO "0 broken". A clause that is zero is omitted, not
        // rendered; a strip of zeroes trains people to stop reading it.
        expect(group?.summary).toBe('2 agents · 1 waiting');
        expect(group?.summary).not.toContain('0');
    });

    it('marks an empty workspace as empty so it can offer Add agent', () => {
        const [group] = groupByWorkspace([], ['fancy']);
        expect(group?.empty).toBe(true);
        expect(group?.summary).toBe('');
    });
});

describe('status vocabulary — the grammar carries the epistemology', () => {
    it('says Working/Idle for a declared agent and Active/Quiet for an observed one', () => {
        // `Working` is a CLAIM about what an agent is doing, which Genie only knows because
        // the agent said so. For a TUI it can see bytes and nothing else, so `Active`.
        expect(statusOf(row({ state: 'working' })).word).toBe('Working');
        expect(statusOf(row({ state: 'idle' })).word).toBe('Idle');
        expect(statusOf(row({ state: 'working', fidelity: 'observed' })).word).toBe('Active');
        expect(statusOf(row({ state: 'idle', fidelity: 'observed' })).word).toBe('Quiet');
    });

    it('puts the QUESTION in the detail when an agent is waiting', () => {
        // The question is the status. Its last delivery stays in the delivery column — a
        // waiting agent keeps what it produced.
        const s = statusOf(row({ state: 'waiting', ask: 'Allow php artisan migrate --force?' }));
        expect(s).toMatchObject({ word: 'Waiting on you', detail: 'Allow php artisan migrate --force?', tone: 'warn' });
    });

    it('reports a remote agent as unreachable rather than guessing at its state', () => {
        expect(statusOf(row({ fidelity: 'remote', state: 'remote', reason: 'studio offline 4m' })).word)
            .toBe('Unreachable');
    });
});

describe('the context cell — a warning, not a readout', () => {
    it('renders nothing below the threshold', () => {
        expect(contextOf(row({ contextUsed: 38_000 }))).toBeNull();
    });

    it('warns at 160k and turns bad at 180k', () => {
        expect(contextOf(row({ contextUsed: CONTEXT_WARN_AT }))?.tone).toBe('warn');
        expect(contextOf(row({ contextUsed: CONTEXT_DANGER_AT }))?.tone).toBe('bad');
        expect(contextOf(row({ contextUsed: 182_000 }))).toMatchObject({ pct: 91, tone: 'bad' });
    });

    it('renders nothing for an agent that has not reported context — NOT a zero', () => {
        // `null` is "we have not heard", which is a different claim from "it has used none".
        expect(contextOf(row({ contextUsed: null }))).toBeNull();
    });

    it('gives an OBSERVED agent no context cell at all, whatever the numbers say', () => {
        // The cell does not exist for it. Even handed a value, it must not render one —
        // otherwise a stale number from elsewhere could present as a live reading.
        expect(contextOf(row({ fidelity: 'observed', contextUsed: 190_000 }))).toBeNull();
    });
});

describe('the comms cell — a zero would claim an agent works alone', () => {
    it('renders a real count, and whether a link is live', () => {
        expect(commsOf(row({ collaborators: 4, commsLive: true }))).toEqual({ count: 4, live: true });
    });

    it('renders NOTHING when the count could not be attributed', () => {
        // The join that produces this breaks for a dormant agent, which is a normal state.
        // `0` there would be a confident lie about how someone works.
        expect(commsOf(row({ collaborators: null }))).toBeNull();
    });

    it('renders a MEASURED zero, because that is a fact', () => {
        // The other half of the discipline, and the half that is usually forgotten: a
        // declared agent reporting no collaborators HAS told us something. `null` means
        // Genie could not attribute the count; `0` means the agent genuinely works alone.
        // Only the first may render nothing.
        //
        // `commsLive` is set explicitly rather than taken from the fixture default, because
        // an agent with zero collaborators and live traffic is a contradictory state — there
        // is no link for traffic to be on. The first draft of this test asserted exactly that
        // nonsense and failed, which is the fixture being wrong rather than the code.
        expect(commsOf(row({ collaborators: 0, commsLive: false }))).toEqual({ count: 0, live: false });
    });

    it('gives observed and remote agents no comms cell', () => {
        expect(commsOf(row({ fidelity: 'observed', collaborators: 3 }))).toBeNull();
        expect(commsOf(row({ fidelity: 'remote', collaborators: 3 }))).toBeNull();
    });
});

describe('the target cell — three mutually exclusive things', () => {
    it('shows a step and a target for a declared agent', () => {
        expect(targetOf(row())).toEqual({ kind: 'target', step: '4/7', text: 'Passkey enrolment endpoint' });
    });

    it('replaces the target with the ROUTE TO FIX IT when broken', () => {
        // What it was doing is no longer the useful fact.
        const cell = targetOf(row({ state: 'broken', reason: 'Provider sign-in expired', fixes: ['Sign in to kimi'] }));
        expect(cell).toEqual({ kind: 'fixes', fixes: ['Sign in to kimi'] });
    });

    it('shows activity bars for an observed agent — a measurement, not a claim', () => {
        const cell = targetOf(row({ fidelity: 'observed', target: null, activity: [3, 6, 4, 9] }));
        expect(cell).toEqual({ kind: 'activity', bars: [3, 6, 4, 9] });
    });

    it('renders nothing when there is nothing to say', () => {
        expect(targetOf(row({ target: null, step: null }))).toBeNull();
    });
});

describe('summary chips', () => {
    it('emits a chip only for a state that has agents in it', () => {
        const chips = summaryChips([
            row({ id: '1', state: 'waiting' }), row({ id: '2', state: 'working' }), row({ id: '3', state: 'working' }),
        ]);

        expect(chips.map((c) => c.label)).toEqual(['1 waiting on you', '2 working']);
    });

    it('COUNT, not a boolean: no chip anywhere reads as a zero', () => {
        // A spot-check passes while another state still emits "0 broken". Count every chip
        // whose label contains a zero; the only acceptable number is none.
        const chips = summaryChips([row({ state: 'idle' })]);
        expect(chips.filter((c) => /\b0\b/.test(c.label))).toEqual([]);

        // POSITIVE CONTROL: it does emit chips at all.
        expect(chips).toHaveLength(1);
    });
});

describe('twenty agents fit one screen', () => {
    it('groups twenty rows without dropping or collapsing any', () => {
        /**
         * The density budget from the board: twenty agents at 32px rows fit a 900px screen
         * without scrolling. The view-model's duty is not to lose any — a census that hides
         * members is not a census, so there is no "+n more" anywhere.
         */
        const rows = Array.from({ length: 20 }, (_, i) =>
            row({ id: `a${i}`, workspaceId: i % 2 === 0 ? 'tynn' : 'fancy' }));

        const groups = groupByWorkspace(rows, ['tynn', 'fancy']);
        expect(groups.flatMap((g) => g.rows)).toHaveLength(20);
    });
});

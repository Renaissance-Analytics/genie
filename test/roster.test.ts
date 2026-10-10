import { describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import { agentRowFor, type LiveSession } from '../src/core/roster.js';

/**
 * RECORD + LIVE SESSION → DASHBOARD ROW.
 *
 * The join the Dashboard reads, and the one place where "what Genie knows" becomes "what the
 * board claims". Every field it cannot fill must come out `null`, because the board renders
 * `null` as nothing and renders a number as a measurement.
 *
 * ## The failure this file is shaped around
 *
 * §0.4: `sessionFidelity()` returned `observed` for every agent because no declared field was
 * ever populated, so a finished Conversation UI was unreachable for three releases. One
 * mapping function, one wrong default, and every test of the hidden feature stayed green.
 *
 * So fidelity is asserted from a REAL record here, not from a fixture that sets the field the
 * assertion reads.
 */

const record = (over: Partial<Parameters<typeof agentRecord>[0]> = {}) =>
    agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'claude', name: 'atlas', ...over });

const session = (over: Partial<LiveSession> = {}): LiveSession => ({
    running: true, turnState: 'working', startedAt: Date.now() - 12 * 60_000,
    pendingApproval: null, failure: null, contextUsed: null, contextSize: null,
    lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null,
    ...over,
});

describe('an agent with no session', () => {
    it('is IDLE, and says so without inventing a duration', () => {
        const row = agentRowFor(record(), null, () => Date.now());

        expect(row).toMatchObject({ state: 'idle', fidelity: 'declared', duration: null });
        // Nothing has been measured, so nothing is claimed.
        expect(row.delivery).toBeNull();
        expect(row.contextUsed).toBeNull();
        expect(row.collaborators).toBeNull();
        expect(row.target).toBeNull();
    });

    it('is DECLARED, read from the record rather than from a default', () => {
        /**
         * The §0.4 assertion. A registered ACP agent is declared because its provider speaks
         * the protocol — not because a fixture said so. The previous build's mapper defaulted
         * to `observed` and hid the entire Conversation UI behind it.
         */
        expect(agentRowFor(record({ provider: 'claude' }), null, () => Date.now()).fidelity).toBe('declared');
        expect(agentRowFor(record({ provider: 'codex' }), null, () => Date.now()).fidelity).toBe('declared');

        // COUNT, not a spot-check: no provider Genie can register produces anything else. A
        // boolean on one provider passes while another still maps wrongly.
        const providers = ['claude', 'codex'] as const;
        const fidelities = providers.map((p) => agentRowFor(record({ provider: p }), null, () => Date.now()).fidelity);
        expect(fidelities.filter((f) => f !== 'declared')).toEqual([]);
    });
});

describe('a running session', () => {
    it('is WORKING with a duration measured from its start', () => {
        const now = Date.now();
        const row = agentRowFor(record(), session({ startedAt: now - 12 * 60_000 }), () => now);

        expect(row.state).toBe('working');
        expect(row.duration).toBe('12m');
    });

    it('is WAITING, with the question itself, when the provider parked one', () => {
        const row = agentRowFor(
            record(),
            session({ turnState: 'idle', pendingApproval: { question: 'Allow php artisan migrate --force?', options: [{ id: 'allow', label: 'Allow', tone: 'ok' }] } }),
            () => Date.now(),
        );

        expect(row.state).toBe('waiting');
        expect(row.ask).toBe('Allow php artisan migrate --force?');
    });

    it('is BROKEN with a reason and a route, when the session failed', () => {
        const row = agentRowFor(
            record(),
            session({ running: false, turnState: 'stopped', failure: { reason: 'Provider sign-in expired', fixes: ['Sign in to claude'] } }),
            () => Date.now(),
        );

        expect(row.state).toBe('broken');
        expect(row.reason).toBe('Provider sign-in expired');
        expect(row.fixes).toEqual(['Sign in to claude']);
    });

    it('is IDLE — not broken — when a session simply ended', () => {
        // A stopped agent is not a fault, and painting it red is how a board cries wolf. Only
        // a reported failure is broken.
        const row = agentRowFor(record(), session({ running: false, turnState: 'stopped' }), () => Date.now());
        expect(row.state).toBe('idle');
    });

    it('reports UNKNOWN turn state as idle rather than guessing at working', () => {
        // `unknown` means the protocol has not told us. Rendering `Working` would be Genie
        // asserting activity it cannot see, which is the one thing it must never do.
        const row = agentRowFor(record(), session({ turnState: 'unknown' }), () => Date.now());
        expect(row.state).toBe('idle');
        expect(row.duration).toBeNull();
    });
});

describe('the fields the board renders as measurements', () => {
    it('passes a reported context through, and NOT a zero when unreported', () => {
        const reported = agentRowFor(record(), session({ contextUsed: 182_000, contextSize: 200_000 }), () => Date.now());
        expect(reported).toMatchObject({ contextUsed: 182_000, contextSize: 200_000 });

        const silent = agentRowFor(record(), session({ contextUsed: null }), () => Date.now());
        expect(silent.contextUsed).toBeNull();
    });

    it('never fabricates a delivery, a collaborator count or a comms age', () => {
        // COUNT over every field whose `null` means "cannot see". A `?? 0` in a mapper is the
        // single most likely way the whole discipline is lost, and it is one character.
        const row = agentRowFor(record(), session(), () => Date.now());

        const nullable = [row.delivery, row.collaborators, row.commsAgeSeconds, row.contextUsed, row.contextSize];
        expect(nullable.filter((v) => v !== null)).toEqual([]);

        // POSITIVE CONTROL: the same mapper DOES pass these through when the session has them.
        const full = agentRowFor(
            record(),
            session({
                collaborators: 4, commsAgeSeconds: 8, contextUsed: 1_000, contextSize: 200_000,
                lastDelivery: { kind: 'commit', main: 'a1b2c3d', sub: 'passkey endpoint', plus: 88, minus: 3, age: '4m' },
            }),
            () => Date.now(),
        );
        expect([full.collaborators, full.commsAgeSeconds, full.contextUsed].filter((v) => v === null)).toEqual([]);
        expect(full.delivery).toMatchObject({ kind: 'commit', plus: 88 });
    });

    it('carries the agent’s own name and provider — the identity is the NAME', () => {
        const r = record({ name: 'kai', provider: 'codex' });
        const row = agentRowFor(r, null, () => Date.now());

        expect(row.name).toBe('kai');
        expect(row.provider).toBe('codex');
        // The row's id is the record's id, byte-identical. An id split here is invisible: the
        // UI looks up a session that is keyed by something else and shows an empty one forever.
        expect(row.id).toBe(r.id);
    });

    it('shows a plan step only when the agent reported a plan', () => {
        const withPlan = agentRowFor(
            record(),
            session({ plan: { step: 4, of: 7, doing: 'Passkey enrolment endpoint' } }),
            () => Date.now(),
        );
        expect(withPlan).toMatchObject({ step: '4/7', target: 'Passkey enrolment endpoint' });

        const without = agentRowFor(record(), session({ plan: null }), () => Date.now());
        expect(without.step).toBeNull();
        expect(without.target).toBeNull();
    });
});

describe('durations', () => {
    it('reads in minutes and hours, and is absent below a minute', () => {
        const now = Date.now();
        const at = (ms: number) => agentRowFor(record(), session({ startedAt: now - ms }), () => now).duration;

        // Under a minute there is no useful number, and `0m` reads as a stalled agent.
        expect(at(20_000)).toBeNull();
        expect(at(60_000)).toBe('1m');
        expect(at(42 * 60_000)).toBe('42m');
        expect(at(90 * 60_000)).toBe('1h 30m');
        expect(at(3 * 3_600_000)).toBe('3h');
    });

    it('is absent when the session never recorded a start', () => {
        expect(agentRowFor(record(), session({ startedAt: null }), () => Date.now()).duration).toBeNull();
    });
});

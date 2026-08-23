import { describe, expect, it } from 'vitest';
import {
    DEFAULT_AGENT_TERMINAL_CAP,
    countAgentTerminals,
    decideAgentSpawn,
    effectiveAgentCap,
    normaliseCap,
} from '../agent-cap';

/**
 * How many agent terminals may exist, and who is allowed to say so (Tynn #117).
 *
 * An orchestrating agent fanned out six agent terminals in a single session, each
 * briefed independently, and every one of them could interrupt the owner. Nothing
 * in Genie would have stopped it at sixteen. Every agent terminal is a pty, a model
 * session and a share of the owner's attention, so "how many" needs an answer that
 * is not "as many as an agent decides".
 *
 * The load-bearing rule is not the number — it is WHO SETS IT. An agent that can
 * raise its own cap has no cap, so the limit follows the Kanban override and the
 * Workstation Operator toggle: a person changes it, and authority is never
 * inherited by the thing being limited. That is why `actor` is a parameter here
 * rather than something the caller is trusted to have checked already.
 */

const at = (live: number, over: Partial<Parameters<typeof decideAgentSpawn>[0]> = {}) =>
    decideAgentSpawn({
        actor: 'agent',
        live,
        settings: { workstation: 8, workspace: null },
        ...over,
    });

describe('where the limit comes from', () => {
    it('uses the workstation default when the workspace has no opinion', () => {
        const cap = effectiveAgentCap({ workstation: 8, workspace: null });
        expect(cap).toEqual({ limit: 8, source: 'workstation' });
    });

    it('lets a workspace override the workstation default', () => {
        const cap = effectiveAgentCap({ workstation: 8, workspace: 2 });
        expect(cap).toEqual({ limit: 2, source: 'workspace' });
    });

    it('lets a workspace override UPWARD as well as down', () => {
        // The override is not a tightening-only knob. One workspace legitimately
        // running a big fan-out is the case this feature must not make impossible,
        // or the owner will turn the cap off globally and be left with nothing.
        expect(effectiveAgentCap({ workstation: 4, workspace: 16 }).limit).toBe(16);
    });

    it('falls back to a built-in default when nothing is configured at all', () => {
        // A fresh install, or a settings read that returned nothing. The safe
        // answer is a real number: inheriting "no cap" from an absent setting is
        // how a safety feature silently stops existing.
        const cap = effectiveAgentCap({ workstation: null, workspace: null });
        expect(cap).toEqual({ limit: DEFAULT_AGENT_TERMINAL_CAP, source: 'default' });
    });

    it('treats an explicit unlimited as unlimited, which is not the same as unset', () => {
        expect(effectiveAgentCap({ workstation: 'unlimited', workspace: null }).limit).toBe(null);
        expect(effectiveAgentCap({ workstation: 8, workspace: 'unlimited' }).limit).toBe(null);
    });
});

describe('a stored value that makes no sense', () => {
    // These come off disk and out of IPC, so "cannot happen" is not available.
    // The fail-safe direction matters: a corrupt value must not read as unlimited
    // (the cap silently vanishes) OR as zero (nothing can ever start again).
    it('rejects zero, negatives and fractions', () => {
        for (const bad of [0, -1, -20, 2.5]) {
            expect(normaliseCap(bad), String(bad)).toBe(null);
        }
    });

    it('rejects values that are not numbers at all', () => {
        for (const bad of [NaN, Infinity, '8', {}, [], true]) {
            expect(normaliseCap(bad as never), JSON.stringify(bad)).toBe(null);
        }
    });

    it('ignores a corrupt workspace override and inherits instead of failing', () => {
        const cap = effectiveAgentCap({ workstation: 8, workspace: 0 as never });
        expect(cap).toEqual({ limit: 8, source: 'workstation' });
    });

    it('ignores a corrupt workstation value and uses the built-in default', () => {
        const cap = effectiveAgentCap({ workstation: -3 as never, workspace: null });
        expect(cap).toEqual({ limit: DEFAULT_AGENT_TERMINAL_CAP, source: 'default' });
    });
});

describe('an agent asking to start another agent', () => {
    it('is allowed while there is room', () => {
        expect(at(3).allowed).toBe(true);
    });

    it('is allowed for the slot that reaches the limit exactly', () => {
        // The limit is a maximum, not a ceiling to stop short of: 7 live with a
        // limit of 8 must be able to start the eighth.
        const decision = at(7);
        expect(decision.allowed).toBe(true);
        expect(decision.atLimit).toBe(false);
    });

    it('is refused at the limit', () => {
        const decision = at(8);
        expect(decision.allowed).toBe(false);
        expect(decision.atLimit).toBe(true);
    });

    it('is refused above the limit, which happens when the cap is lowered', () => {
        // Lowering the limit does not kill anything already running, so live can
        // legitimately exceed it. The right behaviour is to stop granting new ones
        // until attrition brings it back under.
        expect(at(20).allowed).toBe(false);
    });

    it('is always allowed when the limit is unlimited', () => {
        expect(at(500, { settings: { workstation: 'unlimited', workspace: null } }).allowed).toBe(
            true,
        );
    });
});

/**
 * Starting several at once (genie#245).
 *
 * A GApp seeds its whole DECLARED roster in one go, and its agents count against
 * the cap like anyone else's. Asked one at a time it would be let in whenever a
 * single slot was free and then refused partway — leaving the user with fewer
 * agents than the consent screen named, and nothing said about it. The batch has
 * to be one question.
 */
describe('an agent asking to start SEVERAL at once', () => {
    it('is allowed when the whole batch fits', () => {
        expect(at(5, { want: 3 }).allowed).toBe(true);
    });

    it('is refused when only PART of the batch fits', () => {
        // Six live, a limit of eight, three wanted: two would fit. One at a time
        // this says yes, yes, no. As a batch it is a single, honest no.
        const decision = at(6, { want: 3 });
        expect(decision.allowed).toBe(false);
        expect(decision.atLimit).toBe(true);
    });

    it('says how many it could not start, so the refusal is actionable', () => {
        expect(at(6, { want: 3 }).reason).toContain('3');
    });

    it('reads exactly as before for a single spawn', () => {
        // The sentence agents and users actually see must not grow a "and cannot
        // start 1 more" tail on every ordinary refusal.
        expect(at(8).reason).not.toMatch(/cannot start/i);
        expect(at(8, { want: 1 }).reason).toBe(at(8).reason);
    });

    it('treats a nonsense batch as one, never as none', () => {
        // These arrive from a manifest-driven count. Reading a bad one as zero
        // would let a batch through the cap entirely.
        expect(at(8, { want: 0 }).allowed).toBe(false);
        expect(at(8, { want: -4 }).allowed).toBe(false);
        expect(at(8, { want: 1.5 }).allowed).toBe(false);
    });

    it('never refuses a batch when the limit is off', () => {
        expect(
            at(500, { want: 50, settings: { workstation: 'unlimited', workspace: null } }).allowed,
        ).toBe(true);
    });

    it('tells a PERSON their batch is over the limit without stopping them', () => {
        // Same rule the single-spawn path has: the person owns the limit, so they
        // are told, not refused.
        const decision = at(6, { want: 3, actor: 'human' });
        expect(decision.allowed).toBe(true);
        expect(decision.reason).toBeTruthy();
    });
});

describe('the refusal an agent actually reads', () => {
    const refusal = () => at(8).reason ?? '';

    it('says what the limit is and how many are running', () => {
        // "Refused" with no number invites an immediate retry, which is the exact
        // loop this feature exists to break.
        expect(refusal()).toContain('8');
    });

    it('says where a person changes it', () => {
        expect(refusal().toLowerCase()).toMatch(/settings/);
    });

    it('names the level the limit came from, so the right knob gets turned', () => {
        // Sending someone to workstation settings to change a limit their workspace
        // is overriding wastes the one action they were told to take.
        expect(at(2, { settings: { workstation: 8, workspace: 2 } }).reason).toMatch(/workspace/i);
        expect(at(8, { settings: { workstation: 8, workspace: null } }).reason).toMatch(
            /workstation/i,
        );
    });

    it('tells the agent it cannot lift the limit itself', () => {
        // Without this the next move is obvious and wrong: go and edit the setting.
        // Saying so is cheaper than relying on every write path to refuse it.
        expect(refusal()).toMatch(/only .*(person|human|you)|cannot .*(raise|change)/i);
    });

    it('does not suggest killing someone else’s terminal', () => {
        expect(refusal().toLowerCase()).not.toMatch(/\bkill\b/);
    });
});

describe('a person asking for the same thing', () => {
    // The whole point of the setting is that a person is the authority over it.
    // Refusing them would make the cap a limit on its own owner, and the workaround
    // (raise the cap, add a terminal, lower it again) teaches nothing and costs
    // three actions.
    const human = (live: number) => at(live, { actor: 'human' });

    it('is allowed at the limit', () => {
        expect(human(8).allowed).toBe(true);
    });

    it('is allowed well past the limit', () => {
        expect(human(40).allowed).toBe(true);
    });

    it('still reports that the limit is passed, so the UI can say so', () => {
        const decision = human(8);
        expect(decision.atLimit).toBe(true);
        expect(decision.reason).toBeTruthy();
    });

    it('is told it is over the limit without being told it failed', () => {
        expect(human(8).reason?.toLowerCase()).not.toMatch(/refus|denied|cannot|blocked/);
    });
});

/**
 * What the cap actually counts.
 *
 * The subtle one is liveness. A terminal SPEC outlives its pty on purpose — the
 * row is retained so the terminal can be revived — so counting rows would make the
 * cap a one-way ratchet: every agent that ever ran still occupies a slot, and a
 * long-lived workspace eventually cannot start anything at all.
 */
describe('which terminals count against the cap', () => {
    const live = new Set(['a1', 'a2', 'shell', 'plain', 'other-ws', 'proc']);
    const isLive = (id: string) => live.has(id);

    const spec = (
        id: string,
        over: Partial<Parameters<typeof countAgentTerminals>[0][number]> = {},
    ) => ({ id, workspace_id: 'ws', meta: { agent_id: `inbox-${id}` }, ...over });

    it('counts live terminals running an agent', () => {
        expect(countAgentTerminals([spec('a1'), spec('a2')], 'ws', isLive)).toBe(2);
    });

    it('does NOT count one whose pty has exited, so the slot comes back', () => {
        expect(countAgentTerminals([spec('a1'), spec('dead')], 'ws', isLive)).toBe(1);
    });

    it('does not count another workspace’s agents', () => {
        const theirs = spec('other-ws', { workspace_id: 'somewhere-else' });
        expect(countAgentTerminals([spec('a1'), theirs], 'ws', isLive)).toBe(1);
    });

    it('counts a plain shell an AGENT opened', () => {
        // `manageTerminals create` makes a terminal with no agent in it. Left
        // uncounted, an agent that has run out of agent slots can still open
        // unlimited shells — the same runaway wearing a different hat.
        const shell = spec('shell', { meta: { created_by: 'agent' } });
        expect(countAgentTerminals([shell], 'ws', isLive)).toBe(1);
    });

    it('does NOT count a plain shell the PERSON opened', () => {
        // Their own terminals are not the thing being rationed, and counting them
        // would let ordinary work silently consume the agents' budget.
        const plain = spec('plain', { meta: { created_by: 'human' } });
        expect(countAgentTerminals([plain], 'ws', isLive)).toBe(0);
    });

    it('does not count a terminal that predates the field', () => {
        // Existing terminals carry no `created_by`. Reading absence as "agent"
        // would apply the cap retroactively to work already running.
        const legacy = { id: 'plain', workspace_id: 'ws', meta: {} };
        expect(countAgentTerminals([legacy], 'ws', isLive)).toBe(0);
    });

    it('does not count background processes, which are not terminals', () => {
        const proc = spec('proc', { type: 'process' });
        expect(countAgentTerminals([proc], 'ws', isLive)).toBe(0);
    });

    it('survives a spec with no meta at all', () => {
        const bare = { id: 'a1', workspace_id: 'ws' };
        expect(() => countAgentTerminals([bare], 'ws', isLive)).not.toThrow();
    });
});

describe('counting', () => {
    it('counts only what is live, so an exited agent frees its slot', () => {
        // Asserted here because the alternative — counting terminals ever created —
        // turns the cap into a session-long budget that silently runs out.
        const decision = decideAgentSpawn({
            actor: 'agent',
            live: 7,
            settings: { workstation: 8, workspace: null },
        });
        expect(decision.allowed).toBe(true);
        expect(decision.live).toBe(7);
    });

    it('treats a missing count as fail-closed rather than zero', () => {
        // If the caller could not determine how many are running, granting one more
        // is a guess in the unsafe direction.
        const decision = decideAgentSpawn({
            actor: 'agent',
            live: null as never,
            settings: { workstation: 8, workspace: null },
        });
        expect(decision.allowed).toBe(false);
    });
});

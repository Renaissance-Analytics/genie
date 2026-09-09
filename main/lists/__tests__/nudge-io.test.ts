import { describe, expect, it, vi } from 'vitest';
import { buildListNudgeIO, type NudgeIODeps } from '../nudge-io';

/**
 * The wiring behind the nudge: from "a person ticked this off" to a message in
 * the right agent's terminal, or an honest reason why not.
 *
 * `resolveUserListItem` already owns the DECISION (nudge-tested separately);
 * this owns the LOOKUP, and the lookup is where the feature can lie. Both
 * failure modes here are silent by nature: delivering to an agent that merely
 * shares a name in another workspace, and reporting a delivery to a terminal
 * that has no agent listening. Neither raises anything — the UI just shows a
 * tick.
 */

function deps(over: Partial<NudgeIODeps> = {}): NudgeIODeps {
    return {
        terminals: () => [
            { id: 't-alpha', workspace_id: 'ws-1', meta: { whisper_purpose: 'alpha' } },
            { id: 't-alpha-far', workspace_id: 'ws-2', meta: { whisper_purpose: 'alpha' } },
            { id: 't-closed', workspace_id: 'ws-1', meta: { whisper_purpose: 'ghost' } },
        ],
        // Everything but the closed one has an agent listening.
        isLive: (id) => id !== 't-closed',
        deliver: vi.fn().mockReturnValue({ ok: true }),
        ...over,
    };
}

describe('buildListNudgeIO finds the agent that asked', () => {
    it('resolves an agent name to its live terminal IN THAT WORKSPACE', () => {
        const io = buildListNudgeIO(deps());
        expect(io.liveTerminalFor('ws-1', 'alpha')).toBe('t-alpha');
    });

    it('does NOT cross workspaces — the same name elsewhere is a different agent', () => {
        // The positive control for the line above: without the workspace filter
        // this returns 't-alpha' too, and ws-2's alpha gets ws-1's nudge.
        const io = buildListNudgeIO(deps());
        expect(io.liveTerminalFor('ws-2', 'alpha')).toBe('t-alpha-far');
        expect(io.liveTerminalFor('ws-3', 'alpha')).toBeNull();
    });

    it('answers null for an agent whose terminal has nobody listening', () => {
        const io = buildListNudgeIO(deps());
        expect(io.liveTerminalFor('ws-1', 'ghost')).toBeNull();
    });

    it('answers null for an agent it has never heard of', () => {
        const io = buildListNudgeIO(deps());
        expect(io.liveTerminalFor('ws-1', 'nobody')).toBeNull();
    });
});

describe('buildListNudgeIO reports WHY a delivery failed', () => {
    it('passes a successful delivery straight through', () => {
        const io = buildListNudgeIO(deps());
        expect(io.deliver('t-alpha', 'hello')).toEqual({ ok: true });
    });

    it('turns `no-agent` into a sentence about THAT, not a generic failure', () => {
        const io = buildListNudgeIO(
            deps({ deliver: () => ({ ok: false, reason: 'no-agent' }) }),
        );
        const r = io.deliver('t-alpha', 'hello');
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('expected a failure');
        expect(r.reason).toMatch(/no longer|not running|closed|no agent/i);
    });

    it('distinguishes a REFUSAL from a missing agent — genie#462’s whole point', () => {
        const io = buildListNudgeIO(
            deps({ deliver: () => ({ ok: false, reason: 'refused', error: 'inbox full' }) }),
        );
        const r = io.deliver('t-alpha', 'hello');
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('expected a failure');
        expect(r.reason).toMatch(/refus/i);
        // The broker's own words survive — a caller inventing a cause is the bug.
        expect(r.reason).toMatch(/inbox full/);
    });

    it('never reports a throw as a delivery', () => {
        const io = buildListNudgeIO(
            deps({
                deliver: () => {
                    throw new Error('broker exploded');
                },
            }),
        );
        const r = io.deliver('t-alpha', 'hello');
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('expected a failure');
        expect(r.reason).toMatch(/broker exploded/);
    });
});

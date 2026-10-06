import { describe, expect, it } from 'vitest';
import { applySessionUpdate } from '../update-to-session';
import type { AgentSession } from '../../agentsession/model';

/**
 * That the synthesis is actually REACHED — the half that matters.
 *
 * C14 in `.ai/plans/genie-2-corrections.md` is this repo discovering that
 * `plan_update` and `plan_removed` had full mapper branches and had never once had a live
 * input. A green unit suite for `plan-synthesis.ts` would say nothing about whether
 * `applySessionUpdate` ever calls it. So every assertion here goes through the real entry
 * point with a real update shape.
 *
 * The behaviour being pinned is SUPPRESSION: a recognised plan tool populates `plan` and
 * must NOT also land in `tools`. Getting that wrong shows the plan twice — once as the rail
 * and once as tool rows — and presents as a rendering bug rather than a mapping one.
 */

const NOW = 1_000;

const session = (over: Partial<AgentSession> = {}): AgentSession => ({
    agentId: 'a1',
    specId: 's1',
    session: { provider: 'claude', name: 'kai', cwd: '/w', workspaceId: 'w1', sessionId: 'sess' },
    turn: { state: 'idle', since: 0 },
    composer: null,
    transcript: [],
    live: null,
    tools: [],
    approvals: [],
    plan: null,
    usage: null,
    commands: null,
    error: null,
    ...over,
});

const toolCall = (name: string, rawInput: unknown, id = 'tc1') => ({
    sessionUpdate: 'tool_call' as const,
    toolCallId: id,
    name,
    rawInput,
});

describe('a recognised plan tool populates the plan', () => {
    it('TodoWrite becomes a plan', () => {
        const s = applySessionUpdate(
            session(),
            toolCall('TodoWrite', {
                todos: [
                    { content: 'read ipc.ts', status: 'completed' },
                    { content: 'patch it', status: 'in_progress' },
                ],
            }),
            NOW,
        );
        expect(s.plan?.map((e) => [e.title, e.status])).toEqual([
            ['read ipc.ts', 'done'],
            ['patch it', 'in-progress'],
        ]);
    });

    it('and is SUPPRESSED from tools — otherwise the plan renders twice', () => {
        const s = applySessionUpdate(session(), toolCall('TodoWrite', { todos: [{ content: 'x' }] }), NOW);
        expect(s.tools).toEqual([]);
    });

    it('TaskCreate appends across successive calls', () => {
        let s = applySessionUpdate(session(), toolCall('TaskCreate', { subject: 'first' }, 'c1'), NOW);
        s = applySessionUpdate(s, toolCall('TaskCreate', { subject: 'second' }, 'c2'), NOW);
        expect(s.plan?.map((e) => e.title)).toEqual(['first', 'second']);
        expect(s.tools).toEqual([]);
    });

    it('TaskUpdate changes a status set by an earlier TaskCreate', () => {
        // The real sequence from prism's capture: TaskCreate then TaskUpdate.
        let s = applySessionUpdate(session(), toolCall('TaskCreate', { subject: 'patch it', taskId: 'T7' }, 'c1'), NOW);
        s = applySessionUpdate(s, toolCall('TaskUpdate', { taskId: 'T7', status: 'in_progress' }, 'c2'), NOW);
        expect(s.plan).toEqual([{ id: 'T7', title: 'patch it', status: 'in-progress' }]);
    });

    it('reports the turn as tool work, not idle', () => {
        const s = applySessionUpdate(session(), toolCall('TodoWrite', { todos: [{ content: 'x' }] }), NOW);
        expect(s.turn).toEqual({ state: 'tool', since: NOW });
    });
});

describe('an ordinary tool is untouched', () => {
    it('still appears in tools, and leaves the plan alone', () => {
        // The negative control. Without this, suppressing EVERYTHING would also pass every
        // assertion above.
        const s = applySessionUpdate(session(), toolCall('Bash', { command: 'npm test' }), NOW);
        expect(s.tools.map((t) => t.name)).toEqual(['Bash']);
        expect(s.plan).toBeNull();
    });

    it('a plan tool with an unreadable payload stays a visible tool call', () => {
        // Recognising the name but not the arguments is when guessing is worst. Suppressing
        // it AND producing no plan would lose the information entirely.
        const s = applySessionUpdate(session(), toolCall('TodoWrite', { todos: 'not-an-array' }), NOW);
        expect(s.tools).toHaveLength(1);
        expect(s.plan).toBeNull();
    });
});

describe('the canary fires through the real mapper', () => {
    const renamed = toolCall('TaskReplace', { subject: 'whatever' });

    it('surfaces an error naming the tool, so the rename is LOUD', () => {
        const s = applySessionUpdate(session(), renamed, NOW);
        expect(s.error).toContain('TaskReplace');
        expect(s.error).toMatch(/plan rail may be incomplete/);
    });

    it('blames Genie, not the agent — the agent did nothing wrong', () => {
        expect(applySessionUpdate(session(), renamed, NOW).error).toMatch(/^Genie/);
    });

    it('still records the tool call, so the information is not lost as well', () => {
        expect(applySessionUpdate(session(), renamed, NOW).tools.map((t) => t.name)).toEqual(['TaskReplace']);
    });

    it('never overwrites a REAL error from the agent', () => {
        // A mapping gap must not mask the agent's own failure.
        const s = applySessionUpdate(session({ error: 'the agent crashed' }), renamed, NOW);
        expect(s.error).toBe('the agent crashed');
    });
});

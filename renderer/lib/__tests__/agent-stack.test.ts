import { describe, expect, it } from 'vitest';
import { agentStack, type AgentStackInput } from '../agent-stack';

/**
 * The AVATAR STACK on a workspace row, and what its popover says.
 *
 * A row today shows a name, a sparkline, and an IssueWatch pill — nothing about
 * WHO is working in that workspace. The stack answers that at a glance, and
 * hovering it gives each agent's status: which TUI is active, and whether any
 * sidecars are running.
 *
 * It reads the same rows the grid does, deliberately. Deriving a second answer
 * from terminal specs is exactly how the row and the grid would come to disagree
 * — which is the class of bug this whole redesign started from.
 */
describe('agentStack', () => {
    const row = (over: Partial<AgentStackInput['rows'][number]> & { id: string; name: string }) => ({
        kind: 'agent' as const,
        provider: null,
        tuis: [],
        running: false,
        role: 'specialized' as const,
        avatar: null,
        collisionGroup: null,
        purpose: '',
        ...over,
    });

    it('shows one entry per agent, with its active TUI', () => {
        const stack = agentStack({
            rows: [
                row({
                    id: 'a1',
                    name: 'tynn',
                    provider: 'claude',
                    running: true,
                    tuis: [{ runtimeId: 'r1', provider: 'claude', fronted: true, running: true }],
                }),
            ],
        });
        expect(stack.entries).toHaveLength(1);
        expect(stack.entries[0]).toMatchObject({ name: 'tynn', provider: 'claude', running: true });
    });

    it('counts sidecars separately from the active TUI', () => {
        const stack = agentStack({
            rows: [
                row({
                    id: 'a1',
                    name: 'tynn',
                    provider: 'claude',
                    running: true,
                    tuis: [
                        { runtimeId: 'r1', provider: 'claude', fronted: true, running: true },
                        { runtimeId: 'r2', provider: 'codex', fronted: false, running: true },
                    ],
                }),
            ],
        });
        expect(stack.entries[0]!.sidecars).toEqual([{ provider: 'codex', running: true }]);
    });

    it('reports a sidecar that is registered but not running', () => {
        // "Has a codex sidecar" and "that sidecar is live" are different facts,
        // and the second is the one that costs money.
        const stack = agentStack({
            rows: [
                row({
                    id: 'a1',
                    name: 'tynn',
                    provider: 'claude',
                    tuis: [
                        { runtimeId: 'r1', provider: 'claude', fronted: true, running: false },
                        { runtimeId: 'r2', provider: 'codex', fronted: false, running: false },
                    ],
                }),
            ],
        });
        expect(stack.entries[0]!.sidecars).toEqual([{ provider: 'codex', running: false }]);
    });

    it('EXCLUDES orphans — they are not agents', () => {
        // An orphan is a leftover terminal offered for repair. Putting it in the
        // stack would re-create the phantom-square bug on a different surface.
        const stack = agentStack({
            rows: [
                row({ id: 'a1', name: 'tynn', provider: 'claude' }),
                { ...row({ id: 't-orphan', name: 'tynn' }), kind: 'orphan' as const },
            ],
        });
        expect(stack.entries.map((e) => e.id)).toEqual(['a1']);
    });

    it('counts how many are RUNNING, for the row’s summary', () => {
        const stack = agentStack({
            rows: [
                row({ id: 'a1', name: 'one', running: true }),
                row({ id: 'a2', name: 'two', running: false }),
                row({ id: 'a3', name: 'three', running: true }),
            ],
        });
        expect(stack.running).toBe(2);
        expect(stack.total).toBe(3);
    });

    it('caps the visible avatars and reports the overflow', () => {
        // A workspace with a dozen agents must not push the IssueWatch square off
        // the row. The count is what carries the rest.
        const stack = agentStack({
            rows: Array.from({ length: 7 }, (_, i) => row({ id: `a${i}`, name: `n${i}` })),
            max: 4,
        });
        expect(stack.entries).toHaveLength(4);
        expect(stack.overflow).toBe(3);
    });

    it('has no overflow when everyone fits', () => {
        const stack = agentStack({ rows: [row({ id: 'a1', name: 'one' })], max: 4 });
        expect(stack.overflow).toBe(0);
    });

    it('puts RUNNING agents in front of dormant ones', () => {
        // With a cap, who gets shown matters: the agents doing work are the ones
        // worth a slot.
        const stack = agentStack({
            rows: [
                row({ id: 'a1', name: 'dormant' }),
                row({ id: 'a2', name: 'busy', running: true }),
            ],
            max: 1,
        });
        expect(stack.entries[0]!.name).toBe('busy');
    });

    it('is empty for a workspace with no agents at all', () => {
        const stack = agentStack({ rows: [] });
        expect(stack.entries).toEqual([]);
        expect(stack.total).toBe(0);
    });
});

import { describe, expect, it } from 'vitest';
import {
    PLAN_TOOL_NAMES,
    applyPlanTool,
    isUnrecognisedPlanTool,
    looksLikePlanTool,
    planToolRole,
} from '../plan-synthesis';
import type { PlanEntry } from '../../agentsession/model';

/**
 * Synthesising a plan from tool names — owner decision 2026-10-06:
 * *"synthesize the plan from tool names, both vocabularies."*
 *
 * ## Why this has to exist at all
 *
 * The Claude CLI emits **no plan frames**. Prism captured a plan-building turn: 139
 * frames, zero `plan`/`plan_update`/`plan_removed`. The plan arrives entirely as ordinary
 * tool calls. The third-party adapter that was removed did this synthesis; nothing else
 * does, so without it Genie's plan rail is permanently empty for claude.
 *
 * ## The two things that make it dangerous, both tested here
 *
 * **1. Suppression, not addition.** The adapter SUPPRESSES the plan tools as tool calls
 * and surfaces them as a plan instead. Emitting both shows the plan twice — once as a rail
 * and once as tool rows — which reads as a rendering bug in Genie rather than a mapping
 * bug anywhere.
 *
 * **2. The rename already happened.** `TodoWrite` → `TaskCreate`/`TaskUpdate`; the adapter
 * carries both, and prism's capture used the newer pair. So this is inference that breaks
 * silently on the NEXT rename — the plan would just stop appearing and nothing would
 * complain. The defence is a runtime canary, not a comment: a name that LOOKS like a plan
 * tool but is not recognised is reported, so the rename is loud.
 */

const entry = (over: Partial<PlanEntry> = {}): PlanEntry => ({
    id: 't1',
    title: 'read ipc.ts',
    status: 'pending',
    ...over,
});

describe('both vocabularies are recognised', () => {
    it('knows the old one — TodoWrite', () => {
        expect(planToolRole('TodoWrite')).toBe('write-all');
    });

    it('knows the new pair — TaskCreate / TaskUpdate', () => {
        expect(planToolRole('TaskCreate')).toBe('create');
        expect(planToolRole('TaskUpdate')).toBe('update');
    });

    it('carries BOTH, so a build using either still shows a plan', () => {
        // The owner's instruction was explicitly "both vocabularies". The adapter carried
        // both; prism's capture used only the newer, which is how we know the rename is
        // history rather than hypothesis.
        expect(PLAN_TOOL_NAMES).toContain('TodoWrite');
        expect(PLAN_TOOL_NAMES).toContain('TaskCreate');
        expect(PLAN_TOOL_NAMES).toContain('TaskUpdate');
    });

    it('is not fooled by an ordinary tool', () => {
        expect(planToolRole('Bash')).toBeNull();
        expect(planToolRole('Write')).toBeNull();
    });
});

describe('the rename canary — this is the part that keeps it honest', () => {
    it('spots a plan-SHAPED name it does not know', () => {
        // The next rename. `TaskReplace` is not in our table, but it is unmistakably one of
        // this family, and silently treating it as an ordinary tool is how the plan rail
        // goes dark with nobody noticing.
        expect(looksLikePlanTool('TaskReplace')).toBe(true);
        expect(planToolRole('TaskReplace')).toBeNull();
        expect(isUnrecognisedPlanTool('TaskReplace')).toBe(true);
    });

    it('does NOT flag a name it already handles', () => {
        // Otherwise every plan tool would raise the alarm and the alarm would mean nothing.
        expect(isUnrecognisedPlanTool('TaskCreate')).toBe(false);
        expect(isUnrecognisedPlanTool('TodoWrite')).toBe(false);
    });

    it('does NOT flag an ordinary tool', () => {
        expect(isUnrecognisedPlanTool('Bash')).toBe(false);
        expect(looksLikePlanTool('Bash')).toBe(false);
    });

    it('matches the family case-insensitively, since a rename may recase too', () => {
        expect(looksLikePlanTool('taskCreateMany')).toBe(true);
        expect(looksLikePlanTool('todo_write')).toBe(true);
    });
});

describe('TodoWrite republishes the WHOLE list', () => {
    it('replaces the entries rather than appending to them', () => {
        // The adapter emits only `plan`, republishing everything, never a delta. Appending
        // would duplicate every entry on each call.
        const before = [entry({ id: 'old', title: 'stale' })];
        const out = applyPlanTool(before, {
            name: 'TodoWrite',
            input: { todos: [{ content: 'read ipc.ts', status: 'pending' }, { content: 'patch it', status: 'in_progress' }] },
        });
        expect(out).not.toBeNull();
        expect(out!.map((e) => e.title)).toEqual(['read ipc.ts', 'patch it']);
    });

    it('maps the CLI status vocabulary onto Genie PlanEntry status', () => {
        // THREE statuses on the wire (pending|in_progress|completed), FOUR in PlanEntry
        // (pending|in-progress|done|dropped) — different spelling AND cardinality.
        const out = applyPlanTool([], {
            name: 'TodoWrite',
            input: {
                todos: [
                    { content: 'a', status: 'pending' },
                    { content: 'b', status: 'in_progress' },
                    { content: 'c', status: 'completed' },
                ],
            },
        });
        expect(out!.map((e) => e.status)).toEqual(['pending', 'in-progress', 'done']);
    });
});

describe('TaskCreate adds one entry', () => {
    it('appends, keeping what is already there', () => {
        const out = applyPlanTool([entry({ id: 'a', title: 'first' })], {
            name: 'TaskCreate',
            input: { subject: 'second', description: 'details' },
        });
        expect(out!.map((e) => e.title)).toEqual(['first', 'second']);
    });

    it('titles it from `subject`, which is what the CLI sends', () => {
        const out = applyPlanTool([], { name: 'TaskCreate', input: { subject: 'patch feedTerminalData' } });
        expect(out![0]!.title).toBe('patch feedTerminalData');
    });

    it('starts it pending — a new task has not been done', () => {
        const out = applyPlanTool([], { name: 'TaskCreate', input: { subject: 'x' } });
        expect(out![0]!.status).toBe('pending');
    });
});

describe('TaskUpdate changes one entry', () => {
    const base = [entry({ id: 'a', title: 'first' }), entry({ id: 'b', title: 'second' })];

    it('changes the addressed entry only', () => {
        const out = applyPlanTool(base, { name: 'TaskUpdate', input: { taskId: 'b', status: 'completed' } });
        expect(out!.find((e) => e.id === 'b')!.status).toBe('done');
        expect(out!.find((e) => e.id === 'a')!.status).toBe('pending');
    });

    it('LEAVES THE STATUS ALONE when the CLI sends one we do not know', () => {
        // Mapping an unknown status to `pending` would claim the task had not been started,
        // which is a statement about the work rather than about our ignorance. Keeping the
        // current value is the only answer that asserts nothing new.
        const out = applyPlanTool([entry({ id: 'a', status: 'in-progress' })], {
            name: 'TaskUpdate',
            input: { taskId: 'a', status: 'deferred_until_tuesday' },
        });
        expect(out!.find((e) => e.id === 'a')!.status).toBe('in-progress');
    });

    it('ignores an update for an id it has never seen, rather than inventing an entry', () => {
        // A plan entry conjured from an update has no title, and a titleless row in the
        // rail is worse than a missing one.
        const out = applyPlanTool(base, { name: 'TaskUpdate', input: { taskId: 'nope', status: 'completed' } });
        expect(out!.map((e) => e.id)).toEqual(['a', 'b']);
    });
});

describe('not a plan tool', () => {
    it('returns null, which is the signal NOT to suppress the tool call', () => {
        // null means "this is an ordinary tool" — it must keep appearing in tools[].
        expect(applyPlanTool([], { name: 'Bash', input: { command: 'npm test' } })).toBeNull();
    });

    it('returns null for malformed input to a plan tool, rather than a wrong plan', () => {
        // Recognising the name but not understanding the payload is exactly when guessing
        // is worst. Suppressing the tool call AND producing no plan would lose the
        // information entirely.
        expect(applyPlanTool([], { name: 'TodoWrite', input: { todos: 'not-an-array' } })).toBeNull();
        expect(applyPlanTool([], { name: 'TaskCreate', input: {} })).toBeNull();
    });
});

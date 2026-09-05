/**
 * Authoring a Flow — the half `main/flows/` shipped without.
 *
 * Phase 1 shipped a complete model with no way to create anything, so every
 * Flow in existence was one somebody wrote into the table by hand. The
 * interesting properties of authoring are not that a form round-trips; they are
 * the two that decide whether a created Flow can be trusted:
 *
 *  1. **A new Flow is born disarmed**, and no caller — renderer, agent, or a
 *     hand-written draft — can ask for otherwise. Arming is a separate act with
 *     a confirmation in front of it, and creation must not be a way around it.
 *  2. **A Flow that could never work is refused at the write.** `store.ts`
 *     already refuses one whose trigger nothing emits; the same must hold for a
 *     body whose inputs nothing supplies, and for an event trigger on a body no
 *     unattended run may execute. Both would otherwise sit in the list looking
 *     armed and fail at 3am with nobody watching.
 */

import { describe, expect, it } from 'vitest';
import { createFlowEventRegistry } from '../events';
import { relocateFileRecipe } from '../builtin-recipes';
import {
    buildFlow,
    planFlowSave,
    recipeErrors,
    suggestFlowPurpose,
    summariseFlowRecipe,
    summariseFlowRecipes,
    type FlowDraft,
} from '../authoring';
import { resolveBuiltInRecipe } from '../builtin-recipes';
import type { Flow, FlowEventDefinition, FlowRecipe, FlowTrigger } from '../types';

const registry = createFlowEventRegistry();
const relocate = summariseFlowRecipe(relocateFileRecipe);

/** An event kind carrying none of the props the relocate body reads. */
const WOKE_UP: FlowEventDefinition = {
    id: 'machine:woke',
    label: 'The machine woke up',
    purpose: 'System',
    props: [{ key: 'afterMs', type: 'number', label: 'Asleep for' }],
};

const wideRegistry = createFlowEventRegistry([...registry.list(), WOKE_UP]);

/** A body a system trigger may never execute — a shell command, unattended. */
const shellRecipe: FlowRecipe = {
    id: 'test.shell',
    title: 'Run something',
    steps: [{ type: 'terminal', id: 'go', title: 'Run it', command: 'echo hi' }],
};

/** A body only a person stepping through the wizard can run. */
const formRecipe: FlowRecipe = {
    id: 'test.form',
    title: 'Ask something',
    steps: [{ type: 'form', id: 'ask', title: 'Ask', fields: [] }],
};

function draft(over: Partial<FlowDraft> = {}): FlowDraft {
    return {
        title: 'Keep the repo light',
        scope: { kind: 'workspace', workspaceId: 'ws-1' },
        recipeId: relocateFileRecipe.id,
        triggers: [
            {
                kind: 'event',
                event: 'files:added',
                filter: { all: [{ prop: 'sizeBytes', op: 'gt', value: 5_242_880 }] },
            },
        ],
        ...over,
    };
}

function stored(over: Partial<Flow> = {}): Flow {
    return {
        id: 'keep-the-repo-light',
        title: 'Keep the repo light',
        purpose: 'Files',
        scope: { kind: 'workspace', workspaceId: 'ws-1' },
        enabled: true,
        triggers: [{ kind: 'event', event: 'files:added' }],
        recipe: { kind: 'builtin', recipeId: relocateFileRecipe.id },
        ...over,
    };
}

/* ===== the catalogue an authoring surface reads ======================== */

describe('summariseFlowRecipe', () => {
    it('carries what a surface needs to offer the body, from the body itself', () => {
        expect(relocate.id).toBe(relocateFileRecipe.id);
        expect(relocate.title).toBe(relocateFileRecipe.title);
        expect(relocate.consequence).toBe(relocateFileRecipe.consequence);
        // The inputs are DECLARED, so a second recipe is offered by the same
        // form without anything being taught about it.
        expect(relocate.inputs.map((i) => i.key)).toContain('relocateTo');
    });

    it('says whether a system trigger could ever run the body, and why not', () => {
        // Positive control first: without it, "not runnable" would also pass
        // against a summariser that reported everything as unrunnable.
        expect(relocate.runsUnattended).toBe(true);
        expect(relocate.unattendedRefusals).toEqual([]);

        const shell = summariseFlowRecipe(shellRecipe);
        expect(shell.runsUnattended).toBe(false);
        expect(shell.unattendedRefusals.map((r) => r.stepId)).toEqual(['go']);
        expect(shell.unattendedRefusals[0]?.reason).toContain('shell command');
    });

    it('says whether a manual run hands off to the wizard', () => {
        expect(relocate.needsWizard).toBe(false);
        expect(summariseFlowRecipe(formRecipe).needsWizard).toBe(true);
    });

    it('summarises a whole catalogue in id order', () => {
        const all = summariseFlowRecipes([shellRecipe, relocateFileRecipe]);
        expect(all.map((r) => r.id)).toEqual([relocateFileRecipe.id, shellRecipe.id]);
    });
});

/* ===== ids ============================================================= */

describe('the id a new Flow gets', () => {
    it('reads as the title, so a log line names something recognisable', () => {
        expect(buildFlow(draft()).flow.id).toBe('keep-the-repo-light');
    });

    it('never collides with one already in use', () => {
        const taken = new Set(['keep-the-repo-light']);
        expect(buildFlow(draft(), { taken }).flow.id).toBe('keep-the-repo-light-2');
    });

    it('falls back to something legible when the title has no letters', () => {
        expect(buildFlow(draft({ title: '???' })).flow.id).toMatch(/^flow-/);
    });

    it('is kept when the draft edits an existing Flow', () => {
        const existing = stored();
        const built = buildFlow(draft({ id: existing.id, title: 'Renamed' }), { existing });
        expect(built.flow.id).toBe(existing.id);
        expect(built.flow.title).toBe('Renamed');
    });
});

/* ===== the safety property ============================================= */

describe('a new Flow is created disarmed', () => {
    it('ignores a caller that asks for an armed one', () => {
        // The draft type has no `enabled`, so this is what a hand-written IPC
        // payload looks like. Arming is confirmed separately, in the recipe's
        // own words; creation must not be a second door onto it.
        const built = buildFlow({ ...draft(), enabled: true } as FlowDraft);
        expect(built.flow.enabled).toBe(false);
    });

    it('leaves an armed Flow armed through an ordinary edit', () => {
        // The control for the two below: `disarmed` is not simply always true.
        const existing = stored({ enabled: true });
        const built = buildFlow(draft({ id: existing.id, title: 'Renamed' }), { existing });
        expect(built.flow.enabled).toBe(true);
        expect(built.disarmed).toBe(false);
    });

    it('disarms an armed Flow when its BODY changes, and says so', () => {
        // What the arm confirmation stated was this recipe's consequence. Swap
        // the body and that sentence no longer describes the Flow, so the
        // consent it recorded no longer covers it.
        const existing = stored({ enabled: true });
        const built = buildFlow(
            { ...draft({ id: existing.id }), recipeId: 'test.shell' },
            { existing },
        );
        expect(built.flow.enabled).toBe(false);
        expect(built.disarmed).toBe(true);
    });

    it('disarms an armed Flow when its SCOPE widens, and says so', () => {
        // The other half of that sentence: "…in this workspace" versus
        // "…anywhere on this machine".
        const existing = stored({ enabled: true });
        const built = buildFlow(
            draft({ id: existing.id, scope: { kind: 'system' } }),
            { existing },
        );
        expect(built.flow.enabled).toBe(false);
        expect(built.disarmed).toBe(true);
    });

    it('reports no disarm when the Flow was already off', () => {
        const existing = stored({ enabled: false });
        const built = buildFlow(
            { ...draft({ id: existing.id }), recipeId: 'test.shell' },
            { existing },
        );
        expect(built.flow.enabled).toBe(false);
        expect(built.disarmed).toBe(false);
    });
});

/* ===== purpose, which the menu groups by =============================== */

describe('suggestFlowPurpose', () => {
    it('takes the trigger event’s own grouping, so nobody has to invent one', () => {
        const triggers: FlowTrigger[] = [{ kind: 'event', event: 'files:added' }];
        expect(suggestFlowPurpose(relocate, triggers, registry)).toBe('Files');
    });

    it('falls back to the recipe’s when the Flow is manual only', () => {
        expect(suggestFlowPurpose(relocate, [{ kind: 'manual' }], registry)).toBe('Files');
    });

    it('never returns empty, because the store refuses a Flow with no purpose', () => {
        const bare = summariseFlowRecipe({ id: 'x.y', title: 'Bare', steps: [] });
        expect(suggestFlowPurpose(bare, [{ kind: 'manual' }], registry)).not.toBe('');
    });
});

/* ===== a Flow whose body could never run ============================== */

describe('recipeErrors', () => {
    it('accepts the reference case, where the event supplies what the body reads', () => {
        const flow = buildFlow(draft()).flow;
        expect(recipeErrors(flow, relocate, registry)).toEqual([]);
    });

    it('refuses a manual trigger the body has no inputs for, naming both', () => {
        // `genie.relocate-file` reads `relPath` off the event. Pressing Run on a
        // Flow with nothing else to read it from throws at the first step —
        // which is a Run button that can only ever fail.
        const flow = buildFlow(draft({ triggers: [{ kind: 'manual' }] })).flow;
        const errors = recipeErrors(flow, relocate, registry);
        expect(errors.join(' ')).toContain('relPath');
        expect(errors.join(' ')).toContain('run by hand');
    });

    it('accepts that same manual Flow once the values are given as settings', () => {
        const flow = buildFlow(
            draft({
                triggers: [{ kind: 'manual' }],
                args: { workspacePath: 'C:/repo', relPath: 'big.bin' },
            }),
        ).flow;
        expect(recipeErrors(flow, relocate, registry)).toEqual([]);
    });

    it('refuses an event that does not carry a prop the body reads', () => {
        const flow = buildFlow(
            draft({ triggers: [{ kind: 'event', event: WOKE_UP.id }] }),
        ).flow;
        const errors = recipeErrors(flow, relocate, wideRegistry);
        expect(errors.join(' ')).toContain(WOKE_UP.id);
        expect(errors.join(' ')).toContain('relPath');
    });

    it('refuses a setting the recipe does not have — the misspelling case', () => {
        const flow = buildFlow(draft({ args: { relocatTo: '.big' } })).flow;
        const errors = recipeErrors(flow, relocate, registry);
        expect(errors.join(' ')).toContain('relocatTo');
    });

    it('refuses a setting of the wrong type', () => {
        const flow = buildFlow(draft({ args: { relocateTo: 5 } })).flow;
        const errors = recipeErrors(flow, relocate, registry);
        expect(errors.join(' ')).toContain('relocateTo');
    });

    it('accepts an optional setting left out, because the body has a default', () => {
        const flow = buildFlow(draft({ args: {} })).flow;
        expect(recipeErrors(flow, relocate, registry)).toEqual([]);
    });

    it('refuses a system trigger on a body no unattended run may execute', () => {
        // Otherwise the Flow is armed, fires nightly, and is refused every time
        // — a list entry that looks healthy and has never done anything.
        const flow = buildFlow(
            { ...draft(), recipeId: shellRecipe.id },
            {},
        ).flow;
        const errors = recipeErrors(flow, summariseFlowRecipe(shellRecipe), registry);
        expect(errors.join(' ')).toContain('shell command');
    });

    it('allows that same body when only a person can start it', () => {
        const flow = buildFlow(
            { ...draft({ triggers: [{ kind: 'manual' }] }), recipeId: shellRecipe.id },
            {},
        ).flow;
        expect(recipeErrors(flow, summariseFlowRecipe(shellRecipe), registry)).toEqual([]);
    });
});

/* ===== what a save actually decides ==================================== */

describe('planFlowSave', () => {
    const deps = { registry, resolveRecipe: resolveBuiltInRecipe };

    it('groups the Flow under its trigger’s own purpose, so nobody has to invent one', () => {
        const plan = planFlowSave(draft(), deps);
        expect(plan.ok).toBe(true);
        if (plan.ok) expect(plan.flow.purpose).toBe('Files');
    });

    it('creates it disarmed and reports no disarm, because nothing was armed', () => {
        const plan = planFlowSave(draft(), deps);
        expect(plan.ok && plan.flow.enabled).toBe(false);
        expect(plan.ok && plan.disarmed).toBe(false);
    });

    it('refuses an edit of a Flow that is no longer there', () => {
        // Two managers open, one deletes. The other's Save must not quietly
        // resurrect the Flow it was editing under a fresh row.
        const plan = planFlowSave(draft({ id: 'gone' }), { ...deps, existing: null });
        expect(plan.ok).toBe(false);
        if (!plan.ok) expect(plan.errors.join(' ')).toContain('gone');
    });

    it('returns every reason at once rather than the first', () => {
        const plan = planFlowSave(
            draft({
                title: '',
                triggers: [{ kind: 'event', event: 'files:teleported' }],
            }),
            deps,
        );
        expect(plan.ok).toBe(false);
        if (!plan.ok) expect(plan.errors.length).toBeGreaterThan(1);
    });

    it('carries the disarm through, so the surface can say the switch moved', () => {
        const existing = stored({ enabled: true });
        const plan = planFlowSave(draft({ id: existing.id, scope: { kind: 'system' } }), {
            ...deps,
            existing,
        });
        expect(plan.ok && plan.disarmed).toBe(true);
        expect(plan.ok && plan.flow.enabled).toBe(false);
    });
});

/**
 * `flows:save` is reachable by an AGENT, not only by a form that always sends
 * well-shaped objects. A draft with a string where a list belongs must come
 * back as a reason, the way every other refusal does — a thrown TypeError
 * crosses IPC as an opaque rejection with nothing in it to act on.
 */
describe('planFlowSave refuses a malformed draft instead of throwing', () => {
    const deps = { registry, resolveRecipe: resolveBuiltInRecipe };
    const bad = (over: Record<string, unknown>): FlowDraft =>
        ({ ...draft(), ...over }) as unknown as FlowDraft;

    it('when the triggers are not a list', () => {
        const plan = planFlowSave(bad({ triggers: 'whenever' }), deps);
        expect(plan.ok).toBe(false);
        if (!plan.ok) expect(plan.errors.join(' ')).toContain('trigger');
    });

    it('when the title is not text', () => {
        const plan = planFlowSave(bad({ title: 42 }), deps);
        expect(plan.ok).toBe(false);
        if (!plan.ok) expect(plan.errors.join(' ')).toContain('title');
    });

    it('when there is no scope at all', () => {
        const plan = planFlowSave(bad({ scope: undefined }), deps);
        expect(plan.ok).toBe(false);
        if (!plan.ok) expect(plan.errors.join(' ')).toContain('scope');
    });

    it('when the settings are not an object', () => {
        const plan = planFlowSave(bad({ args: 'relocateTo=.big' }), deps);
        expect(plan.ok).toBe(false);
        if (!plan.ok) expect(plan.errors.join(' ')).toContain('settings');
    });

    it('still accepts a well-formed one (control)', () => {
        expect(planFlowSave(draft(), deps).ok).toBe(true);
    });
});

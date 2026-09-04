/**
 * A system-triggered Flow runs its Recipe with NO HUMAN PRESENT.
 *
 * `TerminalStepSpec` runs commands. The existing approval model
 * (`approveProcessRun` / `workspaceProcessApproval`) raises a modal and blocks
 * until somebody answers — it was designed for a person at the keyboard, and at
 * 3am there is nobody to answer it. Inheriting that default would mean either
 * commands nobody sanctioned, or a run wedged forever on a modal no one sees.
 *
 * So the unattended case gets a deliberate answer: it refuses, up front, naming
 * the steps. These tests pin that down in both directions — including the case
 * that would otherwise be the quiet disaster, a recipe that is HALF safe.
 */

import { describe, expect, it } from 'vitest';
import { decideFlowAdmission, UNATTENDED_SAFE_STEP_TYPES } from '../admission';
import type { FlowRecipe, FlowRecipeStep } from '../types';

const task: FlowRecipeStep = {
    type: 'task',
    id: 'move',
    title: 'Move it',
    run: async () => {},
};
const terminal: FlowRecipeStep = {
    type: 'terminal',
    id: 'sh',
    title: 'Run something',
    command: 'rm',
    args: ['-rf', 'build'],
};
const form: FlowRecipeStep = {
    type: 'form',
    id: 'ask',
    title: 'Which one?',
    fields: [{ key: 'name', label: 'Name' }],
};
const choice: FlowRecipeStep = {
    type: 'choice',
    id: 'pick',
    title: 'Pick',
    options: [{ value: 'a', label: 'A' }],
};
const browser: FlowRecipeStep = {
    type: 'browser',
    id: 'open',
    title: 'Open',
    url: 'https://example.test',
};

function recipe(...steps: FlowRecipe['steps']): FlowRecipe {
    return { id: 'r', title: 'Recipe', steps };
}

describe('an unattended run', () => {
    it('admits a recipe whose every step is first-party code', () => {
        const decision = decideFlowAdmission(recipe(task), 'unattended');
        expect(decision.ok).toBe(true);
        expect(decision.refusals).toEqual([]);
    });

    it('REFUSES a terminal step, and names it', () => {
        const decision = decideFlowAdmission(recipe(terminal), 'unattended');
        expect(decision.ok).toBe(false);
        expect(decision.refusals).toHaveLength(1);
        expect(decision.refusals[0].stepId).toBe('sh');
        expect(decision.refusals[0].stepType).toBe('terminal');
        expect(decision.refusals[0].reason).toMatch(/no human/i);
    });

    it('refuses steps that need a person to answer them, rather than hanging on one', () => {
        for (const step of [form, choice]) {
            const decision = decideFlowAdmission(recipe(step), 'unattended');
            expect(decision.ok, `${step.type} should be refused unattended`).toBe(false);
            expect(decision.refusals[0].stepType).toBe(step.type);
        }
    });

    it('refuses a browser step — nobody is at the machine it would open on', () => {
        const decision = decideFlowAdmission(recipe(browser), 'unattended');
        expect(decision.ok).toBe(false);
        expect(decision.refusals[0].stepType).toBe('browser');
    });

    it('refuses the WHOLE recipe when only one step is unsafe, before anything runs', () => {
        // The quiet disaster this prevents: running the safe steps, refusing at
        // the shell, and reporting a permission error for a job that already did
        // half its work. `main/apps/flows/runner.ts` states the same rule for graphs.
        const decision = decideFlowAdmission(recipe(task, terminal, task), 'unattended');
        expect(decision.ok).toBe(false);
        expect(decision.refusals.map((r) => r.stepId)).toEqual(['sh']);
    });

    it('names every unsafe step, not just the first', () => {
        const decision = decideFlowAdmission(recipe(terminal, form, task), 'unattended');
        expect(decision.refusals.map((r) => r.stepId)).toEqual(['sh', 'ask']);
    });
});

describe('an attended run', () => {
    it('admits every step type — a person is watching, and the existing approval gates apply', () => {
        // POSITIVE CONTROL for the refusals above: they are about the ABSENCE of
        // a human, not about the step types being forbidden outright. Without
        // this, an admission function that refused everything would pass.
        const decision = decideFlowAdmission(
            recipe(task, terminal, form, choice, browser),
            'attended',
        );
        expect(decision.ok).toBe(true);
        expect(decision.refusals).toEqual([]);
    });
});

describe('the unattended-safe set', () => {
    it('is `task` and nothing else', () => {
        // Stated as a test because widening it is the single change in this
        // feature that could let a system trigger run arbitrary commands.
        expect([...UNATTENDED_SAFE_STEP_TYPES]).toEqual(['task']);
    });

    it('refuses a step type it has never heard of', () => {
        // Fail closed: a step kind added later is unsafe until someone decides
        // it is safe, rather than safe until someone remembers to say otherwise.
        const strange = { type: 'teleport', id: 'x', title: 'Teleport' } as unknown as
            FlowRecipe['steps'][number];
        const decision = decideFlowAdmission(recipe(strange), 'unattended');
        expect(decision.ok).toBe(false);
        expect(decision.refusals[0].stepType).toBe('teleport');
    });
});

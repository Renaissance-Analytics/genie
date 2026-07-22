import { describe, it, expect } from 'vitest';
import { demoRecipe } from '../demo';
import { RecipeEngine } from '../engine';
import type { RecipeStep } from '../types';

describe('demoRecipe', () => {
    it('exercises every step type', () => {
        const types = new Set(demoRecipe.steps.map((s: RecipeStep) => s.type));
        expect(types).toEqual(new Set(['form', 'choice', 'terminal', 'browser', 'task']));
    });

    it('drives the engine from first step to completion via per-step success', () => {
        const e = new RecipeEngine(demoRecipe);
        // Each step succeeds and we advance, exactly as the WizardModal will do
        // when the step components report their effects done.
        for (let i = 0; i < demoRecipe.steps.length - 1; i++) {
            e.markSuccess();
            expect(e.next()).toBe(true);
        }
        expect(e.isLastStep).toBe(true);
        e.markSuccess();
        expect(e.complete()).toBe(true);
        expect(e.isComplete).toBe(true);
    });

    it('runs onComplete against the engine context', async () => {
        const e = new RecipeEngine(demoRecipe);
        const ctx = e.buildContext((() => ({})) as never);
        await demoRecipe.onComplete?.(ctx);
        expect(e.get('demoCompleted')).toBe(true);
    });
});

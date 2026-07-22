import { describe, it, expect, vi } from 'vitest';
import {
    RecipeEngine,
    evaluateTerminalUntil,
    captureTerminalOutput,
} from '../engine';
import type { Recipe, RecipeStep } from '../types';

/** A three-step recipe used across the transition/gating tests. */
function makeRecipe(overrides?: Partial<Recipe>): Recipe {
    const steps: RecipeStep[] = [
        { type: 'choice', id: 'agent', title: 'Pick agent', options: [{ value: 'claude', label: 'Claude' }] },
        { type: 'task', id: 'persist', title: 'Persist', run: async () => {} },
        { type: 'terminal', id: 'auth', title: 'Auth', command: 'gh', args: ['auth', 'status'] },
    ];
    return { id: 'demo', title: 'Demo', steps, ...overrides };
}

describe('RecipeEngine — construction', () => {
    it('starts on step 0 with the first step active and the rest idle', () => {
        const e = new RecipeEngine(makeRecipe());
        expect(e.index).toBe(0);
        expect(e.currentStep.id).toBe('agent');
        expect(e.stepStates).toEqual(['active', 'idle', 'idle']);
        expect(e.isComplete).toBe(false);
        expect(e.isLastStep).toBe(false);
    });

    it('rejects a recipe with no steps', () => {
        expect(() => new RecipeEngine(makeRecipe({ steps: [] }))).toThrow();
    });

    it('seeds the context from initialData', () => {
        const e = new RecipeEngine(makeRecipe(), { initialData: { seed: 42 } });
        expect(e.get('seed')).toBe(42);
    });
});

describe('RecipeEngine — forward gating', () => {
    it('will not advance while the current step is unsatisfied', () => {
        const e = new RecipeEngine(makeRecipe());
        expect(e.canAdvance()).toBe(false);
        expect(e.next()).toBe(false);
        expect(e.index).toBe(0);
    });

    it('advances only after the current step is marked success', () => {
        const e = new RecipeEngine(makeRecipe());
        e.markSuccess();
        expect(e.canAdvance()).toBe(true);
        expect(e.next()).toBe(true);
        expect(e.index).toBe(1);
        // The newly-entered step becomes active, not idle.
        expect(e.stepStates[1]).toBe('active');
    });

    it('stays locked while the current step is running', () => {
        const e = new RecipeEngine(makeRecipe());
        e.markRunning();
        expect(e.stepStates[0]).toBe('running');
        expect(e.canAdvance()).toBe(false);
        expect(e.next()).toBe(false);
    });
});

describe('RecipeEngine — back is always allowed', () => {
    it('goes back without gating and preserves the prior step success', () => {
        const e = new RecipeEngine(makeRecipe());
        e.markSuccess();
        e.next(); // now on step 1
        expect(e.index).toBe(1);
        expect(e.back()).toBe(true);
        expect(e.index).toBe(0);
        // Step 0 keeps its success so a forward hop is instant again.
        expect(e.stepStates[0]).toBe('success');
        expect(e.canAdvance()).toBe(true);
    });

    it('cannot go back past the first step', () => {
        const e = new RecipeEngine(makeRecipe());
        expect(e.back()).toBe(false);
        expect(e.index).toBe(0);
    });
});

describe('RecipeEngine — goTo gating', () => {
    it('allows jumping backward freely', () => {
        const e = new RecipeEngine(makeRecipe());
        e.markSuccess(); e.next();
        e.markSuccess(); e.next(); // on step 2
        expect(e.index).toBe(2);
        expect(e.canGoTo(0)).toBe(true);
        expect(e.goTo(0)).toBe(true);
        expect(e.index).toBe(0);
    });

    it('refuses to jump forward across an unsatisfied step', () => {
        const e = new RecipeEngine(makeRecipe());
        expect(e.canGoTo(2)).toBe(false);
        expect(e.goTo(2)).toBe(false);
        expect(e.index).toBe(0);
    });

    it('allows a forward jump once every intervening step is success', () => {
        const e = new RecipeEngine(makeRecipe());
        e.markSuccess();          // step 0 success
        e.next();
        e.markSuccess();          // step 1 success
        e.goTo(0);                // hop back
        expect(e.canGoTo(2)).toBe(true);
        expect(e.goTo(2)).toBe(true);
        expect(e.index).toBe(2);
    });

    it('rejects out-of-range targets', () => {
        const e = new RecipeEngine(makeRecipe());
        expect(e.canGoTo(-1)).toBe(false);
        expect(e.canGoTo(99)).toBe(false);
    });
});

describe('RecipeEngine — context get/set + capture', () => {
    it('shares state through get/set', () => {
        const e = new RecipeEngine(makeRecipe());
        e.set('token', 'abc');
        expect(e.get('token')).toBe('abc');
    });

    it('writes a captured value into the context on success', () => {
        const e = new RecipeEngine(makeRecipe());
        e.markSuccess(undefined, { key: 'login', value: 'octocat' });
        expect(e.get('login')).toBe('octocat');
    });

    it('buildContext exposes get/set, the api accessor, and scope', () => {
        const fakeApi = (() => ({})) as never;
        const e = new RecipeEngine(makeRecipe(), { workspaceId: 'ws1', workstationId: 'host1' });
        const ctx = e.buildContext(fakeApi);
        ctx.set('k', 1);
        expect(ctx.get('k')).toBe(1);
        expect(e.get('k')).toBe(1); // same underlying store
        expect(ctx.api).toBe(fakeApi);
        expect(ctx.workspaceId).toBe('ws1');
        expect(ctx.workstationId).toBe('host1');
    });
});

describe('RecipeEngine — error surfacing', () => {
    it('records an error message and keeps forward locked', () => {
        const e = new RecipeEngine(makeRecipe());
        e.markError(undefined, 'gh auth failed');
        expect(e.stepStates[0]).toBe('error');
        expect(e.errorOf(0)).toBe('gh auth failed');
        expect(e.canAdvance()).toBe(false);
    });

    it('clears the error when the step is re-run', () => {
        const e = new RecipeEngine(makeRecipe());
        e.markError(undefined, 'boom');
        e.markRunning();
        expect(e.stepStates[0]).toBe('running');
        expect(e.errorOf(0)).toBeNull();
    });

    it('addresses a step by id', () => {
        const e = new RecipeEngine(makeRecipe());
        e.markError('agent', 'bad');
        expect(e.errorOf('agent')).toBe('bad');
        expect(e.stateOf('agent')).toBe('error');
    });
});

describe('RecipeEngine — completion', () => {
    it('completes only from the last step once it is success', () => {
        const e = new RecipeEngine(makeRecipe());
        expect(e.complete()).toBe(false); // not on last step
        e.markSuccess(); e.next();
        e.markSuccess(); e.next(); // now on last step, active
        expect(e.isLastStep).toBe(true);
        expect(e.complete()).toBe(false); // last step not yet success
        e.markSuccess();
        expect(e.complete()).toBe(true);
        expect(e.isComplete).toBe(true);
    });
});

describe('RecipeEngine — subscription', () => {
    it('notifies subscribers on mutation and returns a stable snapshot otherwise', () => {
        const e = new RecipeEngine(makeRecipe());
        const listener = vi.fn();
        const unsub = e.subscribe(listener);
        const before = e.getSnapshot();
        expect(e.getSnapshot()).toBe(before); // stable while unchanged
        e.set('x', 1);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(e.getSnapshot()).not.toBe(before); // new reference after change
        unsub();
        e.set('y', 2);
        expect(listener).toHaveBeenCalledTimes(1); // no longer notified
    });
});

describe('evaluateTerminalUntil — pure', () => {
    it('defaults to exit-0 success / non-zero fail', () => {
        expect(evaluateTerminalUntil(undefined, { exitCode: 0 })).toBe('success');
        expect(evaluateTerminalUntil(undefined, { exitCode: 1 })).toBe('fail');
    });

    it('is pending while the process is still running', () => {
        expect(evaluateTerminalUntil(undefined, { output: 'working…' })).toBe('pending');
        expect(evaluateTerminalUntil(undefined, {})).toBe('pending');
    });

    it('matches an explicit exit code', () => {
        expect(evaluateTerminalUntil({ exit: 3 }, { exitCode: 3 })).toBe('success');
        expect(evaluateTerminalUntil({ exit: 3 }, { exitCode: 0 })).toBe('fail');
    });

    it('succeeds on an output pattern even before exit', () => {
        expect(
            evaluateTerminalUntil({ pattern: 'Logged in' }, { output: 'you are Logged in now' }),
        ).toBe('success');
        expect(
            evaluateTerminalUntil({ pattern: 'Logged in' }, { output: 'still waiting' }),
        ).toBe('pending');
    });

    it('fails if the process exits without ever matching a required pattern', () => {
        expect(
            evaluateTerminalUntil({ pattern: 'Logged in' }, { exitCode: 0, output: 'nope' }),
        ).toBe('fail');
    });
});

describe('captureTerminalOutput — pure', () => {
    it('captures the first group when the pattern has one', () => {
        expect(captureTerminalOutput({ pattern: 'code: (\\w+)' }, 'your code: AB12 ok')).toBe('AB12');
    });

    it('falls back to the trimmed full output', () => {
        expect(captureTerminalOutput(undefined, '  hello world \n')).toBe('hello world');
        expect(captureTerminalOutput({ pattern: 'no-group-here' }, '  raw \n')).toBe('raw');
    });
});

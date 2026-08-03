import { describe, expect, it } from 'vitest';
import { interpolateTemplate, resolveTerminalStep } from '../engine';
import type { RecipeContext, TerminalStepSpec } from '../types';

/**
 * Recipe terminal steps substitute `{{key}}` placeholders from the recipe context
 * (the values collected by preceding form steps) into the command + args at spawn
 * time. This is what lets a plugin recipe run `git commit -m {{message}}` with the
 * message the user typed in the wizard. Because args are handed to the pty as an
 * ARGV array (never concatenated into a shell string), a substituted value with
 * spaces stays exactly one argument — no quoting, no shell-injection surface.
 */

/** A minimal RecipeContext backed by a plain map (only `get` is exercised). */
function ctxOf(data: Record<string, unknown>): Pick<RecipeContext, 'get'> {
    return { get: (k) => data[k] };
}

describe('interpolateTemplate', () => {
    it('substitutes a known key', () => {
        expect(interpolateTemplate('feat/{{name}}', ctxOf({ name: 'thing' }))).toBe('feat/thing');
    });

    it('tolerates surrounding whitespace in the placeholder', () => {
        expect(interpolateTemplate('{{ name }}', ctxOf({ name: 'x' }))).toBe('x');
    });

    it('renders an unknown or nullish key as an empty string (never "undefined")', () => {
        expect(interpolateTemplate('a{{missing}}b', ctxOf({}))).toBe('ab');
        expect(interpolateTemplate('{{n}}', ctxOf({ n: null }))).toBe('');
    });

    it('leaves a plain string with no placeholder untouched', () => {
        expect(interpolateTemplate('git status', ctxOf({}))).toBe('git status');
    });
});

describe('resolveTerminalStep', () => {
    const commit: TerminalStepSpec = {
        type: 'terminal',
        id: 'run',
        title: 'git commit',
        command: 'git',
        args: ['commit', '-m', '{{message}}'],
    };

    it('interpolates command + args from the context', () => {
        const { command, args } = resolveTerminalStep(commit, ctxOf({ message: 'fix the bug' }));
        expect(command).toBe('git');
        expect(args).toEqual(['commit', '-m', 'fix the bug']);
    });

    it('keeps a value with spaces as a SINGLE argv element (argv, not a shell string)', () => {
        const { args } = resolveTerminalStep(commit, ctxOf({ message: 'a b c' }));
        expect(args).toHaveLength(3);
        expect(args[2]).toBe('a b c');
    });

    it('handles a step with no args', () => {
        const step: TerminalStepSpec = { type: 'terminal', id: 'r', title: 't', command: 'git' };
        expect(resolveTerminalStep(step, ctxOf({}))).toEqual({ command: 'git', args: [] });
    });
});

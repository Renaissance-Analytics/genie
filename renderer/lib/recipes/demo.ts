import type { Recipe } from './types';

/**
 * A tiny built-in recipe that exercises EVERY step type end to end, used to
 * validate the RecipeEngine and each WizardModal step component:
 *
 *  - `form`     — collect a free-text value into the context.
 *  - `choice`   — pick one option, written under the step id.
 *  - `terminal` — run a trivial `echo` that exits 0 (default until = exit 0),
 *                 capturing its output into the context.
 *  - `browser`  — open a harmless URL, then a trivial `check` that resolves
 *                 true immediately.
 *  - `task`     — an async task that reads earlier context and writes a result.
 *
 * It has no side effects beyond opening example.com in the browser, so it is
 * safe to launch anywhere the framework is wired up.
 */
export const demoRecipe: Recipe = {
    id: 'demo',
    title: 'Framework demo',
    steps: [
        {
            type: 'form',
            id: 'about-you',
            title: 'About you',
            fields: [
                {
                    key: 'name',
                    label: 'Your name',
                    placeholder: 'Ada',
                    description: 'Stored in the recipe context under "name".',
                    required: true,
                },
            ],
        },
        {
            type: 'choice',
            id: 'favourite-colour',
            title: 'Pick a colour',
            options: [
                { value: 'blue', label: 'Blue' },
                { value: 'green', label: 'Green' },
                { value: 'violet', label: 'Violet' },
            ],
        },
        {
            type: 'terminal',
            id: 'echo',
            title: 'Run a command',
            command: 'echo',
            args: ['hi'],
            // No `until` → advance on exit 0. Capture the output for the task step.
            capture: 'echoOutput',
        },
        {
            type: 'browser',
            id: 'open-page',
            title: 'Open a page',
            url: 'https://example.com/',
            // Trivial check — resolves true straight away.
            check: async () => true,
            pollMs: 500,
        },
        {
            type: 'task',
            id: 'finish',
            title: 'Wrap up',
            run: async (ctx) => {
                const name = String(ctx.get('name') ?? 'friend');
                const colour = String(ctx.get('favourite-colour') ?? 'blue');
                ctx.set('summary', `${name} likes ${colour}`);
            },
        },
    ],
    onComplete: (ctx) => {
        ctx.set('demoCompleted', true);
    },
};

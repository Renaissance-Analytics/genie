import { describe, expect, it } from 'vitest';
import { validateAppManifest } from '../manifest';
import type { GenieAppManifest } from '../../../packages/app-sdk/src/types';

/**
 * The SDK's authored shape, against the validator that actually decides (#250).
 *
 * `GenieAppManifest` is what a developer writes their `gapp.json` against.
 * Genie's own `validateAppManifest` is what accepts or refuses it. Nothing bound
 * the two together, and they had already drifted: `panels` and `tabs` shipped in
 * the validator months ago and never reached the SDK, so an author typing against
 * the SDK could not express a manifest Genie accepts — and would find out from a
 * type error on a field the docs told them to use.
 *
 * This test is BOTH halves at once, which is the only reason it catches that:
 *
 *   - `npm run typecheck:main` fails if the SDK type cannot EXPRESS this manifest.
 *   - `npm test` fails if the validator will not ACCEPT it.
 *
 * So a field added to one side and not the other breaks the build, rather than
 * waiting for a developer to hit it.
 */

/** Every field a GApp author can write, exercised at once. */
const authored: GenieAppManifest = {
    id: 'com.example.trader',
    slug: 'trader',
    name: 'Example Trader',
    version: '1.0.0',
    description: 'Everything the SDK lets an author declare.',
    frontend: {
        repo: 'desktop',
        serve: { mode: 'static', root: 'dist', spa: true },
        browserExposed: true,
    },
    services: [{ name: 'api', repo: 'backend', command: ['uvicorn', 'app:api'], port: 8000 }],
    requires: [{ tool: 'python', version: '3.12', reason: 'runs the strategy sandbox' }],
    panels: { agents: 2, kinds: ['terminal', 'files'] },
    tabs: [{ title: 'Board', path: '/board' }],
    agents: [
        { name: 'Strategist', persona: 'strategist.md', description: 'Designs trades.' },
        { name: 'Reviewer', persona: 'reviewer/persona.md' },
    ],
    contributes: {
        mcpTools: [
            {
                name: 'renderVideo',
                description: 'Render a composition to an mp4.',
                inputSchema: { type: 'object', properties: { composition: { type: 'string' } } },
            },
        ],
        servedBy: 'api',
        transport: { kind: 'stdio' },
    },
    permissions: {
        scope: 'workspaces',
        workspaces: ['ws-research'],
        capabilities: ['hosting', 'knowledge'],
        consumers: { scope: 'workstation' },
    },
};

describe('what the SDK says you may write', () => {
    it('is accepted by the validator that decides at install', () => {
        const result = validateAppManifest(authored);

        expect(result.ok, result.ok ? '' : result.errors.join('; ')).toBe(true);
    });

    it('survives the round trip through JSON, which is how it actually arrives', () => {
        // A manifest reaches Genie as a file, never as an object. A type that only
        // works in memory would be a type that does not describe `gapp.json`.
        const result = validateAppManifest(JSON.parse(JSON.stringify(authored)));

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.agents?.map((a) => a.name)).toEqual(['Strategist', 'Reviewer']);
        expect(result.value.panels.agents).toBe(2);
        expect(result.value.tabs?.[0]?.title).toBe('Board');
        // The capability provider has to survive the same round trip. This is the
        // half the finding actually broke on: a manifest whose provider block was
        // accepted, dropped, and never reached the runtime.
        expect(result.value.contributes?.mcpTools[0]?.name).toBe('renderVideo');
        expect(result.value.permissions.consumers).toEqual({ scope: 'workstation' });
    });
});

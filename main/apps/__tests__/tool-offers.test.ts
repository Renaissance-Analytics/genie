import { describe, expect, it } from 'vitest';
import { decideToolOffer, offeredToolsFor, type AppToolOffer } from '../tool-offers';

/**
 * PURE. May THIS caller invoke a tool that GApp offers? (capability-provider
 * finding, 2026-08-24.)
 *
 * This is the inverse of `scope.ts`. That module answers "may this app act on that
 * workspace?" — a grant the user makes TO the app. This one answers "may that
 * workspace's agents spend this app's compute?" — a grant the user makes ABOUT it.
 * They are separate questions with separate answers, and an app is routinely
 * `scope: self` while being callable from everywhere.
 *
 * Kept pure and beside its sibling for the same reason `decideAppTarget` is: one
 * chokepoint for "may this caller do this", so a provider tool cannot end up on a
 * second, laxer path. Fail-closed at every edge.
 */

const offer = (over: Partial<AppToolOffer> = {}): AppToolOffer => ({
    appId: 'com.example.remotion',
    slug: 'remotion',
    appWorkspaceId: 'remotion-ws',
    consumers: { scope: 'workstation' },
    tools: [{ name: 'renderVideo', description: 'Render a composition.', inputSchema: { type: 'object' } }],
    ...over,
});

describe('who may spend a provider app’s compute', () => {
    it('lets the app’s OWN workspace call its tools, whatever the offer says', () => {
        // An app offering nothing outward still runs its own tools for its own
        // agents. That is not a grant anybody has to make.
        const decision = decideToolOffer(offer({ consumers: { scope: 'self' } }), 'remotion-ws');

        expect(decision.allowed).toBe(true);
        expect(decision.via).toBe('self');
    });

    it('lets any workspace call when the offer is workstation-wide', () => {
        const decision = decideToolOffer(offer(), 'some-other-workspace');

        expect(decision.allowed).toBe(true);
        expect(decision.via).toBe('workstation');
    });

    it('REFUSES another workspace when the offer is `self`', () => {
        const decision = decideToolOffer(offer({ consumers: { scope: 'self' } }), 'tynn.ai');

        expect(decision.allowed).toBe(false);
        expect(decision.via).toBe('denied');
        // The refusal has to say what to do about it — this is a grant the user
        // can change, not a wall.
        expect(decision.reason).toMatch(/install|permissions/i);
    });

    it('honours a named allow-list, and refuses everything off it', () => {
        const limited = offer({ consumers: { scope: 'workspaces', workspaces: ['tynn.ai'] } });

        expect(decideToolOffer(limited, 'tynn.ai').allowed).toBe(true);
        expect(decideToolOffer(limited, 'somebody-else').allowed).toBe(false);
    });

    it('treats an EMPTY allow-list as nobody, never as everybody', () => {
        const empty = offer({ consumers: { scope: 'workspaces', workspaces: [] } });
        expect(decideToolOffer(empty, 'tynn.ai').allowed).toBe(false);
    });

    it('refuses a revoked app outright', () => {
        // Revocation has to beat every other answer, including the app's own
        // workspace — a revoked app is one the user has switched off.
        const revoked = offer({ revoked: true });
        expect(decideToolOffer(revoked, 'remotion-ws').allowed).toBe(false);
        expect(decideToolOffer(revoked, 'anywhere').allowed).toBe(false);
    });

    it('refuses a caller with no workspace at all', () => {
        // Not "unknown, so probably fine". There is nothing to check the grant
        // against, so there is nothing that permits the call.
        for (const caller of [undefined, '', '   ']) {
            expect(decideToolOffer(offer(), caller).allowed, String(caller)).toBe(false);
        }
    });

    it('refuses an unrecognised consumer scope rather than falling through to allow', () => {
        const weird = offer({ consumers: { scope: 'everyone' as never } });
        expect(decideToolOffer(weird, 'tynn.ai').allowed).toBe(false);
    });

    it('refuses an app that has no workspace of its own', () => {
        // Same edge `decideAppTarget` closes: nothing to be scoped relative to
        // means no authority to extend.
        const homeless = offer({ appWorkspaceId: null });
        expect(decideToolOffer(homeless, 'tynn.ai').allowed).toBe(false);
    });
});

/**
 * Discovery. What an agent in a given workspace SEES in `tools/list`.
 *
 * The list is filtered by the same decision that gates the call, from the same
 * function — a tool a caller may not invoke must not appear in their tool list
 * either. A tool an agent can see and cannot call is a tool it will keep trying.
 */
describe('what a calling agent discovers', () => {
    it('lists an offered tool NAMESPACED by the app’s slug', () => {
        const listed = offeredToolsFor([offer()], 'tynn.ai');

        expect(listed.map((t) => t.name)).toEqual(['remotion.renderVideo']);
        expect(listed[0]?.description).toContain('Render a composition.');
        expect(listed[0]?.inputSchema).toEqual({ type: 'object' });
    });

    it('hides the tools of an app that did not offer them to this caller', () => {
        const listed = offeredToolsFor([offer({ consumers: { scope: 'self' } })], 'tynn.ai');
        expect(listed).toEqual([]);

        // The positive control: the same app, asked from its OWN workspace, still
        // offers its tool. A filter that returned nothing at all would pass the
        // assertion above while breaking every provider.
        expect(offeredToolsFor([offer({ consumers: { scope: 'self' } })], 'remotion-ws')).toHaveLength(1);
    });

    it('keeps one app’s failure from removing another’s tools', () => {
        // Fail-closed per app, not per list: the same contract `pluginTools`
        // already keeps, so a bad provider can never take a good one's tools out
        // of an agent's surface.
        const broken = offer({ appId: 'com.example.broken', slug: 'broken', tools: null as never });
        const listed = offeredToolsFor([broken, offer()], 'tynn.ai');

        expect(listed.map((t) => t.name)).toEqual(['remotion.renderVideo']);
    });
});

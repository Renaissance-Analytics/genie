import { describe, expect, it } from 'vitest';
import { importedAgentsOffer } from '../imported-agents';
import type { AgentRosterEntry } from '../ams-grid';

/**
 * WHAT AN IMPORT BRINGS, and whether it is worth stopping for (genie#459).
 *
 * The owner's words: *"If I import a project from tynn I need to be able to get
 * an agent I've already created going, I should not have to create a new one."*
 * The agents ARE there — `.agents/<slug>/AGENT.md` travels with the repo — but
 * `workspace_agents` lives only in the local `genie.db`, so a project cloned onto
 * a machine arrives with every agent on disk and none registered.
 *
 * This is the decision the import flow reads: is there anything here the human
 * should be told about before the modal closes, and what is it. Pure, so both
 * halves — "stop and offer" and "say nothing" — are assertable without a window.
 */

const entry = (over: Partial<AgentRosterEntry> & { name: string }): AgentRosterEntry => ({
    registered: false,
    onDisk: true,
    purpose: 'does a thing',
    tuis: [],
    scope: null,
    running: false,
    ...over,
});

describe('what an imported workspace has to offer', () => {
    it('offers the files the registry has never heard of', () => {
        const offer = importedAgentsOffer([
            entry({ name: 'trader', purpose: 'Trader — the operator' }),
            entry({ name: 'twenty', purpose: 'Runs the twenty build' }),
        ]);

        expect(offer.offer).toBe(true);
        expect(offer.adoptable.map((e) => e.name)).toEqual(['trader', 'twenty']);
        expect(offer.registered).toEqual([]);
        // The headline COUNTS, because "some agents" is the same sentence
        // whether the import brought two or none.
        expect(offer.headline).toContain('2 agents');
    });

    /**
     * NOTHING TO SAY is the other half, and it has to be said explicitly: an
     * import that offers a step listing nothing is worse than one that closes.
     */
    it('says nothing when every agent the project has is already registered', () => {
        const offer = importedAgentsOffer([
            entry({ name: 'twenty', registered: true, agentId: 'a1', role: 'workspace' }),
        ]);

        expect(offer.offer).toBe(false);
        expect(offer.adoptable).toEqual([]);
        // POSITIVE CONTROL: it did read the roster. "No offer" must not be
        // reachable by the function simply losing the entries.
        expect(offer.registered.map((e) => e.name)).toEqual(['twenty']);
        // The line somebody reads right after adopting the last one — the step
        // stays open there, so it must say something true rather than nothing.
        expect(offer.headline).toBe('Every agent this project carries is registered here.');
    });

    it('says nothing about a workspace with no agents at all', () => {
        expect(importedAgentsOffer([])).toMatchObject({ offer: false, headline: '' });
    });

    /**
     * A file Genie REFUSES to adopt still stops the flow. Skipping it silently
     * is how the human concludes the import brought nothing — the failure this
     * issue is about — when in fact it brought a folder that needs renaming.
     */
    it('stops for a file it cannot adopt, and keeps the reason', () => {
        const offer = importedAgentsOffer([
            entry({ name: 'My Agent', refusal: 'The folder `.agents/My Agent` is not a name Genie can register' }),
        ]);

        expect(offer.offer).toBe(true);
        expect(offer.adoptable).toEqual([]);
        expect(offer.refused.map((e) => e.name)).toEqual(['My Agent']);
        expect(offer.headline).toContain('1 agent');
    });

    /**
     * The mixed roster an ALREADY-IMPORTED project has: some adopted on a
     * previous visit, some not. It offers, and it offers only the ones with
     * something left to do.
     */
    it('offers only the unregistered half of a mixed roster', () => {
        const offer = importedAgentsOffer([
            entry({ name: 'twenty', registered: true, agentId: 'a1' }),
            entry({ name: 'trader' }),
        ]);

        expect(offer.offer).toBe(true);
        expect(offer.adoptable.map((e) => e.name)).toEqual(['trader']);
        expect(offer.registered.map((e) => e.name)).toEqual(['twenty']);
        expect(offer.headline).toContain('1 agent');
    });

    /**
     * A REGISTERED agent whose file is gone is not an import finding. It is
     * already an agent — the grid shows it, it can be started — and listing it
     * here would be the flow asking the human to act on nothing.
     */
    it('does not stop for a registered agent that has no file', () => {
        expect(
            importedAgentsOffer([entry({ name: 'fileless', registered: true, onDisk: false })]).offer,
        ).toBe(false);
    });
});

import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ImportedAgents } from '../ImportedAgents';
import type { AgentRosterEntry } from '../../lib/ams-grid';

/**
 * THE OFFER AN IMPORT MAKES (genie#459), rendered.
 *
 * An imported project's agents arrive as files with no registration on this
 * machine, and the only thing the workspace showed afterwards was an empty grid
 * whose one affordance is *create an agent* — the act that discards the identity
 * the human asked to keep. This block is what the import shows instead.
 *
 * The renderer test env has no DOM, but the server renderer runs every component
 * function and throws where the browser would. Both outcomes are asserted here:
 * the offer, and the SILENCE — a step that renders an empty list is worse than
 * no step, and "it offered something" passes just as well when the something is
 * blank.
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

function render(roster: AgentRosterEntry[], keepOpen = false): string {
    return renderToStaticMarkup(
        React.createElement(ImportedAgents, { workspaceId: 'ws-1', roster, keepOpen }),
    );
}

describe('the agents an import brings', () => {
    it('lists them, says how many, and offers Adopt on each', () => {
        const html = render([
            entry({ name: 'trader', purpose: 'Trader — the operator' }),
            entry({ name: 'twenty', purpose: 'Runs the twenty build' }),
        ]);

        expect(html).toContain('2 agents');
        expect(html).toContain('roster-adopt-trader');
        expect(html).toContain('roster-adopt-twenty');
        expect(html).toContain('Trader — the operator');
        // The file behind each, so the claim names what it read.
        expect(html).toContain('.agents/trader/AGENT.md');
    });

    /**
     * The other half, and the reason this is a decision rather than a render: a
     * workspace whose agents are all registered has nothing to reattach, and the
     * flow must close exactly as it did before.
     */
    it('renders nothing at all when every agent is already registered', () => {
        const html = render([entry({ name: 'twenty', registered: true, agentId: 'a1' })]);

        expect(html).toBe('');
        // POSITIVE CONTROL: the same component, one entry different, does draw.
        expect(render([entry({ name: 'twenty' })])).not.toBe('');
    });

    it('renders nothing for a workspace with no agent files', () => {
        expect(render([])).toBe('');
        // Not even when the caller asked it to stay open: there is nothing to
        // stay open ABOUT, and a heading over an empty list is the failure this
        // whole decision exists to avoid.
        expect(render([], true)).toBe('');
    });

    /**
     * `keepOpen` is what the import step passes. It exists for the moment the
     * LAST file is adopted: without it the list vanishes exactly when it becomes
     * the only confirmation that the adoption worked.
     */
    it('keeps a fully-registered roster on screen for the caller that asked to stay open', () => {
        const html = render([entry({ name: 'twenty', registered: true, agentId: 'a1' })], true);

        expect(html).toContain('Every agent this project carries is registered here.');
        expect(html).toContain('roster-start-twenty');
        // And it stops claiming there is anything left to adopt.
        expect(html).not.toContain('not registered on this machine');
    });

    /**
     * A file Genie will not adopt is still SHOWN, with the reason where the
     * button would have been. Dropping it is how a human concludes the import
     * brought nothing when it brought a folder that needs renaming.
     */
    it('shows a refused file with its reason and no Adopt button', () => {
        const html = render([
            entry({
                name: 'My Agent',
                refusal: 'The folder `.agents/My Agent` is not a name Genie can register',
            }),
        ]);

        expect(html).toContain('1 agent');
        expect(html).toContain('is not a name Genie can register');
        expect(html).not.toContain('roster-adopt-My Agent');
    });

    /**
     * STARTABLE, which is what the owner actually asked for — "get an agent I've
     * already created going". An agent adopted a moment ago is registered, and a
     * registered agent gets Start right here rather than somewhere else.
     */
    it('offers Start on an agent that is already registered beside one that is not', () => {
        const html = render([
            entry({ name: 'twenty', registered: true, agentId: 'a1', role: 'specialized' }),
            entry({ name: 'trader' }),
        ]);

        expect(html).toContain('roster-start-twenty');
        expect(html).toContain('roster-adopt-trader');
    });
});

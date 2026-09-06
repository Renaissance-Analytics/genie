import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkspaceBroughtAgents } from '../AddWorkspaceModal';
import type { AgentRosterEntry } from '../../lib/ams-grid';
import type { WorkspaceRow } from '../../lib/genie';

/**
 * THE LAST STEP OF AN IMPORT (genie#459) — the screen a real clone reaches.
 *
 * It exists to say the one thing that becomes unsayable the moment the modal
 * closes: the project came with agents, and they are not registered here. After
 * this the human is looking at an empty grid whose only affordance is *create an
 * agent*, which is the act that throws away everything they wanted to keep.
 *
 * Rendered here because the renderer env has no DOM but the server renderer runs
 * every component function and throws where the browser would — and a screen
 * only reachable after a real git clone is exactly the one that must not first
 * be rendered on someone's machine.
 */

const workspace = {
    id: 'proj-orbit',
    project_name: 'Orbit',
    path: 'D:/code/orbit.agi',
} as unknown as WorkspaceRow;

const file = (name: string): AgentRosterEntry => ({
    name,
    registered: false,
    onDisk: true,
    purpose: `${name} does a thing`,
    tuis: [],
    scope: null,
});

describe('the step an import ends on when it brought agents', () => {
    it('names the workspace, where it landed, and offers each agent for adoption', () => {
        const html = renderToStaticMarkup(
            React.createElement(WorkspaceBroughtAgents, {
                workspace,
                roster: [file('trader'), file('twenty')],
                onOpen: () => {},
            }),
        );

        expect(html).toContain('Orbit');
        expect(html).toContain('D:/code/orbit.agi');
        expect(html).toContain('2 agents');
        expect(html).toContain('roster-adopt-trader');
        expect(html).toContain('roster-adopt-twenty');
        // Skipping is a real answer, and the step says where the list lives
        // afterwards rather than making this the only chance.
        expect(html).toContain('Open workspace');
    });

    /**
     * WHERE THE STEP ENDS UP once every file has been adopted. It stays — the
     * list is the only confirmation the adoption worked — but it stops claiming
     * anything is missing, and it still opens the workspace.
     */
    it('keeps the list and says so when nothing is left unregistered', () => {
        const html = renderToStaticMarkup(
            React.createElement(WorkspaceBroughtAgents, {
                workspace,
                roster: [{ ...file('twenty'), registered: true, agentId: 'a1' }],
                onOpen: () => {},
            }),
        );

        expect(html).toContain('Open workspace');
        expect(html).toContain('Every agent this project carries is registered here.');
        expect(html).toContain('roster-start-twenty');
        expect(html).not.toContain('roster-adopt-twenty');
        expect(html).not.toContain('not registered on this machine');
    });
});

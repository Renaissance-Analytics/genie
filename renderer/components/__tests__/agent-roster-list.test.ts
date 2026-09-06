import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentRosterList } from '../Master/WorkspaceSettingsModal';
import type { AgentRosterEntry } from '../../lib/ams-grid';

/**
 * The workspace agent roster, rendered — all four row shapes.
 *
 * An agent is a ROW and a FILE, and either can exist without the other, so this
 * list has four genuinely different states: registered with its file, registered
 * with the file gone, on disk and adoptable, and on disk and refused. The
 * renderer test env has no DOM, but the server renderer runs every component
 * function and throws where the browser would — which is the class of fault an
 * error boundary catches, and the one that had no coverage anywhere in this
 * window before genie#469.
 */

const entry = (over: Partial<AgentRosterEntry> & { name: string }): AgentRosterEntry => ({
    registered: false,
    onDisk: true,
    purpose: 'does a thing',
    tuis: [],
    scope: null,
    ...over,
});

function render(entries: AgentRosterEntry[], busy: string | null = null): string {
    return renderToStaticMarkup(
        React.createElement(AgentRosterList, {
            entries,
            busy,
            onAdopt: () => {},
            onStart: () => {},
        }),
    );
}

describe('the agent roster list', () => {
    it('shows a registered agent with its purpose and the file behind it', () => {
        const html = render([
            entry({
                name: 'ripple-builder',
                registered: true,
                agentId: 'a1',
                purpose: 'Builds The Ripple Effect',
                role: 'specialized',
            }),
        ]);
        expect(html).toContain('ripple-builder');
        expect(html).toContain('Builds The Ripple Effect');
        expect(html).toContain('.agents/ripple-builder/AGENT.md');
        expect(html).toContain('roster-start-ripple-builder');
    });

    it('marks the workspace agent, and marks a registered agent with no file', () => {
        const html = render([
            entry({ name: 'twa', registered: true, role: 'workspace' }),
            entry({ name: 'fileless', registered: true, onDisk: false }),
        ]);
        expect(html).toContain('Workspace agent');
        expect(html).toContain('No file');
        // A claim about the machine, and it names the path it looked for.
        expect(html).toContain('No .agents/fileless/AGENT.md');
    });

    /** The case genie#465 exists for: the file is there, the registry is not. */
    it('offers Adopt for a file the registry has never heard of', () => {
        const html = render([
            entry({ name: 'ripple', purpose: 'Ripple — the director' }),
        ]);
        expect(html).toContain('roster-adopt-ripple');
        expect(html).toContain('Not registered');
        expect(html).toContain('Ripple — the director');
        // The promise the panel makes about the file, in the copy itself.
        expect(html).toMatch(/never rewrites it/i);
    });

    it('shows the REASON instead of a button Genie could not honour', () => {
        const html = render([
            entry({
                name: 'genie',
                refusal: '"genie" is a reserved name and cannot be used for an agent.',
            }),
        ]);
        expect(html).toContain('roster-refusal-genie');
        expect(html).toContain('reserved name');
        // The negative needs the positive control below it, or a list that
        // rendered no buttons at all would satisfy it.
        expect(html).not.toContain('roster-adopt-genie');
    });

    it('still offers Adopt on the rows it can, beside one it cannot', () => {
        const html = render([
            entry({ name: 'genie', refusal: 'reserved' }),
            entry({ name: 'trader' }),
        ]);
        expect(html).not.toContain('roster-adopt-genie');
        expect(html).toContain('roster-adopt-trader');
    });

    it('says so when nothing is registered, rather than rendering an empty box', () => {
        const html = render([entry({ name: 'trader' })]);
        expect(html).toMatch(/No agents are registered here yet/);
        // …and the adoptable one is still offered, which is the whole point of
        // that empty state existing beside a populated list.
        expect(html).toContain('roster-adopt-trader');
    });

    it('names the action in flight on the row it is happening to', () => {
        const html = render([entry({ name: 'trader' })], 'trader');
        expect(html).toContain('Adopting…');
    });
});

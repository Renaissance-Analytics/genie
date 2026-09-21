import { describe, expect, it } from 'vitest';
import { PREVIEW_LOGICAL_WIDTH, emptyWorkspaceView, showsPreview } from '../empty-workspace';
import type { AgentGridRow } from '../ams-grid';

const agent = (over: Partial<AgentGridRow> & { name: string }): AgentGridRow =>
    ({
        kind: 'agent',
        id: `id-${over.name}`,
        purpose: '',
        avatar: null,
        role: 'specialized',
        provider: 'claude',
        tuis: [],
        running: false,
        collisionGroup: null,
        ...over,
    }) as AgentGridRow;

const orphan = (name: string): AgentGridRow =>
    ({ kind: 'orphan', id: name, name, specId: `spec-${name}`, running: false }) as unknown as AgentGridRow;

describe('emptyWorkspaceView', () => {
    it('offers the guide when the workspace has no agents', () => {
        expect(emptyWorkspaceView([])).toEqual({ kind: 'getting-started' });
    });

    it('shows the agents when it has some', () => {
        const view = emptyWorkspaceView([agent({ name: 'tynn' }), agent({ name: 'burndown' })]);
        expect(view.kind).toBe('agents');
        expect(view.kind === 'agents' && view.rows.map((r) => r.name)).toEqual(['tynn', 'burndown']);
    });

    it('treats a workspace of ORPHANS ONLY as having no agents', () => {
        // An orphan is a leftover spec nobody owns. A gallery of debris answers
        // "what is in this workspace" with something the person never put there,
        // and hides the fact that they have not set one up yet.
        expect(emptyWorkspaceView([orphan('stray')])).toEqual({ kind: 'getting-started' });
    });

    it('drops orphans from a grid that also has real agents', () => {
        const view = emptyWorkspaceView([agent({ name: 'tynn' }), orphan('stray')]);
        expect(view.kind === 'agents' && view.rows.map((r) => r.name)).toEqual(['tynn']);
    });
});

describe('showsPreview', () => {
    it('previews a RUNNING agent that has a terminal', () => {
        expect(showsPreview(agent({ name: 'tynn', running: true, specId: 'spec-1' }))).toBe(true);
    });

    it('does NOT preview a dormant agent', () => {
        // A frame around a dead pty implies something is happening in there.
        expect(showsPreview(agent({ name: 'tynn', running: false, specId: 'spec-1' }))).toBe(false);
    });

    it('does NOT preview a running agent with no terminal to show', () => {
        expect(showsPreview(agent({ name: 'tynn', running: true }))).toBe(false);
    });

    it('never previews an orphan', () => {
        expect(showsPreview(orphan('stray'))).toBe(false);
    });
});

describe('PREVIEW_LOGICAL_WIDTH', () => {
    it('is wide enough that a terminal laid out at it is a real terminal', () => {
        // The whole safety argument for previewing a live pty. A terminal
        // measured inside a small frame is genie#229: a TUI told it has almost
        // no columns reflows its scrollback to that width, and the damage is
        // written before the panel ever comes back.
        //
        // 80 columns is the floor for a terminal to mean anything, and a cell is
        // never wider than ~10px at the sizes used here — so this must clear
        // 800px with room to spare, not merely be "a big number".
        expect(PREVIEW_LOGICAL_WIDTH).toBeGreaterThanOrEqual(900);
    });
});

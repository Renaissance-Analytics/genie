import { describe, expect, it } from 'vitest';
import { SYSTEM_WORKSPACE_ID, type WorkspaceRow } from '../genie';
import { feedbackProjectFor, feedbackProjectOptions, feedbackWorkspaceFor } from '../feedback-target';

/**
 * Where the Feedback modal files, and for which workspace (genie#675).
 *
 * Ctrl+Shift+W used to raise the retired quick-capture window, which picked its
 * project from "the most recently opened workspace" — not the one the person was
 * looking at. The hotkey now opens the Feedback modal for the ACTIVE workspace,
 * preselecting that workspace's Tynn project. These pin both halves.
 */

function row(over: Partial<WorkspaceRow>): WorkspaceRow {
    return {
        id: 'ws-1',
        backend: 'tynn',
        project_id: 'PRJ-1',
        project_name: 'One',
        tynn_project_id: 'PRJ-1',
        tynn_project_name: 'One',
        ...over,
    } as WorkspaceRow;
}

describe('feedbackProjectFor — the Tynn project a workspace files into', () => {
    it("is the workspace's linked Tynn project", () => {
        expect(feedbackProjectFor(row({ tynn_project_id: 'PRJ-LINKED', project_id: 'PRJ-LINKED' }))).toBe(
            'PRJ-LINKED',
        );
    });

    it('falls back to project_id when the legacy tynn column is empty', () => {
        expect(feedbackProjectFor(row({ tynn_project_id: '', project_id: 'PRJ-NEW' }))).toBe('PRJ-NEW');
    });

    it('is empty for a `none` workspace, whose id there is a manifest id, never a Tynn project', () => {
        expect(feedbackProjectFor(row({ backend: 'none', tynn_project_id: 'gapp.manifest', project_id: 'gapp.manifest' }))).toBe('');
    });
});

describe('feedbackWorkspaceFor — which workspace the hotkey opens Feedback for', () => {
    const active = row({ id: 'ws-active', tynn_project_id: 'PRJ-ACTIVE' });
    const other = row({ id: 'ws-other', tynn_project_id: 'PRJ-OTHER' });
    const system = row({ id: SYSTEM_WORKSPACE_ID, backend: 'none', tynn_project_id: '', project_id: '' });
    const byId = new Map([active, other, system].map((w) => [w.id, w] as const));

    it('is the active workspace', () => {
        expect(feedbackWorkspaceFor('ws-active', byId)?.id).toBe('ws-active');
        // Control: a different active id picks a different row, so the result is
        // driven by the argument rather than by map order.
        expect(feedbackWorkspaceFor('ws-other', byId)?.id).toBe('ws-other');
    });

    it('is the System workspace when nothing is active', () => {
        expect(feedbackWorkspaceFor(null, byId)?.id).toBe(SYSTEM_WORKSPACE_ID);
    });

    it('is the System workspace when the active id names no row', () => {
        expect(feedbackWorkspaceFor('ws-gone', byId)?.id).toBe(SYSTEM_WORKSPACE_ID);
    });

    it('is null only when there is no row at all to attach the feedback to', () => {
        expect(feedbackWorkspaceFor('ws-active', new Map())).toBeNull();
    });
});

describe('feedbackProjectOptions — the project picker in the Feedback modal', () => {
    const projects = [
        { id: 'PRJ-A', name: 'Alpha' },
        { id: 'PRJ-B', name: 'Beta', isGapp: true },
    ];

    it('lists the projects the person can file into', () => {
        expect(feedbackProjectOptions(projects, 'PRJ-A', 'Alpha')).toEqual([
            { value: 'PRJ-A', label: 'Alpha' },
            { value: 'PRJ-B', label: 'Beta (Genie App)' },
        ]);
    });

    it("keeps the workspace's project as an option while the list has not got it", () => {
        // A native <select> whose value matches no option DISPLAYS the first
        // option — so without this the modal would show "Alpha" while filing to
        // PRJ-LINKED, which is a silent wrong project on screen.
        expect(feedbackProjectOptions(projects, 'PRJ-LINKED', 'Linked Project')).toEqual([
            { value: 'PRJ-LINKED', label: 'Linked Project' },
            { value: 'PRJ-A', label: 'Alpha' },
            { value: 'PRJ-B', label: 'Beta (Genie App)' },
        ]);
        // …and before the list has loaded at all.
        expect(feedbackProjectOptions([], 'PRJ-LINKED', 'Linked Project')).toEqual([
            { value: 'PRJ-LINKED', label: 'Linked Project' },
        ]);
    });

    it('falls back to the id as the label when the workspace has no project name', () => {
        expect(feedbackProjectOptions([], 'PRJ-LINKED', '')).toEqual([{ value: 'PRJ-LINKED', label: 'PRJ-LINKED' }]);
    });

    it('adds nothing when nothing is selected yet', () => {
        expect(feedbackProjectOptions(projects, '', '')).toHaveLength(2);
    });
});

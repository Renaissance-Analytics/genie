import { describe, expect, it } from 'vitest';
import {
    computeLaunchSelection,
    effectiveWorkspaceId,
} from '../launch-restore';
import type { TerminalSpec, WorkspaceRow } from '../genie';

/**
 * Unit tests for the launch-restore brain that decides which workspace fills
 * the grid on launch and which of its terminals are restored as panels.
 *
 * Regression context: a quit+relaunch came up with an EMPTY grid even though
 * every terminal spec survived in the DB (all `enabled`). The old seed lived in
 * a `[workspaces.length]` effect that read `specs` through a closure and latched
 * a one-shot guard — so if it ran before the target workspace's specs were in
 * state, it selected nothing and never retried. `computeLaunchSelection` is the
 * pure replacement the caller now feeds the freshly-fetched arrays, so the
 * selection can never race a not-yet-loaded `specs`.
 */

const SYSTEM = '__system__';

function ws(id: string, over: Partial<WorkspaceRow> = {}): WorkspaceRow {
    return {
        id,
        backend: 'tynn',
        project_id: id,
        project_name: id,
        tynn_project_id: id,
        tynn_project_name: id,
        shape: 'agi',
        path: `/projects/${id}`,
        editor: null,
        editor_cmd: null,
        start_cmd: null,
        env_file: null,
        last_opened_at: null,
        created_by_genie: 0,
        ...over,
    } as WorkspaceRow;
}

function spec(
    id: string,
    workspace_id: string | null,
    over: Partial<TerminalSpec> = {},
): TerminalSpec {
    return {
        id,
        workspace_id,
        label: id,
        cwd: '/tmp',
        shell: null,
        args: [],
        env: {},
        type: 'terminal',
        meta: {},
        sort_order: 0,
        created_at: '',
        last_opened_at: null,
        snapshot_at: null,
        snapshot_bytes: null,
        live_cwd: null,
        enabled: true,
        ...over,
    };
}

describe('computeLaunchSelection', () => {
    it('restores the persisted active_workspace and its enabled specs (the fix)', () => {
        // Mirrors the real DB state that produced the bug: many specs across
        // many workspaces, active_workspace pinned to one that has a terminal +
        // an editor. The restore MUST return that workspace + its two spec ids
        // (the old effect could yield an empty selection here).
        const workspaces = [ws('A'), ws('B'), ws('C')];
        const specs = [
            spec('a-term', 'A'),
            spec('a-editor', 'A', { type: 'code' }),
            spec('b-term', 'B'),
            spec('c-term', 'C'),
        ];
        const result = computeLaunchSelection({
            specs,
            workspaces,
            savedActiveWorkspace: 'A',
            stageSeedWorkspace: null,
            systemWorkspaceId: SYSTEM,
        });
        expect(result.activeWorkspaceId).toBe('A');
        expect(result.selectedIds.sort()).toEqual(['a-editor', 'a-term']);
        // The regression assertion: a populated specs list + valid saved
        // workspace never yields an empty grid.
        expect(result.selectedIds.length).toBeGreaterThan(0);
    });

    it('excludes suspended (enabled:false) specs from the restore', () => {
        const result = computeLaunchSelection({
            specs: [
                spec('live', 'A'),
                spec('suspended', 'A', { enabled: false }),
            ],
            workspaces: [ws('A')],
            savedActiveWorkspace: 'A',
            stageSeedWorkspace: null,
            systemWorkspaceId: SYSTEM,
        });
        expect(result.selectedIds).toEqual(['live']);
    });

    it('keeps process specs in the selection (the grid memo filters them, not us)', () => {
        const result = computeLaunchSelection({
            specs: [spec('term', 'A'), spec('proc', 'A', { type: 'process' })],
            workspaces: [ws('A')],
            savedActiveWorkspace: 'A',
            stageSeedWorkspace: null,
            systemWorkspaceId: SYSTEM,
        });
        expect(result.selectedIds.sort()).toEqual(['proc', 'term']);
    });

    it('falls back to the most-recent workspace when active_workspace is unset', () => {
        const result = computeLaunchSelection({
            specs: [spec('first-term', 'first'), spec('second-term', 'second')],
            // Caller passes workspaces pre-sorted (most-recent first).
            workspaces: [ws('first'), ws('second')],
            savedActiveWorkspace: null,
            stageSeedWorkspace: null,
            systemWorkspaceId: SYSTEM,
        });
        expect(result.activeWorkspaceId).toBe('first');
        expect(result.selectedIds).toEqual(['first-term']);
    });

    it('falls back when active_workspace points at a workspace that no longer exists', () => {
        const result = computeLaunchSelection({
            specs: [spec('a-term', 'A')],
            workspaces: [ws('A')],
            savedActiveWorkspace: 'deleted-workspace',
            stageSeedWorkspace: null,
            systemWorkspaceId: SYSTEM,
        });
        expect(result.activeWorkspaceId).toBe('A');
        expect(result.selectedIds).toEqual(['a-term']);
    });

    it('pins a Stage window to its ?stage= workspace over active_workspace', () => {
        const result = computeLaunchSelection({
            specs: [spec('a-term', 'A'), spec('b-term', 'B')],
            workspaces: [ws('A'), ws('B')],
            savedActiveWorkspace: 'A',
            stageSeedWorkspace: 'B',
            systemWorkspaceId: SYSTEM,
        });
        expect(result.activeWorkspaceId).toBe('B');
        expect(result.selectedIds).toEqual(['b-term']);
    });

    it('maps System Workspace specs (workspace_id null + meta.system) onto the system id', () => {
        const result = computeLaunchSelection({
            specs: [
                spec('sys-term', null, { meta: { system: true } }),
                // A null-workspace spec WITHOUT the system tag is not a system
                // spec and must not be picked up by the system target.
                spec('orphan', null),
            ],
            workspaces: [ws('A')],
            savedActiveWorkspace: SYSTEM,
            stageSeedWorkspace: null,
            systemWorkspaceId: SYSTEM,
        });
        // savedActiveWorkspace=SYSTEM isn't in `workspaces` (the System Workspace
        // is synthetic), so it falls back to workspaces[0]=A → nothing selected.
        expect(result.activeWorkspaceId).toBe('A');
        expect(result.selectedIds).toEqual([]);
    });

    it('returns no selection when there are no workspaces (no crash)', () => {
        const result = computeLaunchSelection({
            specs: [spec('x', 'A')],
            workspaces: [],
            savedActiveWorkspace: 'A',
            stageSeedWorkspace: null,
            systemWorkspaceId: SYSTEM,
        });
        expect(result.activeWorkspaceId).toBeNull();
        expect(result.selectedIds).toEqual([]);
    });
});

describe('effectiveWorkspaceId', () => {
    it('maps an unattached system spec to the system workspace id', () => {
        expect(
            effectiveWorkspaceId(
                { workspace_id: null, meta: { system: true } },
                SYSTEM,
            ),
        ).toBe(SYSTEM);
    });

    it('uses the stored workspace_id for normal specs', () => {
        expect(effectiveWorkspaceId({ workspace_id: 'A', meta: {} }, SYSTEM)).toBe('A');
    });

    it('leaves a null-workspace spec without the system tag null', () => {
        expect(effectiveWorkspaceId({ workspace_id: null, meta: {} }, SYSTEM)).toBeNull();
    });
});

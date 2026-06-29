import { describe, expect, it } from 'vitest';
import { pickReusePanel } from '../editor-open';
import type { TerminalSpec, WorkspaceRow } from '../genie';

/** Minimal spec/row factories — only the fields pickReusePanel reads. */
function spec(p: Partial<TerminalSpec> & { id: string }): TerminalSpec {
    return {
        type: 'code',
        workspace_id: null,
        cwd: '',
        label: p.id,
        ...p,
    } as TerminalSpec;
}
function wsMap(entries: Array<[string, string]>): Map<string, WorkspaceRow> {
    const m = new Map<string, WorkspaceRow>();
    for (const [id, path] of entries) m.set(id, { id, path } as WorkspaceRow);
    return m;
}

describe('pickReusePanel', () => {
    const wsById = wsMap([['ws1', '/ws1']]);

    it('reuses an open code panel for a real workspace (root = workspace path)', () => {
        const specs = [spec({ id: 'c1', type: 'code', workspace_id: 'ws1', cwd: '/ws1' })];
        const id = pickReusePanel(
            specs,
            { workspaceId: 'ws1', root: '/ws1' },
            null,
            new Set(['c1']),
            wsById,
        );
        expect(id).toBe('c1');
    });

    it('opens NEW (null) when no code panel for the workspace is open', () => {
        const specs = [spec({ id: 'c1', type: 'code', workspace_id: 'ws1', cwd: '/ws1' })];
        // not selected → not mounted → cannot reuse
        expect(
            pickReusePanel(specs, { workspaceId: 'ws1', root: '/ws1' }, null, new Set(), wsById),
        ).toBeNull();
    });

    it('reuses a System panel matched by its cwd root', () => {
        const specs = [
            spec({ id: 's1', type: 'code', workspace_id: null, cwd: 'C:/Windows/System32', meta: { system: true } }),
        ];
        const id = pickReusePanel(
            specs,
            { workspaceId: '__system__', root: 'C:/Windows/System32' },
            null,
            new Set(['s1']),
            wsById,
        );
        expect(id).toBe('s1');
    });

    it('does NOT reuse a System panel rooted at a different directory (opens new)', () => {
        const specs = [
            spec({ id: 's1', type: 'code', workspace_id: null, cwd: 'C:/a', meta: { system: true } }),
        ];
        expect(
            pickReusePanel(specs, { workspaceId: '__system__', root: 'C:/b' }, null, new Set(['s1']), wsById),
        ).toBeNull();
    });

    it('prefers the focused panel among multiple matches', () => {
        const specs = [
            spec({ id: 'c1', type: 'code', workspace_id: 'ws1', cwd: '/ws1' }),
            spec({ id: 'c2', type: 'code', workspace_id: 'ws1', cwd: '/ws1' }),
        ];
        const id = pickReusePanel(
            specs,
            { workspaceId: 'ws1', root: '/ws1' },
            'c2',
            new Set(['c1', 'c2']),
            wsById,
        );
        expect(id).toBe('c2');
    });

    it('ignores non-code specs (a terminal never reuses)', () => {
        const specs = [spec({ id: 't1', type: 'terminal', workspace_id: 'ws1', cwd: '/ws1' })];
        expect(
            pickReusePanel(specs, { workspaceId: 'ws1', root: '/ws1' }, null, new Set(['t1']), wsById),
        ).toBeNull();
    });
});

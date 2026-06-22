import { describe, expect, it, vi } from 'vitest';

// buildProcessList is pure (db + supervisor reads are passed in), but the
// module imports db + process-supervisor at load — stub them so importing the
// pure helper doesn't drag electron/the pty backend in.
vi.mock('../../db', () => ({
    listTerminalSpecs: () => [],
    listWorkspaces: () => [],
}));
vi.mock('../process-supervisor', () => ({ getProcessStatuses: () => ({}) }));

import { buildProcessList, SYSTEM_WORKSPACE_LABEL } from '../process-list';
import type { TerminalSpecRow } from '../../db';

/** Minimal process spec for the join. */
function spec(
    id: string,
    workspaceId: string | null,
    label: string,
    command: string,
    type: TerminalSpecRow['type'] = 'process',
    autostart = false,
): TerminalSpecRow {
    return {
        id,
        workspace_id: workspaceId,
        label,
        cwd: '/tmp',
        shell: null,
        args: [],
        env: {},
        type,
        meta: { command, autostart },
        sort_order: 0,
        created_at: '',
        last_opened_at: null,
        snapshot_at: null,
        snapshot_bytes: null,
        live_cwd: null,
        enabled: true,
        host_session_id: null,
    };
}

describe('buildProcessList', () => {
    const names = new Map([
        ['ws-1', 'Tynn'],
        ['ws-2', 'Genie'],
    ]);

    it('joins process specs with workspace name + live status', () => {
        const specs = [
            spec('p1', 'ws-1', 'dev server', 'npm run dev'),
            spec('p2', 'ws-2', 'worker', 'npm run worker'),
        ];
        const rows = buildProcessList(specs, names, { p1: 'running' });
        expect(rows).toEqual([
            {
                id: 'p1',
                label: 'dev server',
                command: 'npm run dev',
                workspace: 'Tynn',
                workspaceId: 'ws-1',
                status: 'running',
                autostart: false,
            },
            {
                id: 'p2',
                label: 'worker',
                command: 'npm run worker',
                workspace: 'Genie',
                workspaceId: 'ws-2',
                status: 'stopped', // no entry → default
                autostart: false,
            },
        ]);
    });

    it('labels a workspace_id-less process as System', () => {
        const rows = buildProcessList([spec('p3', null, 'tunnel', 'ssh -N host')], names, {});
        expect(rows[0].workspace).toBe(SYSTEM_WORKSPACE_LABEL);
        expect(rows[0].workspaceId).toBeNull();
    });

    it('labels a process whose workspace was removed as System (no dangling id)', () => {
        const rows = buildProcessList([spec('p4', 'ws-gone', 'orphan', 'cmd')], names, {});
        expect(rows[0].workspace).toBe(SYSTEM_WORKSPACE_LABEL);
        expect(rows[0].workspaceId).toBe('ws-gone');
    });

    it('excludes terminals and code views — only processes', () => {
        const specs = [
            spec('t1', 'ws-1', 'a terminal', '', 'terminal'),
            spec('c1', 'ws-1', 'a code view', '', 'code'),
            spec('p1', 'ws-1', 'a process', 'run', 'process'),
        ];
        const rows = buildProcessList(specs, names, {});
        expect(rows.map((r) => r.id)).toEqual(['p1']);
    });

    it('carries the autostart flag', () => {
        const rows = buildProcessList(
            [spec('p5', 'ws-1', 'svc', 'run', 'process', true)],
            names,
            {},
        );
        expect(rows[0].autostart).toBe(true);
    });
});

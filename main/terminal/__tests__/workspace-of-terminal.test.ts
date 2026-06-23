import { describe, expect, it, vi } from 'vitest';

// The module imports getTerminalSpec from db at load; stub db so testing the
// pure resolver doesn't drag electron / the real spec store in.
vi.mock('../../db', () => ({ getTerminalSpec: () => null }));

import {
    SYSTEM_WORKSPACE_ID,
    workspaceIdOfSpec,
} from '../workspace-of-terminal';
import type { TerminalSpecRow } from '../../db';

/** Minimal spec for the resolver — only workspace_id + meta matter. */
function spec(
    workspaceId: string | null,
    meta: TerminalSpecRow['meta'] = {},
): TerminalSpecRow {
    return {
        id: 't1',
        workspace_id: workspaceId,
        label: '',
        cwd: '/tmp',
        shell: null,
        args: [],
        env: {},
        type: 'terminal',
        meta,
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

describe('workspaceIdOfSpec', () => {
    it('returns the stored workspace id for a normal spec', () => {
        expect(workspaceIdOfSpec(spec('ws-1'))).toBe('ws-1');
    });

    it('maps a System-Workspace spec (null + meta.system) to the synthetic id', () => {
        expect(workspaceIdOfSpec(spec(null, { system: true }))).toBe(
            SYSTEM_WORKSPACE_ID,
        );
    });

    it('returns null for an unattached spec (no workspace, no system tag)', () => {
        expect(workspaceIdOfSpec(spec(null))).toBeNull();
    });

    it('prefers a stored workspace id even if meta.system is set', () => {
        expect(workspaceIdOfSpec(spec('ws-2', { system: true }))).toBe('ws-2');
    });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { getAllSettings, initDatabase, setSettings } from '../db';
import {
    isWorkspaceCollapsed,
    parseCollapsedWorkspaces,
} from '../../renderer/lib/workspace-collapse';

/**
 * genie#580 — the sidebar must open MINIMISED when the user has recorded no
 * preference, while still honouring a recorded EMPTY list (the user deliberately
 * expanded everything).
 *
 * The renderer can only tell those two apart if main lets "absent" reach it.
 * `getAllSettings()` manufactured `collapsed_workspaces: '[]'` for an unset row —
 * the very value that means "everything expanded" — so the distinction was
 * destroyed one layer below the Chooser and no renderer-side default could ever
 * fire. A defaulted-away absence is why this test is here rather than only in
 * `renderer/lib/__tests__/workspace-collapse.test.ts`.
 */

beforeAll(() => {
    initDatabase(fs.mkdtempSync(path.join(os.tmpdir(), 'collapsed-workspaces-')));
});

describe('collapsed_workspaces default', () => {
    it('is ABSENT on a fresh install — main must not invent a preference', () => {
        expect(getAllSettings().collapsed_workspaces).toBeUndefined();
    });

    it('reaches the sidebar as "nothing recorded", which renders collapsed', () => {
        // The end-to-end claim the owner reported against: a client with nothing
        // saved opens minimised.
        const state = parseCollapsedWorkspaces(getAllSettings().collapsed_workspaces);
        expect(state).toBeNull();
        expect(isWorkspaceCollapsed(state, 'any-workspace')).toBe(true);
    });

    it('round-trips a recorded EMPTY list as everything-expanded, not as absent', () => {
        // The other half of the distinction: once the user has expanded every
        // workspace, that must survive the next launch instead of being read back
        // as "no preference" and re-collapsed.
        setSettings({ collapsed_workspaces: '[]' });
        const state = parseCollapsedWorkspaces(getAllSettings().collapsed_workspaces);
        expect(state).toEqual(new Set());
        expect(isWorkspaceCollapsed(state, 'any-workspace')).toBe(false);
    });

    it('round-trips a recorded list', () => {
        setSettings({ collapsed_workspaces: '["ws1"]' });
        const state = parseCollapsedWorkspaces(getAllSettings().collapsed_workspaces);
        expect(isWorkspaceCollapsed(state, 'ws1')).toBe(true);
        expect(isWorkspaceCollapsed(state, 'ws2')).toBe(false);
    });
});

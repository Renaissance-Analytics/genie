import { describe, expect, it } from 'vitest';
import { processSpecWorkspace, SYSTEM_WORKSPACE_ID } from '../genie';

/**
 * The workspace that OWNS a process spec — the lookup the process context menu's
 * "Edit…" needs. The reported bug: clicking Edit on a global process (e.g.
 * `php artisan reverb:start`) opened NOTHING. A System Workspace process persists
 * UNATTACHED (`workspace_id: null`, `meta.system === true`), so the menu's
 * `workspaces.find(w => w.id === spec.workspace_id)` matched `id === null` — never
 * a real workspace — and the edit was silently swallowed. This resolver mirrors
 * the sidebar's own bucketing so Edit reaches the same workspace the row lives in.
 */

const ws = (id: string) => ({ id, name: id });

describe('processSpecWorkspace — the workspace that owns a process, for editing it', () => {
    it('resolves an ordinary process by its workspace_id', () => {
        const list = [ws('acme'), ws('other')];
        expect(processSpecWorkspace({ workspace_id: 'acme' }, list)).toBe(list[0]);
    });

    it('resolves a SYSTEM process (workspace_id null + meta.system) to the System Workspace', () => {
        // THE bug: a global process persists unattached, so the id lookup found
        // nothing and Edit did nothing. It belongs to the System Workspace row.
        const sys = ws(SYSTEM_WORKSPACE_ID);
        const list = [ws('acme'), sys];
        expect(processSpecWorkspace({ workspace_id: null, meta: { system: true } }, list)).toBe(sys);
    });

    it('returns null when the owning workspace is not present — decline, never mis-target', () => {
        expect(processSpecWorkspace({ workspace_id: 'ghost' }, [ws('acme')])).toBeNull();
        expect(
            processSpecWorkspace({ workspace_id: null, meta: { system: true } }, [ws('acme')]),
        ).toBeNull();
    });

    it('an unattached NON-system spec never grabs the System Workspace', () => {
        // An orphaned spec (null, no system tag) is genuinely unowned — resolving it
        // to the System Workspace would edit the wrong process's home.
        const list = [ws('acme'), ws(SYSTEM_WORKSPACE_ID)];
        expect(processSpecWorkspace({ workspace_id: null }, list)).toBeNull();
    });
});

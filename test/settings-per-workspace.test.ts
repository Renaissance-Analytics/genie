import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentCapFrom } from '../src/core/inbox.js';
import { SettingsStore } from '../src/main/settings-store.js';

/**
 * PER-WORKSPACE SETTINGS (§6.1). A setting registered with `scope: 'workspace'` holds a value PER
 * WORKSPACE: `setFor(workspaceId, key, value)` overrides the workstation-wide value for that workspace
 * only; `snapshotFor(workspaceId)` is the effective view (workspace override, else the workstation value,
 * else the default); `resetFor` drops the override. A host-scoped key cannot be set per workspace — refused,
 * not silently written globally. Persisted beside the other values.
 */

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-settings-ws-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('SettingsStore per workspace', () => {
    it('overrides one workspace only; the effective snapshot layers override → workstation → default; persisted; reset drops it', async () => {
        const s = await SettingsStore.open(dir);
        expect(s.snapshotFor('tynn').agent_cap).toBe('8');
        await s.set('agent_cap', '4');
        expect(s.snapshotFor('tynn').agent_cap).toBe('4');
        await s.setFor('tynn', 'agent_cap', '2');
        expect(s.snapshotFor('tynn').agent_cap).toBe('2');
        expect(s.snapshotFor('fancy').agent_cap).toBe('4');
        expect(s.snapshot().agent_cap).toBe('4');
        expect(agentCapFrom(s.snapshotFor('tynn'))).toBe(2);
        expect(s.workspaceValues('tynn')).toEqual({ agent_cap: '2' });
        expect(s.workspaceValues('fancy')).toEqual({});

        const again = await SettingsStore.open(dir);
        expect(again.snapshotFor('tynn').agent_cap).toBe('2');
        await again.resetFor('tynn', 'agent_cap');
        expect(again.snapshotFor('tynn').agent_cap).toBe('4');
        // Only what the user set is written: with the last override gone, the key is gone too.
        const file = JSON.parse(await readFile(again.file, 'utf8')) as Record<string, unknown>;
        expect(file.agent_cap).toBe('4');
        expect(file).not.toHaveProperty('__workspaces');
    });

    it('refuses a host-scoped key per workspace and an unknown key, and validates the value like set()', async () => {
        const s = await SettingsStore.open(dir);
        await expect(s.setFor('tynn', 'theme', 'dark')).rejects.toThrow(/theme is a workstation setting, not a workspace one/);
        await expect(s.setFor('tynn', 'nope', 'x')).rejects.toThrow(/not a setting Genie knows/);
        await expect(s.setFor('tynn', 'agent_cap', '3')).rejects.toThrow();
        expect(s.workspaceValues('tynn')).toEqual({});
    });

    it('notifies listeners with the workspace id on a per-workspace change', async () => {
        const s = await SettingsStore.open(dir);
        const seen: string[] = [];
        s.onChange((key, value, workspaceId) => { seen.push(`${workspaceId ?? '*'}:${key}=${String(value)}`); });
        await s.setFor('tynn', 'inbox_access', 'all');
        await s.set('inbox_access', 'none');
        expect(seen).toEqual(['tynn:inbox_access=all', '*:inbox_access=none']);
    });
});

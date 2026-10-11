import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentCapFrom, inboxSettingFrom } from '../src/core/inbox.js';
import { SETTINGS } from '../src/core/settings.js';
import { Registry } from '../src/main/registry.js';
import { startRefusal } from '../src/main/workspace-ops-host.js';
import { Store } from '../src/main/store.js';

/**
 * AGENT MODE, ACCESS SCOPE, WORKSPACE CAPS AND INBOX SCOPE (§6.1/§6.2/§6.4). Mode is WORDING for the
 * agent (automated / manual), not a permission boundary — persisted on the record. Access scope is the
 * agent's own half of the two-tier inbox rule. Per workspace: `inbox_access` (the workspace's half) and
 * `agent_cap` — a start past the cap is REFUSED with the number and the setting named, never queued.
 */

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-mode-scope-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('registry: mode and access scope', () => {
    it('default manual / self; set and persisted across a reload; unknown agent → null', async () => {
        const registry = new Registry(new Store(dir));
        await registry.load({ name: 'alphar', healthy: true });
        await registry.addWorkspace({ id: 'tynn', path: '/w/tynn' });
        const a = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        expect(a).toMatchObject({ mode: 'manual', accessScope: 'self' });
        expect(await registry.setMode(a.id, 'automated')).toMatchObject({ mode: 'automated' });
        expect(await registry.setAccessScope(a.id, 'all')).toMatchObject({ accessScope: 'all' });
        expect(await registry.setMode('agent_nope' as never, 'manual')).toBeNull();
        const again = new Registry(new Store(dir));
        await again.load({ name: 'alphar', healthy: true });
        expect(again.find(a.id)).toMatchObject({ mode: 'automated', accessScope: 'all' });
    });
});

describe('workspace settings: inbox_access and agent_cap', () => {
    it('are registered per workspace with closed enums and honest defaults', () => {
        expect(SETTINGS.find((s) => s.key === 'inbox_access')).toMatchObject({ scope: 'workspace', type: 'enum', options: ['none', 'self', 'all'], default: 'self' });
        expect(SETTINGS.find((s) => s.key === 'agent_cap')).toMatchObject({ scope: 'workspace', type: 'enum', options: ['1', '2', '4', '8', '16'], default: '8' });
    });

    it('inboxSettingFrom and agentCapFrom read the values; anything unknown falls back to the default, never to open', () => {
        expect(inboxSettingFrom({})).toEqual({ scope: 'self' });
        expect(inboxSettingFrom({ inbox_access: 'all' })).toEqual({ scope: 'all' });
        expect(inboxSettingFrom({ inbox_access: 'none' })).toEqual({ scope: 'none' });
        expect(inboxSettingFrom({ inbox_access: 'everyone' })).toEqual({ scope: 'self' });
        expect(agentCapFrom({})).toBe(8);
        expect(agentCapFrom({ agent_cap: '4' })).toBe(4);
        expect(agentCapFrom({ agent_cap: 'lots' })).toBe(8);
    });
});

describe('startRefusal with a cap', () => {
    const ports = { registry: { workspace: (id: string) => (id === 'tynn' ? { id: 'tynn', path: '/w/tynn', asleep: false } : null), agentsOf: () => [] } };
    const record = { id: 'agent_a', workspaceId: 'tynn', provider: 'claude', name: 'atlas', instructions: null, threadId: null, createdAt: 't', lastUsedAt: null, mode: 'manual', accessScope: 'self' } as never;

    it('refuses at the cap, naming the number and the setting; under the cap it is null; hibernation still comes first', () => {
        expect(startRefusal(ports as never, record, { running: 4, cap: 4 })).toBe('tynn is at its cap of 4 running agents; stop one or raise agent_cap in the workspace settings before starting atlas');
        expect(startRefusal(ports as never, record, { running: 3, cap: 4 })).toBeNull();
        expect(startRefusal(ports as never, record)).toBeNull();
        const asleep = { registry: { workspace: () => ({ id: 'tynn', path: '/w/tynn', asleep: true }), agentsOf: () => [] } };
        expect(startRefusal(asleep as never, record, { running: 9, cap: 4 })).toMatch(/hibernating/);
    });
});

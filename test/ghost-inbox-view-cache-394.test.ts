import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import { HostRegistry } from '../src/main/host-registry.js';
import { InboxStore, type InboxMessage } from '../src/main/inbox-store.js';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';

it.each(['window', 'host'] as const)('story394: %s inbox visibility is scanned once per mail/ownership change, with exact hide/redock restoration', async (kind) => {
    const dir = await mkdtemp(join(tmpdir(), 'genie2-ghost-view-cache-394-'));
    const store = new Store(dir), inbox = await InboxStore.open(dir);
    const active = agentRecord({ id: mintAgentId(), name: 'Active', workspaceId: 'awake', provider: 'claude' });
    const ghost = agentRecord({ id: mintAgentId(), name: 'Dormant', workspaceId: 'ghost', provider: 'codex' });
    const workspaces = (asleep: boolean) => [{ id: 'awake', path: '/fixture/awake' }, { id: 'ghost', path: '/fixture/ghost', asleep }];
    await store.writeWorkspaces(workspaces(false)); await store.writeAgents([active, ghost]);
    const registry = kind === 'host' ? new HostRegistry(store) : new Registry(store);
    if (registry instanceof Registry) await registry.load({ name: 'test', healthy: true }); else await registry.refresh();
    const policy = registry as unknown as { mailParticipantVisible(id: string): boolean; mailVisibilityVersion?: () => unknown; touch?: () => void };
    const visible = vi.fn((message: InboxMessage) => policy.mailParticipantVisible(message.from) && policy.mailParticipantVisible(message.to));
    type SetVisibility = (test: (message: InboxMessage) => boolean, version?: () => unknown) => void;
    (inbox.setVisibility as SetVisibility).call(inbox, visible, () => policy.mailVisibilityVersion?.() ?? 0);
    try {
        await inbox.send({ from: ghost.id, to: 'human', text: 'Older dormant history' });
        await inbox.send({ from: active.id, to: 'human', text: 'Active history' });
        const before = inbox.involving('human'); expect(before).toHaveLength(2);
        expect(visible).toHaveBeenCalledTimes(2);
        for (let i = 0; i < 20; i++) { expect(inbox.involving('human')).toBe(before); inbox.all(); inbox.snapshot(); }
        policy.touch?.(); inbox.involving('human');
        expect(visible).toHaveBeenCalledTimes(2);
        await store.writeWorkspaces(workspaces(true)); await registry.refresh();
        expect(inbox.involving('human').map((m) => m.text)).toEqual(['Active history']);
        expect(visible).toHaveBeenCalledTimes(4);
        inbox.snapshot(); inbox.all(); expect(visible).toHaveBeenCalledTimes(4);
        await store.writeWorkspaces(workspaces(false)); await registry.refresh();
        expect(inbox.involving('human')).toEqual(before); expect(visible).toHaveBeenCalledTimes(6);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

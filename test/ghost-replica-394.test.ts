import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import { AgentStoresService } from '../src/main/agent-stores-host.js';
import { InboxReplica } from '../src/main/agent-stores-replica.js';
import { openAgentStores } from '../src/main/agent-stores-open.js';
import { ApprovalQueue } from '../src/main/approval-queue.js';
import { Store } from '../src/main/store.js';

it('story394: an already-connected window loses hidden history and restores its original order without a reconnect', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'genie2-ghost-replica-394-'));
    const own = await openAgentStores(dir, () => new Date().toISOString());
    const ghost = mintAgentId(), active = mintAgentId();
    let asleep = false;
    const store = new Store(dir);
    const configure = own.inbox as unknown as { setVisibility?: (test: (m: { from: string; to: string }) => boolean) => void };
    configure.setVisibility?.((m) => !asleep || (m.from !== ghost && m.to !== ghost));
    const service = new AgentStoresService({ ...own, approvals: new ApprovalQueue(), registry: { store, model: {
        refresh: async () => { asleep = (await store.readWorkspaces()).some((w) => w.id === 'ghost' && w.asleep === true); },
    } } });
    const replica = new InboxReplica((...args) => service.call(...args));
    replica.rebase(service.dump().inbox);
    const off = service.onEvent((e) => { if (e.store === 'inbox') replica.apply(e); });
    try {
        await own.inbox.send({ from: ghost, to: 'human', text: 'Older hidden mail' });
        await own.inbox.send({ from: active, to: 'human', text: 'Newer visible mail' });
        const before = replica.all(); expect(before).toHaveLength(2);
        await service.call('registry', 'writeWorkspaces', [[{ id: 'ghost', path: join(dir, 'ghost'), asleep: true }]]);
        expect(replica.all().map((m) => m.text)).toEqual(['Newer visible mail']);
        await own.inbox.receive({ participant: 'human' });
        expect(replica.unread('human')).toEqual([]);
        await service.call('registry', 'writeWorkspaces', [[{ id: 'ghost', path: join(dir, 'ghost'), asleep: false }]]);
        expect(replica.all().map((m) => m.id)).toEqual(before.map((m) => m.id));
        expect(replica.unread('human').map((m) => m.text)).toEqual(['Older hidden mail']);
        await own.inbox.receive({ participant: 'human' });
        expect(replica.unread('human')).toEqual([]);
    } finally { off(); own.knowledge.close(); await rm(dir, { recursive: true, force: true }); }
});

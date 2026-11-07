import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { FLOW_SCHEMA_URL } from '../src/core/flow-form.js';
import { FlowStore } from '../src/main/flow-store.js';
import { FlowsReplica, FlowsService } from '../src/main/flows-host.js';

it('story394: a connected flow replica hides and restores workspace documents on metadata changes alone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'genie2-ghost-flow-394-'));
    const store = await FlowStore.open(dir);
    let asleep = false;
    const future = store as unknown as { setHiddenWorkspaces?: (read: () => readonly string[]) => void; visibilityChanged?: () => void };
    future.setHiddenWorkspaces?.(() => asleep ? ['ghost'] : []);
    const service = new FlowsService({ store, scheduler: { inFlightCount: () => 0 } as never });
    const replica = new FlowsReplica((method, args) => service.call(method, args));
    replica.apply({ kind: 'dump', dump: service.dump() });
    const off = service.onEvent((event) => replica.apply(event));
    try {
        const document = { $schema: FLOW_SCHEMA_URL, version: 1, graph: { nodes: [{ id: 't', kind: 'schedule_trigger', position: { x: 0, y: 0 }, config: { cron: '0 * * * *', timezone: 'UTC' } }], edges: [] } };
        const flow = await store.create({ workspaceId: 'ghost', name: 'Dormant flow', document, by: { kind: 'user' } });
        expect(replica.get(flow.id)).toEqual(flow);
        asleep = true; future.visibilityChanged?.();
        expect(replica.list()).toEqual([]); expect(replica.get(flow.id)).toBeNull();
        asleep = false; future.visibilityChanged?.();
        expect(replica.list()).toEqual([flow]);
    } finally { off(); await store.flushed(); await rm(dir, { recursive: true, force: true }); }
});

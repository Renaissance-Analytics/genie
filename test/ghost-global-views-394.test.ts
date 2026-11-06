import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FLOW_SCHEMA_URL } from '../src/core/flow-form.js';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import { composeServices } from '../src/main/compose.js';
import { featureSnapshot, type FeaturePorts } from '../src/main/feature-ipc.js';
import type { PtyPort } from '../src/main/terminal-host.js';

const pty: PtyPort = { open: () => { throw new Error('no process starts in this visibility fixture'); }, write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {} };
const document = { $schema: FLOW_SCHEMA_URL, version: 1, graph: { nodes: [{ id: 't', kind: 'schedule_trigger', position: { x: 0, y: 0 }, config: { cron: '0 * * * *', timezone: 'UTC' } }], edges: [] } };
async function fixture() {
    const dir = await mkdtemp(join(tmpdir(), 'genie2-global-ghost-394-'));
    let asleep = false;
    const active = agentRecord({ id: mintAgentId(), workspaceId: 'awake', name: 'Active', provider: 'claude' });
    const ghost = agentRecord({ id: mintAgentId(), workspaceId: 'ghost', name: 'Dormant', provider: 'codex' });
    const services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, docker: async () => ({ stdout: '', exitCode: 1 }), roster: () => [active, ghost],
        workspaces: () => [{ id: 'awake', path: join(dir, 'awake') }, { id: 'ghost', path: join(dir, 'ghost'), asleep }] });
    const activeFlow = await services.flows.create({ workspaceId: 'awake', name: 'Active flow', document, by: { kind: 'user' } });
    const ghostFlow = await services.flows.create({ workspaceId: 'ghost', name: 'Dormant flow', document, by: { kind: 'user' } });
    const globalKnowledge = services.knowledge.add({ title: 'Visibility global', body: 'Machine-wide knowledge remains visible', scope: { kind: 'system' }, source: 'user' });
    const activeKnowledge = services.knowledge.add({ title: 'Visibility active', body: 'Active workspace knowledge', scope: { kind: 'workspace', id: 'awake' }, source: 'user' });
    const ghostKnowledge = services.knowledge.add({ title: 'Visibility dormant', body: 'Hibernated workspace knowledge', scope: { kind: 'workspace', id: 'ghost' }, source: 'user' });
    await services.inbox.send({ from: active.id, to: 'human', text: 'Active history' });
    await services.inbox.send({ from: ghost.id, to: 'human', text: 'Dormant history' });
    const processes = [{ id: 'active-process', name: 'Active process', workspaceId: 'awake', state: 'stopped', durable: true }, { id: 'ghost-process', name: 'Dormant process', workspaceId: 'ghost', state: 'stopped', durable: true }];
    const ports: FeaturePorts = { processes: { list: () => processes } as never };
    return { services, active, ghost, activeFlow, ghostFlow, globalKnowledge, activeKnowledge, ghostKnowledge,
        hide: () => { asleep = true; }, redock: () => { asleep = false; },
        snapshot: (query = '') => featureSnapshot(services, { toolStatuses: null, knowledgeQuery: query }, ports),
        close: async () => { await services.shutdown(); await rm(dir, { recursive: true, force: true }); },
    };
}

describe('story394 / ruling6064: global resource views filter ghosts and restore them on redock', () => {
    it('Flows are hidden from the feature view and MCP store view, then return unchanged', async () => {
        const f = await fixture();
        try {
            const before = (await f.snapshot()).flows!.flows;
            expect(before.map((flow) => flow.id)).toContain(f.ghostFlow.id);
            f.hide();
            expect((await f.snapshot()).flows!.flows.map((flow) => flow.id)).toEqual([f.activeFlow.id]);
            expect(f.services.flows.list().map((flow) => flow.id)).toEqual([f.activeFlow.id]);
            f.redock();
            expect((await f.snapshot()).flows!.flows).toEqual(before);
        } finally { await f.close(); }
    });
    it('kept Processes disappear from the feature view and return on redock', async () => {
        const f = await fixture();
        try {
            expect((await f.snapshot()).hosting!.processes.map((process) => process.id)).toEqual(['active-process', 'ghost-process']);
            f.hide(); expect((await f.snapshot()).hosting!.processes.map((process) => process.id)).toEqual(['active-process']);
            f.redock(); expect((await f.snapshot()).hosting!.processes.map((process) => process.id)).toEqual(['active-process', 'ghost-process']);
        } finally { await f.close(); }
    });
    it('inbox peers, conversations, unread messages and history hide ghost participants without deleting mail', async () => {
        const f = await fixture();
        try {
            const before = (await f.snapshot()).inbox!;
            expect(JSON.stringify(before)).toContain(f.ghost.id);
            f.hide();
            const hidden = (await f.snapshot()).inbox!;
            expect(JSON.stringify(hidden)).toContain(f.active.id);
            expect(JSON.stringify(hidden)).not.toContain(f.ghost.id);
            expect(JSON.stringify(hidden)).not.toContain('Dormant history');
            f.redock(); expect((await f.snapshot()).inbox).toEqual(before);
        } finally { await f.close(); }
    });
    it.each(['', 'Visibility'])('Knowledge list/search %s hides workspace-scoped hits, keeps machine-wide data, and restores the archive', async (query) => {
        const f = await fixture();
        try {
            expect((await f.snapshot(query)).knowledge.hits!.map((hit) => hit.id)).toContain(f.ghostKnowledge.id);
            f.hide();
            expect((await f.snapshot(query)).knowledge.hits!.map((hit) => hit.id).sort()).toEqual([f.globalKnowledge.id, f.activeKnowledge.id].sort());
            expect(f.services.knowledge.get(f.ghostKnowledge.id)).toBeNull();
            f.redock(); expect((await f.snapshot(query)).knowledge.hits!.map((hit) => hit.id)).toContain(f.ghostKnowledge.id);
            expect(f.services.knowledge.get(f.ghostKnowledge.id)?.body).toBe('Hibernated workspace knowledge');
        } finally { await f.close(); }
    });
});

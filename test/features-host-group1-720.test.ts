import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLOW_SCHEMA_URL } from '../src/core/flow-form.js';
import type { AgentId, AgentRecord } from '../src/core/identity.js';
import { HUMAN, resolveAddress } from '../src/core/inbox.js';
import { pairKey } from '../src/core/inbox-threads.js';
import { LOCAL_EVENTS, type CallContext, type RemoteMethod } from '../src/core/remote-protocol.js';
import { AttentionStore } from '../src/main/attention-store.js';
import { HostFeatures } from '../src/main/features-host.js';
import { FlowStore } from '../src/main/flow-store.js';
import { hostAloneApi, type HostAlonePorts } from '../src/main/host-alone-api.js';
import { InboxStore } from '../src/main/inbox-store.js';
import { KnowledgeStore } from '../src/main/knowledge-store.js';
import { Registry } from '../src/main/registry.js';
import { hostRemoteApi } from '../src/main/remote-access-host.js';
import { SettingsStore } from '../src/main/settings-store.js';
import { Store } from '../src/main/store.js';
import type { FeatureAction, FeatureData } from '../src/renderer/features.js';

// Real owned stores, no window composition, scheduler run, account, provider or OS process.
const context: CallContext = Object.freeze({ connectionId: 'group-one-owner', origin: 'relay', profile: 'desktop',
    isOwner: true, workspaceId: null, readonly: false, label: 'fixture owner' });
const agentId = ('agent_' + 'a'.repeat(32)) as AgentId;
const roster = [{ id: agentId, name: 'atlas', provider: 'claude', workspaceId: 'work' } as AgentRecord];
const document = { $schema: FLOW_SCHEMA_URL, version: 1, graph: {
    nodes: [
        { id: 'clock', kind: 'schedule_trigger', position: { x: 0, y: 0 }, config: { cron: '*/5 * * * *', timezone: 'UTC' } },
        { id: 'step', kind: 'genie/terminal_run', position: { x: 240, y: 0 }, config: { workspace: 'work', command: 'echo fixture' } },
    ], edges: [{ id: 'clock-to-step', source: 'clock', target: 'step' }],
} };
const settle = async () => { for (let i = 0; i < 16; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
let dir: string, workspace: string, settings: SettingsStore, knowledge: KnowledgeStore, inbox: InboxStore, flows: FlowStore;
let service: HostFeatures, api: ReturnType<typeof hostRemoteApi>, windows: number;
const offs: Array<() => void> = [];
const runFlow = vi.fn(async (_id: string) => {}), refreshPlugins = vi.fn(async () => {}), applyRemote = vi.fn(async () => {});
const invokeWindow = vi.fn(async (method: RemoteMethod) => ({ windowAnswered: method }));

async function outcome(method: RemoteMethod, args: unknown[] = []) {
    return api.invoke(method, args, context).then(value => ({ ok: true as const, value }),
        error => ({ ok: false as const, reason: error instanceof Error ? error.message : String(error) }));
}
async function read(method: RemoteMethod = 'features.snapshot', args: unknown[] = []): Promise<FeatureData> {
    const result = await outcome(method, args);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('the preceding assertion failed');
    return result.value as FeatureData;
}
const act = (action: FeatureAction) => read('features.act', [action]);
async function seedFlow() { return flows.create({ workspaceId: 'work', name: 'fixture clock', document, by: { kind: 'user' } }); }
function changes() {
    const heard: Array<{ channel: string; data: unknown }> = [];
    offs.push(api.onEvent((channel, data) => { if (channel === 'features' || channel === LOCAL_EVENTS.features) heard.push({ channel, data }); }));
    return { heard, revisions: () => heard.filter(event => event.channel === LOCAL_EVENTS.features),
        snapshots: () => heard.filter(event => event.channel === 'features').map(event => event.data as FeatureData) };
}

beforeEach(async () => {
    vi.clearAllMocks(); windows = 0;
    dir = await mkdtemp(join(tmpdir(), 'genie-features-group-one-'));
    workspace = join(dir, 'workspace'); await mkdir(workspace);
    await writeFile(join(workspace, 'project.json'), JSON.stringify({ name: 'fixture', repos: [] }));
    settings = await SettingsStore.open(dir); knowledge = KnowledgeStore.open(dir);
    inbox = await InboxStore.open(dir); flows = await FlowStore.open(dir);
    const attention = await AttentionStore.open(dir, inbox);
    const registry = new Registry(new Store(dir)); await registry.load({ name: 'fixture-host', healthy: true });
    await registry.addWorkspace({ id: 'work', path: workspace });
    service = new HostFeatures({ settings, knowledge, flows, inbox, attention, roster: () => roster,
        resolveAddress: address => resolveAddress(address, roster), mailRefusal: () => null, workspaceIds: () => ['work'],
        runFlow, refreshPlugins, applyRemote });
    const alone = hostAloneApi({ hostName: 'fixture-host', registry, settings, engine: () => null, cwdFor: () => workspace,
        startRefusal: () => null, models: { get: async () => ({ models: [] }) }, providerInstalled: () => true,
        windowConnected: () => windows > 0, attention, approvals: { resolve: () => true }, inbox, deliverToAgent: async () => true,
        terminals: { attach: () => null, write: () => true, resize: () => true, close: () => true, list: () => [], onData: () => () => {}, onExit: () => () => {} },
        takeOver: () => null, headroom: { view: () => ({}), subscribe: () => () => {} },
        files: { children: async () => null, open: async () => ({ ok: false }), readBytes: async () => ({ ok: false }), upload: async () => ({ ok: false }) },
        features: service,
    } as unknown as HostAlonePorts);
    api = hostRemoteApi({ hostName: 'fixture-host', own: {}, alone,
        window: { connected: () => windows > 0, invoke: invokeWindow } });
});
afterEach(async () => {
    for (const off of offs.splice(0)) off(); service?.close(); knowledge?.close();
    await rm(dir, { recursive: true, force: true });
});

describe('host feature group one with no window (Tynn #720)', () => {
    it('the snapshot reads owned settings, knowledge, flows and inbox', async () => {
        await settings.set('theme', 'light'); const note = knowledge.add({ title: 'owned note', scope: { kind: 'system' }, source: 'user' });
        const flow = await seedFlow(), message = await inbox.send({ from: agentId, to: HUMAN, text: 'owned mail' });
        const data = await read();
        expect(data.settings.values).toMatchObject({ theme: 'light' });
        expect(data.knowledge.hits).toEqual(expect.arrayContaining([expect.objectContaining({ id: note.id })]));
        expect(data.flows?.flows.map(row => row.id)).toContain(flow.id);
        expect(data.inbox?.unread.map(row => row.id)).toContain(message.id);
    });
    it('settings set and reset persist in the owned store', async () => {
        expect((await act({ kind: 'settings.set', key: 'theme', value: 'light' })).settings.values).toMatchObject({ theme: 'light' });
        expect((await SettingsStore.open(dir)).get('theme')).toBe('light');
        expect((await act({ kind: 'settings.reset', key: 'theme' })).settings.values).toMatchObject({ theme: 'system' });
    });
    it('invalid setting preserves its refusal and writes nothing', async () => {
        expect(await outcome('features.act', [{ kind: 'settings.set', key: 'theme', value: 'sepia' }])).toMatchObject({ ok: false, reason: expect.stringContaining('sepia') });
        expect(settings.get('theme')).toBe('system');
    });
    it('settings keep plugin refresh and remote apply side effects', async () => {
        await act({ kind: 'settings.set', key: 'publisher_checks_off', value: true });
        await act({ kind: 'settings.set', key: 'remote_access', value: true });
        expect(refreshPlugins).toHaveBeenCalledTimes(1); expect(applyRemote).toHaveBeenCalledTimes(1);
    });
    it('knowledge search reads owned records and keeps the caller query', async () => {
        knowledge.add({ title: 'Redis owned', scope: { kind: 'system' }, source: 'user' });
        knowledge.add({ title: 'Caddy owned', scope: { kind: 'system' }, source: 'user' });
        const data = await act({ kind: 'knowledge.search', query: 'Redis' });
        expect(data.knowledge.query).toBe('Redis'); expect(data.knowledge.hits?.map(hit => hit.title)).toEqual(['Redis owned']);
        expect((await read()).knowledge.query).toBe('Redis');
    });
    it('knowledge add records the human source', async () => {
        await act({ kind: 'knowledge.add', title: 'Human memory', body: 'fixture body', scope: { kind: 'workspace', id: 'work' } });
        const hit = knowledge.search({ query: 'Human memory', scopes: 'all' }).hits[0]!;
        expect(knowledge.get(hit.id)).toMatchObject({ title: 'Human memory', source: 'user', scope: { kind: 'workspace', id: 'work' } });
    });
    it('knowledge forms preserve validation and unresolved links', async () => {
        await act({ kind: 'knowledge.openAdd', workspaceId: 'work' });
        const form = { title: '', body: 'See [[missing]].', class: 'knowledge' as const, scope: { kind: 'workspace' as const, id: 'work' } };
        const invalid = await act({ kind: 'knowledge.create', form });
        expect(invalid.knowledge.adding?.problems).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'title' })]));
        const saved = await act({ kind: 'knowledge.create', form: { ...form, title: 'Saved memory' } });
        expect(saved.knowledge.lastAdd).toMatchObject({ title: 'Saved memory', unresolved: [{ ref: 'missing', reason: 'missing' }] });
        expect((await act({ kind: 'knowledge.cancelForm' })).knowledge.adding).toBeNull();
    });
    it('flows arm, disarm and remove operate as the human on the owned store', async () => {
        const flow = await seedFlow();
        await act({ kind: 'flows.arm', flowId: flow.id }); expect(flows.get(flow.id)?.armed).toBe(true);
        await act({ kind: 'flows.disarm', flowId: flow.id }); expect(flows.get(flow.id)?.armed).toBe(false);
        await act({ kind: 'flows.remove', flowId: flow.id }); expect(flows.get(flow.id)).toBeNull();
    });
    it('flow graph saves preserve validation and never arm a new flow', async () => {
        const saved = await act({ kind: 'flows.saveGraph', workspaceId: 'work', name: 'Saved graph', document });
        expect(saved.flows?.saved).toMatchObject({ ok: true });
        expect(flows.list()).toEqual([expect.objectContaining({ name: 'Saved graph', armed: false })]);
        const invalid = await act({ kind: 'flows.saveGraph', workspaceId: 'missing', name: '', document });
        expect(invalid.flows?.saved).toMatchObject({ ok: false }); expect(flows.list()).toHaveLength(1);
    });
    it('flow Run now reaches the existing scheduler once', async () => {
        const flow = await seedFlow(); await act({ kind: 'flows.runNow', flowId: flow.id });
        expect(runFlow).toHaveBeenCalledExactlyOnceWith(flow.id); expect(flows.get(flow.id)?.armed).toBe(false);
    });
    it('inbox send resolves the roster and stores mail from the human', async () => {
        await act({ kind: 'inbox.send', to: 'atlas@work', text: 'hello atlas' });
        expect(inbox.unread(agentId)).toEqual([expect.objectContaining({ from: HUMAN, to: agentId, text: 'hello atlas' })]);
    });
    it('inbox send preserves missing-recipient refusal without writing', async () => {
        expect(await outcome('features.act', [{ kind: 'inbox.send', to: 'missing@work', text: 'not sent' }])).toMatchObject({ ok: false, reason: 'nobody at missing@work' });
        expect(inbox.all()).toEqual([]);
    });
    it('inbox markRead commits the human cursor through the selected message', async () => {
        const first = await inbox.send({ from: agentId, to: HUMAN, text: 'first' });
        await inbox.send({ from: agentId, to: HUMAN, text: 'second' });
        expect((await act({ kind: 'inbox.markRead', messageId: first.id })).inbox?.unread.map(row => row.text)).toEqual(['second']);
        expect(inbox.unread(HUMAN).map(row => row.text)).toEqual(['second']);
    });
    it('inbox thread and search are action answers rather than pushed state', async () => {
        const message = await inbox.send({ from: agentId, to: HUMAN, text: 'find this fixture' }), key = pairKey(agentId, HUMAN);
        expect((await act({ kind: 'inbox.thread', key, limit: 10 })).inbox?.thread?.messages.map(row => row.id)).toEqual([message.id]);
        expect((await act({ kind: 'inbox.search', key, query: 'fixture' })).inbox?.search?.hits.map(row => row.id)).toEqual([message.id]);
        const next = await read(); expect(next.inbox?.thread).toBeNull(); expect(next.inbox?.search).toBeNull();
    });
    it('custom sound reads by setting key and preserves null for other keys', async () => {
        const file = join(dir, 'fixture.wav'), bytes = Buffer.from('fixture audio bytes'); await writeFile(file, bytes);
        await settings.set('sound_question_custom', file);
        expect(await outcome('features.soundData', ['sound_question'])).toEqual({ ok: true, value: `data:audio/wav;base64,${bytes.toString('base64')}` });
        expect(await outcome('features.soundData', ['theme'])).toEqual({ ok: true, value: null });
    });
    it('feature answers remain authoritative with zero, one and two windows', async () => {
        await settings.set('theme', 'light');
        for (const count of [0, 1, 2, 0]) { windows = count; expect(await read()).toMatchObject({ settings: { values: { theme: 'light' } } }); }
        expect(invokeWindow).not.toHaveBeenCalled();
    });
    it('settings and flow changes publish one owned feature revision each', async () => {
        const events = changes(); await settings.set('theme', 'light'); await settle();
        expect(events.revisions()).toHaveLength(1); expect(events.snapshots()[0]?.settings.values).toMatchObject({ theme: 'light' });
        await seedFlow(); await settle(); expect(events.revisions()).toHaveLength(2);
    });
    it('inbox sends and receipts each publish the updated owned state', async () => {
        const events = changes(); await inbox.send({ from: agentId, to: HUMAN, text: 'read me' }); await settle();
        expect(events.revisions()).toHaveLength(1); expect(events.snapshots().at(-1)?.inbox?.unread).toHaveLength(1);
        await inbox.receive({ participant: HUMAN }); await settle();
        expect(events.revisions()).toHaveLength(2); expect(events.snapshots().at(-1)?.inbox?.unread).toEqual([]);
    });
    it('unsubscribe prevents later host feature delivery after a positive event', async () => {
        const heard = vi.fn(); const off = api.onEvent((channel, data) => { if (channel === LOCAL_EVENTS.features) heard(data); }); offs.push(off);
        await settings.set('theme', 'light'); await settle(); expect(heard).toHaveBeenCalledTimes(1);
        off(); heard.mockClear(); await settings.set('theme', 'dark'); await settle(); expect(heard).not.toHaveBeenCalled();
    });
    it('CONTROL: the real owned fixture stores answer without a feature service', async () => {
        await settings.set('theme', 'light'); const note = knowledge.add({ title: 'fixture control', scope: { kind: 'system' }, source: 'user' });
        const flow = await seedFlow(), message = await inbox.send({ from: agentId, to: HUMAN, text: 'fixture control' });
        expect(settings.get('theme')).toBe('light'); expect(knowledge.get(note.id)?.title).toBe('fixture control');
        expect(flows.get(flow.id)?.name).toBe('fixture clock'); expect(inbox.unread(HUMAN).map(row => row.id)).toContain(message.id);
    });
    it('CONTROL: unrelated host workspace settings preserve their current answer', async () => {
        expect(await outcome('workspaces.settings', ['work'])).toMatchObject({ ok: true, value: { ok: true, values: { app_inbox: true } } });
    });
    it('CONTROL: unrelated connected-window methods keep the window preference', async () => {
        windows = 1;
        expect(await outcome('agents.models', ['unused'])).toEqual({ ok: true, value: { windowAnswered: 'agents.models' } });
        expect(invokeWindow).toHaveBeenCalledExactlyOnceWith('agents.models', ['unused'], context);
    });
});

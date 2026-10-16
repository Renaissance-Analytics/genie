import { describe, expect, it } from 'vitest';
import type { AgentRecord } from '../src/core/identity.js';
import { buildHostApi, type HostApiDeps } from '../src/main/host-api.js';
import type { GenieSnapshot, UpdateState } from '../src/renderer/bridge.js';
import type { FeatureData } from '../src/renderer/features.js';

/**
 * THE HOST API (§6.8) — what a remote connection may perform on THIS Genie, as one `invoke` over the
 * 22 bridge methods and one event stream, built from the same parts the IPC handlers use (the
 * registry, the session host, the terminal host, the feature IPC, the updater). main.ts wires the
 * real parts; here they are fakes, so every branch is a table: an unknown agent is a refusal, a
 * host-only method throws with where to do it, a terminal opens in the workspace's folder WITH its
 * service env, and events fan out on named channels.
 */

const record = { id: 'agent_a', workspaceId: 'tynn', provider: 'claude', name: 'atlas' } as unknown as AgentRecord;

function fakes() {
    const calls: string[] = [];
    const listeners = { snapshot: new Set<(s: GenieSnapshot) => void>(), agent: new Set<(id: string) => void>(), record: new Set<(id: string) => void>(), data: new Set<(id: string, d: string) => void>(), exit: new Set<(id: string, c: number) => void>(), features: new Set<(d: FeatureData) => void>(), updates: new Set<(s: UpdateState) => void>() };
    const deps: HostApiDeps = {
        snapshot: () => ({ agents: [], workspaces: [{ id: 'tynn', path: '/w/tynn', agentsKnown: true }], deckItems: [], signals: {} }) as never,
        subscribeSnapshot: (cb) => { listeners.snapshot.add(cb); return () => listeners.snapshot.delete(cb); },
        subscribeAgentRecords: (cb) => { listeners.record.add(cb); return () => listeners.record.delete(cb); },
        find: (id) => (id === 'agent_a' ? record : null),
        detailFor: (id) => (id === 'agent_a' ? { agent: { id }, rows: [] } : null) as never,
        cwdFor: () => '/w/tynn',
        host: {
            start: (r, cwd) => { calls.push(`start:${r.id}:${cwd}`); return { ok: true }; },
            stop: (id) => { calls.push(`stop:${id}`); return true; },
            cancel: (id) => { calls.push(`cancel:${id}`); return { ok: true }; },
            prompt: (id, text) => { calls.push(`prompt:${id}:${text}`); return true; },
            answerApproval: (id, opt) => { calls.push(`approve:${id}:${opt}`); return true; },
            subscribe: (cb) => { listeners.agent.add(cb); return () => listeners.agent.delete(cb); },
        },
        registerAgent: async (workspaceId) => { calls.push(`register:${workspaceId}`); return { id: 'agent_new' }; },
        attention: { finished: () => [{ id: 'fin_1', agentId: 'agent_a', agentName: 'atlas', handoff: 'carry on', at: 't', seen: false }] as never, markSeen: (id) => { calls.push(`seen:${id}`); } },
        terminals: {
            open: (o) => { calls.push(`term-open:${o.workspaceId}:${o.cwd}:${o.cols ?? '-'}:${o.env?.DB_PORT ?? '-'}`); return { id: 'term_1', pid: 7, shell: 'sh', scrollback: '' }; },
            write: (id, d) => { calls.push(`term-write:${id}:${d}`); return true; },
            resize: (id, c, r) => { calls.push(`term-resize:${id}:${c}x${r}`); return true; },
            close: (id) => { calls.push(`term-close:${id}`); return true; },
            list: () => [{ id: 'term_1', pid: 7, shell: 'sh', workspaceId: 'tynn' }, { id: 'term_2', pid: 8, shell: 'sh', workspaceId: 'fancy' }] as never,
            attach: (id) => (id === 'term_1' ? { id: 'term_1', pid: 7, shell: 'sh', workspaceId: 'tynn', scrollback: 'replay' } : null),
            onData: (cb) => { listeners.data.add(cb); return () => listeners.data.delete(cb); },
            onExit: (cb) => { listeners.exit.add(cb); return () => listeners.exit.delete(cb); },
        },
        uploads: { sendFile: async (to, text, name, bytes) => { calls.push(`upload:${to}:${name}:${bytes.byteLength}`); return { ok: true, messageId: 'msg_u' }; } },
        serviceEnvFor: (ws) => (ws === 'tynn' ? { DB_PORT: '54301' } : {}),
        workspaceOps: {
            confirmAdd: async (path) => { calls.push(`ws-add:${path}`); return { ok: true }; },
            confirmAddFromGit: async (url, parent) => { calls.push(`ws-add-git:${url}:${parent}`); return { ok: true }; },
            confirmAddFromTynn: async (parent) => { calls.push(`ws-add-tynn:${parent}`); return { ok: true }; },
            hibernate: async (id) => { calls.push(`ws-hibernate:${id}`); return { ok: true }; },
            wake: async (id) => { calls.push(`ws-wake:${id}`); return { ok: true }; },
            remove: async (id) => { calls.push(`ws-remove:${id}`); return { ok: true }; },
            listRepos: async (id) => { calls.push(`ws-repos:${id}`); return { ok: true, repos: [] }; },
            addRepo: async (id, input) => { calls.push(`ws-repo-add:${id}:${input.name}`); return { ok: true, slug: input.name }; },
            removeRepo: async (id, slug) => { calls.push(`ws-repo-remove:${id}:${slug}`); return { ok: true }; },
            settings: async (id) => ({ ok: true, values: {}, overridden: [] }),
            setSetting: async (id, key, value) => { calls.push(`ws-setting:${id}:${key}=${String(value)}`); return { ok: true }; },
            resetSetting: async (id, key) => { calls.push(`ws-setting-reset:${id}:${key}`); return { ok: true }; },
            setGoverns: async (id, children) => { calls.push(`ws-governs:${id}:${children.join('+')}`); return { ok: true, governs: [...children] }; },
        },
        agentOps: {
            restart: async (id, kind) => { calls.push(`agent-restart:${id}:${kind}`); return { ok: true, kind }; },
            previewDelete: async () => ({ ok: true, plan: { outcome: 'unmount', removes: [], keeps: [], external: [] } }),
            delete: async (id, outcome) => { calls.push(`agent-delete:${id}:${outcome}`); return { ok: true, plan: { outcome, removes: [], keeps: [], external: [] } }; },
            switchDriver: async (id, to) => { calls.push(`agent-switch:${id}:${to}`); return { ok: true, carries: [], from: 'claude', to }; },
            setBudget: async (id, usd) => { calls.push(`agent-budget:${id}:${usd}`); return { ok: true, decision: { kind: 'proceed', remainingUsd: null } }; },
            setMode: async (id, mode) => { calls.push(`agent-mode:${id}:${mode}`); return { ok: true }; },
            setAccessScope: async (id, scope) => { calls.push(`agent-scope:${id}:${scope}`); return { ok: true }; },
            setPermissions: async (id, permissions) => { calls.push(`agent-permissions:${id}:${permissions}`); return { ok: true }; },
            setModel: async (id, model) => { calls.push(`agent-model:${id}:${model}`); return { ok: true }; },
            diagnose: async () => ({ ok: true, diagnosis: { state: 'healthy', fault: false, cause: null, repair: null } }),
        },
        features: {
            snapshot: async () => ({ knowledge: { hits: null } }) as never,
            act: async (action) => { calls.push(`act:${action.kind}`); return { knowledge: { hits: [] } } as never; },
            onChange: (cb) => { listeners.features.add(cb); return () => listeners.features.delete(cb); },
        },
        updates: {
            state: () => ({ phase: 'idle', version: null, percent: null, error: null, checkedAt: null }),
            check: async () => ({ phase: 'none', version: null, percent: null, error: null, checkedAt: 1 }),
            download: async () => true,
            install: () => ({ report: 'stopped 1 process' }),
            onChange: (cb) => { listeners.updates.add(cb); return () => listeners.updates.delete(cb); },
        },
    };
    return { deps, calls, listeners };
}

describe('invoke', () => {
    it('reads answer from the parts; agent writes go to the session host with the agent’s folder; an unknown agent is a refusal, not a throw', async () => {
        const f = fakes();
        const api = buildHostApi(f.deps);
        expect(await api.invoke('snapshot', [])).toMatchObject({ workspaces: [{ id: 'tynn' }] });
        expect(await api.invoke('agentDetail', ['agent_a'])).toEqual({ agent: { id: 'agent_a' }, rows: [] });
        expect(await api.invoke('agentDetail', ['nope'])).toBeNull();
        expect(await api.invoke('openAgent', ['agent_a'])).toEqual({ ok: true });
        expect(await api.invoke('openAgent', ['nope'])).toEqual({ ok: false, reason: 'unknown agent' });
        expect(await api.invoke('stopAgent', ['agent_a'])).toEqual({ ok: true });
        expect(await api.invoke('prompt', ['agent_a', 'hi'])).toEqual({ ok: true });
        expect(await api.invoke('answerApproval', ['agent_a', 'allow'])).toEqual({ ok: true });
        expect(await api.invoke('addAgent', ['tynn'])).toEqual({ ok: true, id: 'agent_new' });
        expect(await api.invoke('restartWithHandoff', ['agent_a', 'fin_1'])).toEqual({ ok: true });
        expect(f.calls).toEqual(['start:agent_a:/w/tynn', 'stop:agent_a', 'prompt:agent_a:hi', 'approve:agent_a:allow', 'register:tynn', 'stop:agent_a', 'start:agent_a:/w/tynn', expect.stringMatching(/^prompt:agent_a:You are restarting/), 'seen:fin_1']);
        expect(api.workspaceOfAgent('agent_a')).toBe('tynn');
        expect(api.workspaceOfAgent('nope')).toBeNull();
    });

    it('cancelTurn is `Stop this turn`: it reaches host.cancel ONCE and never host.stop; stopAgent still stops (control); an unknown agent is refused', async () => {
        const f = fakes();
        const api = buildHostApi(f.deps);
        expect(await api.invoke('cancelTurn', ['agent_a'])).toEqual({ ok: true });
        expect(f.calls).toEqual(['cancel:agent_a']);
        expect(await api.invoke('stopAgent', ['agent_a'])).toEqual({ ok: true });
        expect(f.calls).toEqual(['cancel:agent_a', 'stop:agent_a']);
        expect(await api.invoke('cancelTurn', ['nope'])).toEqual({ ok: false, reason: 'unknown agent' });
        expect(f.calls).toHaveLength(2);
    });

    it('agent operations pass through with their arguments narrowed', async () => {
        const f = fakes();
        const api = buildHostApi(f.deps);
        expect(await api.invoke('agents.restart', ['agent_a', 'fresh'])).toEqual({ ok: true, kind: 'fresh' });
        expect(await api.invoke('agents.delete', ['agent_a', 'delete', ['tynn']])).toMatchObject({ ok: true, plan: { outcome: 'delete' } });
        expect(await api.invoke('agents.switchDriver', ['agent_a', 'codex'])).toMatchObject({ ok: true, to: 'codex' });
        expect(await api.invoke('agents.setBudget', ['agent_a', null])).toMatchObject({ ok: true });
        expect(await api.invoke('agents.diagnose', ['agent_a'])).toMatchObject({ ok: true, diagnosis: { state: 'healthy' } });
        expect(f.calls).toEqual(['agent-restart:agent_a:fresh', 'agent-delete:agent_a:delete', 'agent-switch:agent_a:codex', 'agent-budget:agent_a:null']);
    });

    it('host-only methods throw with where to do them — the RemoteHost refuses them earlier; this is the backstop', async () => {
        const api = buildHostApi(fakes().deps);
        await expect(api.invoke('addWorkspace', [])).rejects.toThrow(/folder picker/);
        await expect(api.invoke('takeOver', ['agent_a'])).rejects.toThrow(/window/);
        await expect(api.invoke('features.setBrowserBounds', [{}])).rejects.toThrow(/host/);
    });

    it('a terminal opens in the WORKSPACE’s folder with its service env; an unknown workspace is refused; list is per workspace', async () => {
        const f = fakes();
        const api = buildHostApi(f.deps);
        expect(await api.invoke('terminals.open', ['tynn', { cols: 80, rows: 24 }])).toEqual({ id: 'term_1', pid: 7, shell: 'sh', scrollback: '' });
        expect(f.calls).toEqual(['term-open:tynn:/w/tynn:80:54301']);
        await expect(api.invoke('terminals.open', ['nope', { cols: 80, rows: 24 }])).rejects.toThrow('no workspace nope');
        expect(await api.invoke('terminals.write', ['term_1', 'ls\n'])).toBe(true);
        expect(await api.invoke('terminals.resize', ['term_1', 100, 30])).toBe(true);
        expect(await api.invoke('terminals.close', ['term_1'])).toBe(true);
        expect(await api.invoke('terminals.list', ['tynn'])).toEqual([{ id: 'term_1', pid: 7, shell: 'sh' }]);
        // JOIN (§6.5): the scrollback so far; another workspace's id, or an unknown one, is null — never another terminal.
        expect(await api.invoke('terminals.attach', ['tynn', 'term_1'])).toEqual({ id: 'term_1', pid: 7, shell: 'sh', scrollback: 'replay' });
        expect(await api.invoke('terminals.attach', ['fancy', 'term_1'])).toBeNull();
        expect(await api.invoke('terminals.attach', ['tynn', 'term_9'])).toBeNull();
    });

    it('features and updates pass through; without an updater the update methods answer the local bridge’s nulls', async () => {
        const f = fakes();
        const api = buildHostApi(f.deps);
        expect(await api.invoke('features.snapshot', [])).toEqual({ knowledge: { hits: null } });
        expect(await api.invoke('features.act', [{ kind: 'knowledge.search', query: 'x' }])).toEqual({ knowledge: { hits: [] } });
        // A phone's upload (§6.8): base64 on the wire, bytes to the sender.
        expect(await api.invoke('inbox.sendFile', ['kai', 'hi', 'a.txt', Buffer.from('xyz').toString('base64')])).toEqual({ ok: true, messageId: 'msg_u' });
        expect(f.calls).toContain('upload:kai:a.txt:3');
        expect(await api.invoke('updates.state', [])).toMatchObject({ phase: 'idle' });
        expect(await api.invoke('updates.check', [])).toMatchObject({ phase: 'none' });
        expect(await api.invoke('updates.download', [])).toBe(true);
        expect(await api.invoke('updates.install', [])).toEqual({ report: 'stopped 1 process' });
        const none = buildHostApi({ ...f.deps, updates: null });
        expect(await none.invoke('updates.state', [])).toBeNull();
        expect(await none.invoke('updates.download', [])).toBe(false);
        expect(await none.invoke('updates.install', [])).toBeNull();
    });
});

describe('events', () => {
    it('fan out on named channels — snapshot, agent:<id> with its detail, terminal-data, terminal-exit, features, updates — and unsubscribe as one', () => {
        const f = fakes();
        const api = buildHostApi(f.deps);
        const got: Array<[string, unknown]> = [];
        const off = api.onEvent((channel, payload) => got.push([channel, payload]));
        for (const l of f.listeners.snapshot) l({ agents: [] } as never);
        for (const l of f.listeners.agent) l('agent_a');
        for (const l of f.listeners.data) l('term_1', 'hi');
        for (const l of f.listeners.exit) l('term_1', 0);
        for (const l of f.listeners.features) l({ knowledge: {} } as never);
        for (const l of f.listeners.updates) l({ phase: 'none' } as never);
        expect(got).toEqual([
            ['snapshot', { agents: [] }],
            ['agent:agent_a', { agent: { id: 'agent_a' }, rows: [] }],
            ['terminal-data', { id: 'term_1', data: 'hi' }],
            ['terminal-exit', { id: 'term_1', exitCode: 0 }],
            ['features', { knowledge: {} }],
            ['updates', { phase: 'none' }],
        ]);
        off();
        for (const l of f.listeners.snapshot) l({ agents: [] } as never);
        expect(got).toHaveLength(6);
        expect(f.listeners.snapshot.size).toBe(0);
    });

    it('a SETTING saved on an agent (its record, not its session) pushes agent:<id> too — the remote Agent view reads its model from that detail', () => {
        const f = fakes();
        const api = buildHostApi(f.deps);
        const got: Array<[string, unknown]> = [];
        const off = api.onEvent((channel, payload) => got.push([channel, payload]));
        for (const l of f.listeners.record) l('agent_a');
        // COUNTED: exactly one push, on the agent's own channel, carrying its detail.
        expect(got).toEqual([['agent:agent_a', { agent: { id: 'agent_a' }, rows: [] }]]);
        off();
        expect(f.listeners.record.size).toBe(0);
    });
});

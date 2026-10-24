import { listModels as prismListModels, ModelListError, type SessionModelState } from '@particle-academy/prism-acp';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyOutcome } from '../src/core/agent-ops.js';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { ProviderModelCache, modelLabel } from '../src/core/provider-models.js';
import { AGENT_SCOPED_METHODS, capabilityOf } from '../src/core/remote-protocol.js';
import type { SessionDriverFactory } from '../src/core/session.js';
import { listModels, setModel, type AgentOpsPorts } from '../src/main/agent-ops-host.js';
import { buildHostApi, type HostApiDeps } from '../src/main/host-api.js';
import { SessionHost, listModelsOptionsFor, providerBinary, providerLaunchOptions, type DriverFor } from '../src/main/session-host.js';

/**
 * THE PROVIDER'S OWN MODEL LIST (the owner, 2026-10-21: "make sure that the model selection for agents is using actual
 * available options from the providers. For example, I do not even see fable as an option").
 *
 * prism-acp 0.22 asks the provider: `listModels(provider, …)` before a session exists (a short-lived CLI, no turn),
 * `driver.modelState()` on a running one (no extra process), `driver.setModel(id)` to switch it live. Genie's part is
 * WHICH CLI it asks (the one an agent of that provider would launch), how often (once per provider, until refreshed),
 * what it says when the provider will not answer, and switching a running agent without a restart.
 */
const state = (ids: readonly string[], current: string | null = null, defaultId: string | null = null): SessionModelState => ({
    availableModels: ids.map((id) => ({ modelId: id, name: id, ...(id === defaultId ? { isDefault: true } : {}) })),
    currentModelId: current,
});

describe('the cache: one CLI per provider, until refreshed', () => {
    it('asks once, answers again from the cache, and asks again only on a refresh (COUNTED)', async () => {
        const asked: string[] = [];
        const cache = new ProviderModelCache(async (provider) => { asked.push(provider); return state(asked.length === 1 ? ['opus'] : ['opus', 'fable'], 'opus'); });
        expect(await cache.get('claude')).toEqual({ ok: true, provider: 'claude', source: 'provider', models: [{ modelId: 'opus', name: 'opus' }], current: 'opus' });
        expect(await cache.get('claude')).toMatchObject({ ok: true, models: [{ modelId: 'opus' }] });
        expect(asked).toEqual(['claude']);
        const refreshed = await cache.get('claude', { refresh: true });
        expect(asked).toEqual(['claude', 'claude']);
        expect(refreshed).toMatchObject({ ok: true, models: [{ modelId: 'opus' }, { modelId: 'fable' }] });
    });

    it('two pickers opening at once share ONE ask', async () => {
        let calls = 0;
        let release: (s: SessionModelState) => void = () => {};
        const cache = new ProviderModelCache(() => { calls += 1; return new Promise((r) => { release = r; }); });
        const a = cache.get('codex');
        const b = cache.get('codex');
        release(state(['gpt-6.1-sol']));
        expect(await a).toMatchObject({ ok: true });
        expect(await b).toMatchObject({ ok: true });
        expect(calls).toBe(1);
    });

    it('per provider: Claude’s list is not Codex’s', async () => {
        const asked: string[] = [];
        const cache = new ProviderModelCache(async (provider) => { asked.push(provider); return state([provider === 'claude' ? 'fable' : 'gpt-6.1-sol']); });
        expect(await cache.get('claude')).toMatchObject({ models: [{ modelId: 'fable' }] });
        expect(await cache.get('codex')).toMatchObject({ models: [{ modelId: 'gpt-6.1-sol' }] });
        expect(asked).toEqual(['claude', 'codex']);
    });

    it('a provider that will not say: the reason in its own words, kept until a refresh (no CLI per picker open)', async () => {
        let calls = 0;
        const cache = new ProviderModelCache(async () => {
            calls += 1;
            if (calls === 1) throw new ModelListError('claude did not answer the model list within 30000 ms');
            return state(['fable']);
        });
        expect(await cache.get('claude')).toEqual({ ok: false, provider: 'claude', reason: 'claude did not answer the model list within 30000 ms' });
        expect(await cache.get('claude')).toMatchObject({ ok: false });
        expect(calls).toBe(1);
        expect(await cache.get('claude', { refresh: true })).toMatchObject({ ok: true, models: [{ modelId: 'fable' }] });
        expect(calls).toBe(2);
    });

    it('a CLI that could not even start is a failure that says so, never a throw', async () => {
        const cache = new ProviderModelCache(async () => { throw new Error('spawn claude ENOENT'); });
        const r = await cache.get('claude');
        expect(r).toMatchObject({ ok: false, provider: 'claude' });
        expect((r as { reason: string }).reason).toMatch(/could not start claude: spawn claude ENOENT/);
    });

    it('a provider Genie cannot run is refused without asking anything', async () => {
        let calls = 0;
        const cache = new ProviderModelCache(async () => { calls += 1; return state([]); });
        expect(await cache.get('gemini')).toMatchObject({ ok: false, provider: 'gemini' });
        expect(calls).toBe(0);
        expect(await cache.get('claude')).toMatchObject({ ok: true });
        expect(calls).toBe(1);
    });
});

describe('the label: the provider’s name, and what an alias resolves to when it differs', () => {
    it('Fable → claude-fable-5-1; no arrow when there is nothing to resolve (CONTROL)', () => {
        expect(modelLabel({ modelId: 'fable', name: 'Fable', resolvedModel: 'claude-fable-5-1' })).toBe('Fable → claude-fable-5-1');
        expect(modelLabel({ modelId: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' })).toBe('GPT-6.1 Sol');
        expect(modelLabel({ modelId: 'claude-opus-5-5', name: 'claude-opus-5-5', resolvedModel: 'claude-opus-5-5' })).toBe('claude-opus-5-5');
    });
});

describe('which CLI is asked: the one an agent of that provider launches', () => {
    const runtime = { execPath: '/usr/bin/node', electron: false };
    // This describes binary selection without toolchain overrides; managed values have their own SDK env tests.
    beforeEach(() => { vi.stubEnv('NPM_CONFIG_PREFIX', undefined); vi.stubEnv('PHP_INI_SCAN_DIR', undefined); });
    afterEach(() => vi.unstubAllEnvs());

    it('the same binary, binaryArgs, parentEnv and allowEnv as the agent’s driver (providerLaunchOptions), per provider', () => {
        for (const env of [{}, { GENIE2_CLAUDE_BINARY: '/opt/claude/bin/claude' }, { GENIE2_CLAUDE_BINARY: '/w/stub-claude.mjs' }]) {
            const options = listModelsOptionsFor('claude', env, runtime);
            expect(options).toMatchObject(providerLaunchOptions(providerBinary('claude', env), {}, runtime));
        }
        expect(listModelsOptionsFor('claude', { GENIE2_CLAUDE_BINARY: '/opt/claude/bin/claude' }, runtime)).toMatchObject({ binary: '/opt/claude/bin/claude' });
        expect(listModelsOptionsFor('claude', {}, runtime)).not.toHaveProperty('binary');
        // One provider's path is never used for another's.
        expect(listModelsOptionsFor('codex', { GENIE2_CLAUDE_BINARY: '/opt/claude/bin/claude' }, runtime)).not.toHaveProperty('binary');
        // Inside Electron a script provider runs as Node, allowed through to that provider alone.
        const electron = listModelsOptionsFor('codex', { GENIE2_CODEX_BINARY: '/w/stub-codex.mjs' }, { execPath: '/app/genie', electron: true });
        expect(electron).toMatchObject({ binary: '/app/genie', binaryArgs: ['/w/stub-codex.mjs'], allowEnv: ['ELECTRON_RUN_AS_NODE'] });
        expect(electron.parentEnv?.ELECTRON_RUN_AS_NODE).toBe('1');
    });

    it('asked from the home folder (no workspace’s project settings choose the list), with a bounded wait', () => {
        const options = listModelsOptionsFor('claude', {}, runtime);
        expect(typeof options.cwd).toBe('string');
        expect(options.timeoutMs).toBeGreaterThan(0);
        expect(options.timeoutMs).toBeLessThanOrEqual(30_000);
    });
});

describe('end to end against the stub CLIs (real prism-acp listModels, nothing faked above the process)', () => {
    const runtime = { execPath: process.execPath, electron: false };
    const claudeStub = resolve('scripts/stub-claude.mjs');
    const codexStub = resolve('scripts/stub-codex.mjs');

    it('Claude: Fable is offered, with what it resolves to, and the default is marked', async () => {
        const cache = new ProviderModelCache((p) => prismListModels(p, listModelsOptionsFor(p, { GENIE2_CLAUDE_BINARY: claudeStub }, runtime)));
        const r = await cache.get('claude');
        expect(r).toMatchObject({ ok: true, current: 'default' });
        if (!r.ok) throw new Error(r.reason);
        expect(r.models.find((m) => m.modelId === 'fable')).toMatchObject({ name: 'Fable', resolvedModel: 'claude-fable-5-1', description: 'Fable for long-running work' });
        expect(r.models.find((m) => m.modelId === 'default')).toMatchObject({ isDefault: true });
        expect(r.models.map((m) => m.modelId)).toEqual(['default', 'fable', 'haiku']);
    }, 20_000);

    it('the account email Claude’s initialize carries never reaches Genie’s answer (CONTROL: the stub does send it)', async () => {
        const raw = spawnSync(process.execPath, [claudeStub], { input: `${JSON.stringify({ type: 'control_request', request_id: 'r1', request: { subtype: 'initialize' } })}\n`, encoding: 'utf8', timeout: 10_000 });
        expect(raw.stdout).toContain('person@example.com');
        const cache = new ProviderModelCache((p) => prismListModels(p, listModelsOptionsFor(p, { GENIE2_CLAUDE_BINARY: claudeStub }, runtime)));
        const r = await cache.get('claude');
        expect(r).toMatchObject({ ok: true });
        expect(JSON.stringify(r)).not.toContain('person@example.com');
        expect(JSON.stringify(r)).not.toContain('@example.com');
    }, 20_000);

    it('Codex: the visible models, the default marked; a hidden one left out (CONTROL: its visible sibling is in)', async () => {
        const cache = new ProviderModelCache((p) => prismListModels(p, listModelsOptionsFor(p, { GENIE2_CODEX_BINARY: codexStub }, runtime)));
        const r = await cache.get('codex');
        expect(r).toMatchObject({ ok: true, current: 'gpt-6.1-sol' });
        if (!r.ok) throw new Error(r.reason);
        expect(r.models.map((m) => m.modelId)).toEqual(['gpt-6.1-sol', 'gpt-6.1-sol-mini']);
        expect(r.models[0]).toMatchObject({ isDefault: true, name: 'GPT-6.1 Sol' });
        expect(r.models.map((m) => m.modelId)).not.toContain('stub-hidden-model');
    }, 20_000);
});

describe('a running agent: its own session answers, and switches without a restart', () => {
    let dir: string;
    let host: SessionHost;
    const switched: string[] = [];
    let withModels = true;
    const driverFor: DriverFor = () => {
        const factory: SessionDriverFactory = () => ({
            start: () => {}, prompt: () => {}, kill: () => {}, get cliSessionId() { return null; },
            ...(withModels ? {
                modelState: async () => state(['default', 'fable'], 'fable', 'default'),
                setModel: async (id: string) => { switched.push(id); },
            } : {}),
        });
        return factory;
    };
    const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie2-models-'));
        switched.length = 0;
        withModels = true;
        host = new SessionHost({ userData: dir, driverFor, clock: () => 1_760_000_000_000, processTree: noProcessTree });
    });
    afterEach(async () => { host.stopAll(); await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });

    it('the host hands over the driver’s modelState and setModel; null when the agent is not running or the driver has neither (CONTROL pair)', async () => {
        const r = agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        expect(host.modelState(r.id)).toBeNull();
        expect(host.switchModel(r.id, 'fable')).toBeNull();
        host.start(r, dir);
        expect(await host.modelState(r.id)).toMatchObject({ currentModelId: 'fable' });
        await host.switchModel(r.id, 'haiku');
        expect(switched).toEqual(['haiku']);

        withModels = false;
        const old = agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'claude', name: 'olde' });
        host.start(old, dir);
        expect(host.modelState(old.id)).toBeNull();
        expect(host.switchModel(old.id, 'fable')).toBeNull();
    });
});

describe('the operations', () => {
    const rec = (provider: string, model?: string) => ({ id: 'agent_a', workspaceId: 'tynn', provider, name: 'atlas', mode: 'manual', accessScope: 'self', ...(model ? { model } : {}) }) as unknown as AgentRecord;
    const harness = (record: AgentRecord, live: { modelState?: () => Promise<SessionModelState>; switchModel?: (id: string) => Promise<void> } | null) => {
        let current = record;
        const calls = { switched: [] as string[], restarts: 0, cacheAsks: [] as Array<{ provider: string; refresh: boolean }> };
        const ports = {
            registry: {
                find: (id: string) => (id === current.id ? current : null),
                setModel: async (_id: unknown, model: string | null) => { const { model: _drop, ...rest } = current as AgentRecord & { model?: string }; current = { ...rest, ...(model === null ? {} : { model }) } as AgentRecord; return current; },
            },
            host: {
                probe: () => null,
                modelState: () => (live?.modelState ? live.modelState() : null),
                switchModel: (_id: string, model: string) => (live?.switchModel ? (calls.switched.push(model), live.switchModel(model)) : null),
            },
            models: { get: async (provider: string, options?: { refresh?: boolean }) => { calls.cacheAsks.push({ provider, refresh: options?.refresh === true }); return { ok: true as const, provider, source: 'provider' as const, models: [{ modelId: 'fable', name: 'Fable' }], current: null }; } },
            applyOnStart: () => { calls.restarts += 1; return { when: 'now' as const }; },
        } as unknown as AgentOpsPorts;
        return { ports, calls, record: () => current };
    };

    it('the list: a running agent’s own session, with no CLI started; not running → the provider cache (CONTROL pair, COUNTED)', async () => {
        const running = harness(rec('claude'), { modelState: async () => state(['default', 'fable'], 'fable', 'default') });
        expect(await listModels(running.ports, 'agent_a')).toMatchObject({ ok: true, source: 'session', current: 'fable', models: [{ modelId: 'default', isDefault: true }, { modelId: 'fable' }] });
        expect(running.calls.cacheAsks).toEqual([]);

        const idle = harness(rec('claude'), null);
        expect(await listModels(idle.ports, 'agent_a', true)).toMatchObject({ ok: true, source: 'provider' });
        expect(idle.calls.cacheAsks).toEqual([{ provider: 'claude', refresh: true }]);
    });

    it('a session that cannot say (its modelState rejects) falls back to the provider’s list; unknown agent refused', async () => {
        const h = harness(rec('codex'), { modelState: async () => { throw new ModelListError('codex refused model/list'); } });
        expect(await listModels(h.ports, 'agent_a')).toMatchObject({ ok: true, source: 'provider' });
        expect(h.calls.cacheAsks).toEqual([{ provider: 'codex', refresh: false }]);
        expect(await listModels(h.ports, 'agent_zz')).toMatchObject({ ok: false });
    });

    it('Claude, running: switched live (no restart), persisted for the next start, and it says it applied at once', async () => {
        const h = harness(rec('claude'), { modelState: async () => state(['default', 'fable'], 'default', 'default'), switchModel: async () => {} });
        expect(await setModel(h.ports, 'agent_a', 'fable')).toMatchObject({ ok: true, record: { model: 'fable' }, apply: { when: 'switched', timing: 'now' } });
        expect(h.calls.switched).toEqual(['fable']);
        expect(h.calls.restarts).toBe(0);
    });

    it('Codex, running: switched from its next turn', async () => {
        const h = harness(rec('codex'), { modelState: async () => state(['gpt-6.1-sol'], 'gpt-6.1-sol', 'gpt-6.1-sol'), switchModel: async () => {} });
        expect(await setModel(h.ports, 'agent_a', 'gpt-6.1-sol-mini')).toMatchObject({ ok: true, apply: { when: 'switched', timing: 'next-turn' } });
        expect(h.calls.restarts).toBe(0);
    });

    it('back to the default on a running agent: switched to the provider’s DEFAULT entry, and the record cleared', async () => {
        const h = harness(rec('claude', 'fable'), { modelState: async () => state(['default', 'fable'], 'fable', 'default'), switchModel: async () => {} });
        const r = await setModel(h.ports, 'agent_a', null);
        expect(r).toMatchObject({ ok: true, apply: { when: 'switched' } });
        expect(h.calls.switched).toEqual(['default']);
        expect('model' in h.record()).toBe(false);
    });

    it('the provider refuses the switch: said in its words, and the choice is NOT kept (CONTROL: an accepted one is)', async () => {
        const h = harness(rec('claude', 'haiku'), { modelState: async () => state(['default']), switchModel: async () => { throw new Error('claude refused set_model: unknown model'); } });
        const r = await setModel(h.ports, 'agent_a', 'nonesuch');
        expect(r).toMatchObject({ ok: false });
        expect((r as { reason: string }).reason).toMatch(/claude refused set_model: unknown model/);
        expect((h.record() as AgentRecord & { model?: string }).model).toBe('haiku');
        expect(h.calls.restarts).toBe(0);
    });

    it('no live switch (not running, or a driver without setModel): persisted, and the start-time path applies it (COUNTED)', async () => {
        const h = harness(rec('claude'), null);
        expect(await setModel(h.ports, 'agent_a', 'fable')).toMatchObject({ ok: true, record: { model: 'fable' }, apply: { when: 'now' } });
        expect(h.calls.switched).toEqual([]);
        expect(h.calls.restarts).toBe(1);
    });

    it('what the view says after a live switch: Claude at once, Codex from its next turn', () => {
        expect(applyOutcome('atlas', 'fable', { when: 'switched', timing: 'now' })).toBe('fable — switched now on the same conversation, no restart: atlas’s next turn runs on it');
        expect(applyOutcome('wren', 'gpt-6.1-sol-mini', { when: 'switched', timing: 'next-turn' })).toBe('gpt-6.1-sol-mini — applies from wren’s next turn, on the same conversation, no restart (a turn already running finishes on its model)');
    });
});

describe('the wire', () => {
    it('agents.models is a READ, scoped to the agent; the remote method passes the refresh through (true only when true)', async () => {
        expect(capabilityOf('agents.models')).toBe('read');
        expect(AGENT_SCOPED_METHODS).toContain('agents.models');
        const seen: Array<[string, boolean]> = [];
        const api = buildHostApi({ agentOps: { models: async (id: string, refresh: boolean) => { seen.push([id, refresh]); return { ok: true }; } } } as unknown as HostApiDeps);
        await api.invoke('agents.models', ['agent_a']);
        await api.invoke('agents.models', ['agent_a', true]);
        await api.invoke('agents.models', ['agent_a', 'yes']);
        expect(seen).toEqual([['agent_a', false], ['agent_a', true], ['agent_a', false]]);
    });
});

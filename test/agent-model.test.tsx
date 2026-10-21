import { claudeArgs, META_MODEL } from '@particle-academy/prism-acp';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { chosenModel, type ModelChoices } from '../src/core/provider-models.js';
import { AGENT_SCOPED_METHODS, capabilityOf } from '../src/core/remote-protocol.js';
import type { LiveSession } from '../src/core/roster.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import { MODEL_META, toStreamEvent } from '../src/core/stream-event.js';
import { setModel, type AgentOpsPorts } from '../src/main/agent-ops-host.js';
import { Registry } from '../src/main/registry.js';
import { SessionHost, claudeOptionsFor, codexOptionsFor, type DriverFor } from '../src/main/session-host.js';
import { Store } from '../src/main/store.js';
import { AgentView, type AgentOpsProps } from '../src/renderer/components/AgentView.js';

/**
 * THE AGENT'S MODEL, SHOWN AND CHOSEN ON ITS AGENT VIEW (the owner: "Show the agent's model and let me change it").
 *
 * Two facts, kept apart. The model CHOSEN is the agent's setting (`AgentRecord.model`; absent = the provider's default)
 * and goes to the driver when the session starts — `--model` for Claude, `model` on thread/start and thread/resume for
 * Codex (prism-acp 0.8.0). The model IN USE is what the provider REPORTS on a notice (`particle.academy/model`), the
 * latest report winning; when it has not said, the view says the provider's default or "not reported yet" and never
 * shows the chosen name as though it were a reading. Genie refuses only what cannot be a model name (empty, or a
 * leading `-` that would read as a flag); which names a provider accepts is the provider's call.
 */
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-model-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });

describe('the record', () => {
    it('set and persisted across a reload; null clears it back to the default; unknown agent → null', async () => {
        const registry = new Registry(new Store(dir));
        await registry.load({ name: 'alphar', healthy: true });
        await registry.addWorkspace({ id: 'tynn', path: '/w/tynn' });
        const a = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        expect(a.model).toBeUndefined();

        expect(await registry.setModel(a.id, 'opus')).toMatchObject({ model: 'opus' });
        const again = new Registry(new Store(dir));
        await again.load({ name: 'alphar', healthy: true });
        expect(again.listAgents().find((r) => r.id === a.id)?.model).toBe('opus');

        const cleared = await registry.setModel(a.id, null);
        expect(cleared).not.toBeNull();
        expect('model' in cleared!).toBe(false);
        const third = new Registry(new Store(dir));
        await third.load({ name: 'alphar', healthy: true });
        expect(third.listAgents().find((r) => r.id === a.id)?.model).toBeUndefined();

        expect(await registry.setModel('agent_nope' as never, 'opus')).toBeNull();
    });
});

describe('the operation', () => {
    const ports = (record: AgentRecord): AgentOpsPorts => {
        let current = record;
        return { registry: { find: (id: string) => (id === current.id ? current : null), setModel: async (_id: unknown, model: string | null) => { current = { ...current, ...(model === null ? {} : { model }) }; return current; } }, host: { probe: () => null } } as unknown as AgentOpsPorts;
    };
    const rec = (provider: string) => ({ id: 'agent_a', workspaceId: 'tynn', provider, name: 'atlas', mode: 'manual', accessScope: 'self' }) as unknown as AgentRecord;

    it('takes a name on any provider; refuses an unknown agent, an empty name and a flag — with a reason, not a throw', async () => {
        expect(await setModel(ports(rec('claude')), 'agent_a', 'sonnet')).toMatchObject({ ok: true, record: { model: 'sonnet' } });
        expect(await setModel(ports(rec('codex')), 'agent_a', 'gpt-5-codex')).toMatchObject({ ok: true, record: { model: 'gpt-5-codex' } });
        expect(await setModel(ports(rec('claude')), 'agent_a', null)).toMatchObject({ ok: true });

        expect(await setModel(ports(rec('claude')), 'agent_zz', 'sonnet')).toMatchObject({ ok: false });
        for (const bad of ['', '   ', '--x']) {
            const r = await setModel(ports(rec('claude')), 'agent_a', bad);
            expect(r).toMatchObject({ ok: false });
            expect((r as { reason: string }).reason.length).toBeGreaterThan(0);
        }
    });

    it('is a write a remote guest needs, scoped to the agent', () => {
        expect(capabilityOf('agents.setModel')).toBe('write');
        expect(AGENT_SCOPED_METHODS).toContain('agents.setModel');
    });
});

describe('the chosen model reaches the provider', () => {
    const claude = (model?: string) => ({ ...agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'claude', name: 'moic' }), ...(model ? { model } : {}) });

    it('Claude: `--model <name>` in the argv when chosen; no `--model` at all when not (positive control pair)', () => {
        const argv = claudeArgs(claudeOptionsFor(claude('haiku'), '/w/tynn', null));
        expect(argv[argv.indexOf('--model') + 1]).toBe('haiku');
        expect(claudeOptionsFor(claude(), '/w/tynn', null)).not.toHaveProperty('model');
        expect(claudeArgs(claudeOptionsFor(claude(), '/w/tynn', null))).not.toContain('--model');
    });

    it('Codex: the chosen model is in the driver’s options (codexOptionsFor, Tynn #797); none = no key, Codex’s own default', () => {
        const codex = (model: string | null) => codexOptionsFor({ provider: 'codex', model } as unknown as AgentRecord, '/w', null, []);
        expect(codex('gpt-5')).toMatchObject({ model: 'gpt-5' });
        expect(codex(null)).not.toHaveProperty('model');
        // ...and the real driver is built from them (a SOURCE check: realDriverFor constructs it).
        expect(readFileSync('src/main/session-host.ts', 'utf8')).toMatch(/new CodexDriver\(\{ \.\.\.codexOptionsFor\(record, cwd, resumeSessionId, /);
    });
});

describe('the reported model', () => {
    it('a notice carrying the key gives the model; one without gives null (positive control pair)', () => {
        expect(MODEL_META).toBe(META_MODEL);
        expect(toStreamEvent({ sessionUpdate: 'notice', notice: { level: 'info', message: 'init' }, _meta: { 'particle.academy/model': 'claude-haiku-5-5' } })).toMatchObject({ kind: 'notice', model: 'claude-haiku-5-5' });
        expect(toStreamEvent({ sessionUpdate: 'notice', notice: { level: 'info', message: 'init' } })).toMatchObject({ kind: 'notice', model: null });
        expect(toStreamEvent({ sessionUpdate: 'notice', notice: { level: 'info', message: 'init' }, _meta: { 'particle.academy/model': '' } })).toMatchObject({ kind: 'notice', model: null });
    });

    describe('on the running session', () => {
        let host: SessionHost;
        let events: DriverEvents = {};
        const driverFor: DriverFor = () => {
            const factory: SessionDriverFactory = (options) => {
                events = options.events;
                return { start: () => {}, prompt: () => {}, kill: () => {}, get cliSessionId() { return null; } };
            };
            return factory;
        };
        const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
        const notice = (message: string, model?: string) => ({ sessionUpdate: 'notice', notice: { level: 'info', message }, ...(model ? { _meta: { 'particle.academy/model': model } } : {}) });

        beforeEach(() => { host = new SessionHost({ userData: dir, driverFor, clock: () => 1_760_000_000_000, processTree: noProcessTree }); });
        afterEach(() => { host.stopAll(); });

        it('null until the provider says; then the LAST one it reported (a reroute), not an earlier one', () => {
            const r = agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'codex', name: 'wren' });
            host.start(r, dir);
            events.onUpdate?.(notice('Codex session started'));
            expect(host.probe(r.id)?.model).toBeNull();

            events.onUpdate?.(notice('thread started', 'gpt-5-codex'));
            expect(host.probe(r.id)?.model).toBe('gpt-5-codex');
            events.onUpdate?.(notice('model rerouted', 'gpt-5-codex-mini'));
            // A later notice that does not say keeps the last report rather than erasing it.
            events.onUpdate?.(notice('plain notice'));
            expect(host.probe(r.id)?.model).toBe('gpt-5-codex-mini');
        });
    });
});

describe('the control', () => {
    const ops = (over: Partial<AgentOpsProps> = {}): AgentOpsProps => ({
        deletePreview: null, diagnosis: null, lastOutcome: null, budgetUsd: null, mode: 'manual', accessScope: 'self', model: null,
        onRestart: () => {}, onSwitchDriver: () => {}, onDiagnose: () => {}, onPreviewDelete: () => {}, onConfirmDelete: () => {}, onCancelDelete: () => {}, onSetBudget: () => {},
        onSetMode: () => {}, onSetAccessScope: () => {}, onSetModel: () => {}, onRefreshModels: () => {},
        ...over,
    });
    const session = (model: string | null): LiveSession => ({
        running: true, turnState: 'idle', startedAt: 1, pendingApproval: null, failure: null, contextUsed: null, contextSize: null,
        lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null, model,
    });
    const render = (provider: string, o?: AgentOpsProps, s: LiveSession | null = null) => renderToStaticMarkup(
        <AgentView agent={{ id: 'agent_a', name: 'atlas', provider, fidelity: 'declared', cwd: '/w/tynn' }} session={s} rows={[]} tab="settings" lanes={null} at={null} selectedId={null} turns={0} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => 1} ops={o} />,
    );
    /** What Claude's initialize answered on 2026-10-21, trimmed: the default (an alias), Fable, Haiku. */
    const claudeList = (over: Partial<Extract<ModelChoices, { ok: true }>> = {}): ModelChoices => ({
        ok: true, provider: 'claude', source: 'provider', current: 'default',
        models: [
            { modelId: 'default', name: 'Default (recommended)', description: 'Use the default model', resolvedModel: 'claude-opus-5-5', isDefault: true },
            { modelId: 'fable', name: 'Fable', description: 'Fable for long-running work', resolvedModel: 'claude-fable-5-1' },
            { modelId: 'haiku', name: 'Haiku', description: 'Fastest for quick answers', resolvedModel: 'claude-haiku-5-5' },
        ],
        ...over,
    });

    /*
     * THE PROVIDER'S MODELS, NEVER A LIST GENIE KEEPS (the owner, 2026-10-21: "make sure that the model selection for
     * agents is using actual available options from the providers. For example, I do not even see fable as an option").
     * The Claude select offered a hardcoded sonnet / opus / haiku, so a model the account HAS (Fable) could not be chosen.
     * The list is now the provider's own (prism-acp 0.22 `listModels` / `modelState`): each by its name, the description
     * as secondary text, what an alias resolves to when that differs, the default marked. Free text only when the
     * provider's list could not be had.
     */
    it('the provider’s list: Fable is there, as "Fable → claude-fable-5-1", the default marked, descriptions kept', () => {
        const html = render('claude', ops({ models: claudeList() }), session(null));
        expect(html).toContain('data-model-select="default"');
        expect(html).toMatch(/<option value="fable" title="Fable for long-running work">Fable → claude-fable-5-1<\/option>/);
        expect(html).toMatch(/<option value="default" title="Use the default model" selected="">Default \(recommended\) → claude-opus-5-5 · default<\/option>/);
        expect(html).toMatch(/<option value="haiku" title="Fastest for quick answers">Haiku → claude-haiku-5-5<\/option>/);
        // The chosen entry's description under the control (none chosen = the provider's default).
        expect(html).toMatch(/<span data-model-description="[^"]*"[^>]*>Use the default model<\/span>/);
    });

    it('the chosen model is the selected entry, and its description is the one shown', () => {
        const html = render('claude', ops({ model: 'fable', models: claudeList() }), session(null));
        expect(html).toContain('data-model-select="fable"');
        expect(html).toMatch(/<option value="fable" title="Fable for long-running work" selected="">/);
        expect(html).toMatch(/data-model-description[^>]*>Fable for long-running work</);
    });

    it('nothing invented: only the provider’s entries are offered, and no free-text field (CONTROL: its entries are)', () => {
        const html = render('claude', ops({ models: claudeList() }), session('claude-opus-5-5'));
        for (const invented of ['sonnet', 'opus', 'claude-opus-5-5']) expect(html).not.toContain(`<option value="${invented}"`);
        // COUNTED inside the model's own select (the page has other selects: who may message it, …).
        const select = /<select data-model-select[^>]*>(.*?)<\/select>/.exec(html)?.[1] ?? '';
        expect((select.match(/<option value=/g) ?? []).length).toBe(3);
        expect(html).not.toContain('data-model-input');
        expect(html).not.toContain('<datalist');
    });

    it('a chosen model the provider no longer lists is still shown as chosen — said as not in its list, never dropped', () => {
        const html = render('claude', ops({ model: 'claude-fable-5-0', models: claudeList() }), session(null));
        expect(html).toContain('data-model-select="claude-fable-5-0"');
        expect(html).toMatch(/<option value="claude-fable-5-0" selected="">claude-fable-5-0 — not in claude’s list<\/option>/);
        // CONTROL: a listed choice gets no such entry.
        expect(render('claude', ops({ model: 'fable', models: claudeList() }), session(null))).not.toContain('not in claude’s list');
    });

    it('the model IN USE is the running session’s own (modelState), marked in the list', () => {
        const html = render('claude', ops({ model: 'fable', models: claudeList({ source: 'session', current: 'fable' }) }), session(null));
        expect(html).toMatch(/Model <span class="font-mono[^"]*">Fable → claude-fable-5-1<\/span>/);
        expect(html).toMatch(/>Fable → claude-fable-5-1 · in use<\/option>/);
        // CONTROL: the provider's list for no session marks nothing in use — its `current` is only the provider default.
        expect(render('claude', ops({ models: claudeList() }), session(null))).not.toContain('· in use');
    });

    it('with no session list, the model the provider REPORTED on a notice is still the reading; nothing reported says so', () => {
        expect(render('claude', ops({ models: claudeList() }), session('claude-opus-5-5'))).toMatch(/Model <span class="font-mono[^"]*">claude-opus-5-5<\/span>/);
        expect(render('claude', ops({ models: claudeList() }), session(null))).toMatch(/the provider(&#x27;|')s default/);
        const chosen = render('claude', ops({ model: 'haiku', models: claudeList() }), session(null));
        expect(chosen).toContain('not reported yet');
        expect(chosen).not.toMatch(/font-mono[^"]*">haiku</);
    });

    it('a provider with no default entry: "the provider’s default" is an entry of its own (CONTROL: Claude, which marks one, has none)', () => {
        const codex: ModelChoices = { ok: true, provider: 'codex', source: 'provider', current: null, models: [{ modelId: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }] };
        const html = render('codex', ops({ models: codex }));
        expect(html).toMatch(/<option value="" selected="">the provider(&#x27;|')s default<\/option>/);
        expect(render('claude', ops({ models: claudeList() }))).not.toMatch(/<option value="">/);
    });

    it('when a change applies, said per provider: Claude at once, Codex from the next turn — no restart', () => {
        expect(render('claude', ops({ models: claudeList() }))).toMatch(/A change applies at once — atlas’s running session switches models on the same conversation\./);
        const codex: ModelChoices = { ok: true, provider: 'codex', source: 'provider', current: 'gpt-6.1-sol', models: [{ modelId: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', isDefault: true }] };
        expect(render('codex', ops({ models: codex }))).toMatch(/A change applies from atlas’s next turn — a turn already running finishes on the model it began with\./);
        expect(render('claude', ops({ models: claudeList() }))).not.toMatch(/it restarts on the same conversation/);
    });

    it('the list can be asked for again', () => {
        expect(render('claude', ops({ models: claudeList() }))).toContain('data-action="models-refresh"');
    });

    it('while the provider is asked: said, and no control yet', () => {
        const html = render('claude', ops({ models: 'loading' }));
        expect(html).toContain('data-model-list="loading"');
        expect(html).toMatch(/Asking claude for its models…/);
        expect(html).not.toContain('data-model-select');
        expect(html).not.toContain('data-model-input');
    });

    it('the provider would not say: "couldn’t get the list: <reason>", a retry, and a free-text field (CONTROL: a list has none)', () => {
        const html = render('claude', ops({ model: 'fable', models: { ok: false, provider: 'claude', reason: 'claude did not answer the model list within 30000 ms' } }));
        expect(html).toContain('data-model-list="failed"');
        expect(html).toMatch(/Couldn’t get claude’s list of models: claude did not answer the model list within 30000 ms/);
        expect(html).toContain('data-action="models-refresh"');
        expect(html).toContain('data-model-input="fable"');
        expect(html).toContain('placeholder="provider default"');
        expect(html).not.toContain('data-model-select');
        expect(render('claude', ops({ model: 'fable', models: claudeList() }))).not.toContain('data-model-input');
    });

    it('a host that cannot list models (older): the free-text field, suggesting only what the provider reported', () => {
        const html = render('claude', ops({ model: 'claude-fable-5-1' }), session('claude-opus-5-5'));
        expect(html).toContain('data-model-input="claude-fable-5-1"');
        expect(html).toMatch(/<datalist id="[^"]+"><option value="claude-opus-5-5"><\/option><\/datalist>/);
        expect(html).not.toContain('data-model-select');
    });

    it('choosing: the default entry (or the empty one) clears the choice; anything else is that model', () => {
        const list = claudeList();
        expect(chosenModel('default', list)).toBeNull();
        expect(chosenModel('', list)).toBeNull();
        expect(chosenModel('fable', list)).toBe('fable');
        expect(chosenModel('fable', { ok: false, provider: 'claude', reason: 'x' })).toBe('fable');
    });

    it('no ops (a window that cannot set it): no control (positive control: the same agent with ops draws one)', () => {
        expect(render('claude', undefined, session('claude-opus-5-5'))).not.toContain('data-model-');
        expect(render('claude', ops({ models: claudeList() }), session('claude-opus-5-5'))).toContain('data-model-select');
    });
});

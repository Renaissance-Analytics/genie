import { claudeArgs, META_MODEL } from '@particle-academy/prism-acp';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { AGENT_SCOPED_METHODS, capabilityOf } from '../src/core/remote-protocol.js';
import type { LiveSession } from '../src/core/roster.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import { MODEL_META, toStreamEvent } from '../src/core/stream-event.js';
import { setModel, type AgentOpsPorts } from '../src/main/agent-ops-host.js';
import { Registry } from '../src/main/registry.js';
import { SessionHost, claudeOptionsFor, type DriverFor } from '../src/main/session-host.js';
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
        return { registry: { find: (id: string) => (id === current.id ? current : null), setModel: async (_id: unknown, model: string | null) => { current = { ...current, ...(model === null ? {} : { model }) }; return current; } } } as unknown as AgentOpsPorts;
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

    it('Codex: the chosen model is passed into CodexDriver options (a SOURCE check — realDriverFor constructs the real driver, so there is no seam to observe it through)', () => {
        const source = readFileSync('src/main/session-host.ts', 'utf8');
        expect(source).toMatch(/new CodexDriver\(\{[^}]*model: record\.model/);
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
        const noProcessTree: ProcessTree = { descendantsOf: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
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
        onSetMode: () => {}, onSetAccessScope: () => {}, onSetModel: () => {},
        ...over,
    });
    const session = (model: string | null): LiveSession => ({
        running: true, turnState: 'idle', startedAt: 1, pendingApproval: null, failure: null, contextUsed: null, contextSize: null,
        lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null, model,
    });
    const render = (provider: string, o?: AgentOpsProps, s: LiveSession | null = null) => renderToStaticMarkup(
        <AgentView agent={{ id: 'agent_a', name: 'atlas', provider, fidelity: 'declared', cwd: '/w/tynn' }} session={s} rows={[]} tab="settings" lanes={null} at={null} selectedId={null} turns={0} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => 1} ops={o} />,
    );

    it('a Claude agent: the reported model, a select with the chosen one selected, and when a change applies', () => {
        const html = render('claude', ops({ model: 'opus' }), session('claude-opus-5-5'));
        expect(html).toContain('data-model-select="opus"');
        expect(html).toMatch(/<option value=""[^>]*>default<\/option>/);
        expect(html).toMatch(/<option value="opus" selected=""[^>]*>opus<\/option>/);
        expect(html).toMatch(/<option value="sonnet"[^>]*>sonnet<\/option>/);
        expect(html).toMatch(/Model <span class="font-mono[^"]*">claude-opus-5-5<\/span>/);
        // Live, not 'next start' (the owner, 2026-10-14): idle = now, mid-turn = when the turn ends, same conversation.
        expect(html).toMatch(/A change applies at once while atlas is idle, or when its turn ends — it restarts on the same conversation\./);
        expect(html).not.toMatch(/applies when atlas next starts/);
    });

    it('a chosen full id that is not an alias is kept as its own option', () => {
        expect(render('claude', ops({ model: 'claude-sonnet-5-5' }))).toMatch(/<option value="claude-sonnet-5-5" selected=""[^>]*>claude-sonnet-5-5<\/option>/);
    });

    it('nothing reported: the provider default when none is chosen, "not reported yet" when one is — never the chosen name as a reading', () => {
        const none = render('claude', ops(), session(null));
        expect(none).toMatch(/the provider(&#x27;|')s default/);
        expect(none).toMatch(/<option value="" selected=""[^>]*>default<\/option>/);
        const chosen = render('claude', ops({ model: 'haiku' }), session(null));
        expect(chosen).toContain('not reported yet');
        expect(chosen).not.toMatch(/font-mono[^"]*">haiku</);
    });

    it('a Codex agent: a text field holding the chosen model, with the default as its placeholder', () => {
        const html = render('codex', ops({ model: 'gpt-5-codex' }));
        expect(html).toContain('data-model-input="gpt-5-codex"');
        expect(html).toContain('value="gpt-5-codex"');
        expect(html).toContain('placeholder="provider default"');
        expect(html).not.toContain('data-model-select');
    });

    it('no ops (a window that cannot set it): no control (positive control: the same agent with ops draws one)', () => {
        expect(render('claude', undefined, session('claude-opus-5-5'))).not.toContain('data-model-');
        expect(render('claude', ops(), session('claude-opus-5-5'))).toContain('data-model-select');
    });
});

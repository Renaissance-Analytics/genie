import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentRecord } from '../src/core/identity.js';
import type { ModelChoices } from '../src/core/provider-models.js';
import type { LiveSession } from '../src/core/roster.js';
import { deleteAgent, diagnose, previewDelete, restartAgent, setBudget, switchDriver, type AgentOpsPorts } from '../src/main/agent-ops-host.js';

/**
 * AGENT OPERATIONS IN THE APP (§6.2) — the main-process half over the pure plans. Restart (graceful)
 * resumes the SAME thread from every state and delivers what is owed (genie#1238); fresh clears the
 * thread; delete is previewed with its plan BEFORE it acts and the cross-system opt-in is in
 * the same call; switch driver reads the persona's `tuis:`; a budget is set and immediately judged
 * (unenforceable when the provider reports no cost); diagnose names a cause and a fitting repair.
 */

const record = (over: Partial<AgentRecord> = {}): AgentRecord =>
    ({ id: 'agent_a', workspaceId: 'tynn', provider: 'claude', name: 'atlas', instructions: '.agents/atlas/AGENT.md', threadId: 'sess-1', createdAt: 't', lastUsedAt: 't', mode: 'manual', accessScope: 'self', ...over }) as unknown as AgentRecord;

function fakes(over: { record?: AgentRecord; probe?: LiveSession | null; manifest?: string | null; installed?: boolean; signedIn?: boolean; linked?: string[]; models?: Record<string, ModelChoices>; realPaths?: Record<string, string | null>; handoffLandsAfterMs?: number | null } = {}) {
    let current: AgentRecord | null = over.record ?? record();
    const calls: string[] = [];
    const asked: string[] = [];
    let clock = 1_000;
    const ports: AgentOpsPorts = {
        registry: {
            find: (id) => (current && current.id === id ? current : null),
            forget: async (id) => { if (!current || current.id !== id) return false; calls.push(`forget:${id}`); current = null; return true; },
            clearThread: async (id) => { if (!current || current.id !== id) return null; current = { ...current, threadId: null }; calls.push(`clearThread:${id}`); return current; },
            setProvider: async (id, provider, options) => { if (!current || current.id !== id) return { ok: false, reason: 'no agent' }; const { model: _previous, ...rest } = current; current = { ...(options.keepModel ? current : rest), provider: provider as never, threadId: null }; calls.push(`setProvider:${id}:${provider}:keepModel=${options.keepModel}`); return { ok: true, record: current }; },
            setBudget: async (id, usd) => { if (!current || current.id !== id) return null; current = { ...current, dailyBudgetUsd: usd } as AgentRecord; calls.push(`setBudget:${id}:${usd}`); return current; },
            setMode: async (id, mode) => { if (!current || current.id !== id) return null; current = { ...current, mode }; return current; },
            setAccessScope: async (id, accessScope) => { if (!current || current.id !== id) return null; current = { ...current, accessScope }; return current; },
            setAutoApprove: async (id, autoApprove) => { if (!current || current.id !== id) return null; current = { ...current, autoApprove }; return current; },
            setManageTabs: async (id, manageTabs) => { if (!current || current.id !== id) return null; current = { ...current, manageTabs }; return current; },
            setDrivePages: async (id, drivePages) => { if (!current || current.id !== id) return null; current = { ...current, drivePages }; return current; },
            setIssueWatch: async (id, issueWatch) => { if (!current || current.id !== id) return null; current = { ...current, issueWatch }; return current; },
            setPermissions: async (id, permissions) => { if (!current || current.id !== id) return null; current = { ...current, permissions }; return current; },
            setModel: async (id, model) => { if (!current || current.id !== id) return null; const { model: _previous, ...rest } = current; current = model === null ? rest : { ...rest, model }; return current; },
        },
        host: {
            start: (r, cwd) => { calls.push(`start:${r.id}:${r.threadId}:${cwd}`); return { ok: true }; },
            stop: (id) => { calls.push(`stop:${id}`); return true; },
            ended: async (id) => { calls.push(`ended:${id}`); return null; },
            probe: () => over.probe ?? null,
            deliverOwed: async (id) => { calls.push(`deliverOwed:${id}`); return 0; },
        },
        startRefusal: () => null,
        ...(over.models ? { models: { get: async (provider: string) => over.models![provider] ?? { ok: false, provider, reason: 'no list' } } } : {}),
        cwdFor: () => '/w/tynn',
        workspacePathFor: () => '/w/tynn',
        readManifest: async () => over.manifest ?? null,
        removeDir: async (path) => { calls.push(`rmdir:${path}`); },
        // The filesystem's own answer for where a path really is (symlinks followed); `null` = nothing there.
        realPath: async (path) => (over.realPaths && resolve(path) in over.realPaths ? over.realPaths[resolve(path)]! : resolve(path)),
        removeHandoff: async (r) => { calls.push(`rmhandoff:${r.name}`); },
        // A fake clock: sleeping moves it, and the handoff "lands" once `handoffLandsAfterMs` has passed since the ask.
        handoff: {
            ask: (id, text) => { calls.push(`ask-handoff:${id}`); asked.push(text); return true; },
            landedSince: (_id, since) => over.handoffLandsAfterMs !== undefined && over.handoffLandsAfterMs !== null && clock >= since + over.handoffLandsAfterMs,
            now: () => clock,
            sleep: async (ms) => { clock += ms; },
            waitMs: 45_000,
            pollMs: 1_000,
        },
        linkedSystems: () => over.linked ?? [],
        providerInstalled: () => over.installed ?? true,
        signedIn: () => over.signedIn ?? true,
    };
    return { ports, calls, asked, current: () => current, clock: () => clock };
}

describe('restart', () => {
    it('graceful (Restart, genie#1238): stops and starts with the SAME thread, then delivers what is owed — a never-started and a wedged agent too', async () => {
        const f = fakes();
        expect(await restartAgent(f.ports, 'agent_a', 'graceful')).toEqual({ ok: true, kind: 'graceful' });
        expect(f.calls).toEqual(['stop:agent_a', 'ended:agent_a', 'start:agent_a:sess-1:/w/tynn', 'deliverOwed:agent_a']);

        const none = fakes({ record: record({ threadId: null }) });
        expect(await restartAgent(none.ports, 'agent_a', 'graceful')).toEqual({ ok: true, kind: 'graceful' });
        expect(none.calls).toEqual(['stop:agent_a', 'ended:agent_a', 'start:agent_a:null:/w/tynn', 'deliverOwed:agent_a']);

        const wedged = fakes({ probe: { running: true, turnState: 'failed', startedAt: 1, pendingApproval: null, failure: { reason: 'crashed', fixes: [] } } as unknown as LiveSession });
        expect(await restartAgent(wedged.ports, 'agent_a', 'graceful')).toEqual({ ok: true, kind: 'graceful' });
        expect(wedged.calls).toEqual(['stop:agent_a', 'ended:agent_a', 'start:agent_a:sess-1:/w/tynn', 'deliverOwed:agent_a']);
    });

    it('fresh: starts with no thread, then clears the stored one — only once the start went ahead; works on a wedged agent; an unknown agent is refused', async () => {
        const f = fakes({ probe: { running: true, turnState: 'failed', startedAt: 1, pendingApproval: null, failure: { reason: 'x', fixes: [] } } as unknown as LiveSession });
        expect(await restartAgent(f.ports, 'agent_a', 'fresh')).toEqual({ ok: true, kind: 'fresh', discarded: 'sess-1' });
        expect(f.calls).toEqual(['stop:agent_a', 'ended:agent_a', 'start:agent_a:null:/w/tynn', 'clearThread:agent_a']);
        expect(await restartAgent(fakes().ports, 'agent_zz', 'fresh')).toEqual({ ok: false, reason: 'unknown agent' });
    });
});

describe('delete', () => {
    it('preview lists what goes, what stays and the linked systems with their opt-in — and touches nothing', async () => {
        const f = fakes({ linked: ['tynn'] });
        const p = await previewDelete(f.ports, 'agent_a', 'unmount', []);
        expect(p).toMatchObject({ ok: true, plan: { outcome: 'unmount', keeps: expect.arrayContaining(['.agents/atlas/ (every file)']), external: [{ system: 'tynn', action: 'kept', optIn: 'alsoRemoveFrom: ["tynn"]' }] } });
        expect(f.calls).toEqual([]);
        expect(await previewDelete(f.ports, 'agent_a', 'unmount', ['github'])).toEqual({ ok: false, reason: 'atlas is not linked to github; nothing to remove there' });
    });

    it('unmount stops and forgets, keeps the folder; delete also removes .agents/<name> and the handoff; the record is gone either way', async () => {
        const u = fakes();
        expect(await deleteAgent(u.ports, 'agent_a', 'unmount', [])).toMatchObject({ ok: true, plan: { outcome: 'unmount' } });
        expect(u.calls).toEqual(['stop:agent_a', 'forget:agent_a']);
        expect(u.current()).toBeNull();

        const d = fakes({ linked: ['tynn'] });
        expect(await deleteAgent(d.ports, 'agent_a', 'delete', ['tynn'])).toMatchObject({ ok: true, plan: { outcome: 'delete', external: [{ system: 'tynn', action: 'removed' }] } });
        // The host joins the persona folder with the OS's separator; on Windows that is backslashes.
        expect(d.calls).toEqual(['stop:agent_a', 'forget:agent_a', `rmdir:${join('/w/tynn', '.agents', 'atlas')}`, 'rmhandoff:atlas']);
    });
});

describe('switch driver', () => {
    it('reads the persona’s tuis and refuses a provider it does not list, in the persona’s words; otherwise stops and switches, carrying identity, inbox, history and prompt', async () => {
        const gated = fakes({ manifest: '---\nname: atlas\ntuis: [claude]\n---\n' });
        expect(await switchDriver(gated.ports, 'agent_a', 'codex')).toEqual({ ok: false, reason: 'atlas’s AGENT.md allows tuis: claude; codex is not among them' });
        expect(gated.calls).toEqual([]);

        const open = fakes({ manifest: '---\nname: atlas\n---\n' });
        expect(await switchDriver(open.ports, 'agent_a', 'codex')).toEqual({ ok: true, carries: ['identity', 'inbox', 'history', 'prompt'], from: 'claude', to: 'codex', discarded: 'sess-1', droppedModel: null });
        expect(open.calls).toEqual(['stop:agent_a', 'ended:agent_a', 'setProvider:agent_a:codex:keepModel=false']);
        expect(open.current()?.provider).toBe('codex');

        expect(await switchDriver(fakes().ports, 'agent_a', 'claude')).toMatchObject({ ok: true, noop: true });
        expect(await switchDriver(fakes().ports, 'agent_a', 'kimi')).toMatchObject({ ok: false, reason: expect.stringMatching(/cannot run a "kimi"/) });
    });
});

describe('switch driver starts the new provider clean', () => {
    const codexModels = (...ids: string[]): ModelChoices => ({ ok: true, provider: 'codex', source: 'provider', models: ids.map((modelId) => ({ modelId, name: modelId })) as never, current: null });

    it('a Claude thread and a Claude model never reach Codex: the switch says the conversation it left and the model it dropped', async () => {
        const f = fakes({ record: record({ threadId: 'claude-sess-9', model: 'opus' } as Partial<AgentRecord>), models: { codex: codexModels('gpt-5.1-codex', 'gpt-5.1') } });
        expect(await switchDriver(f.ports, 'agent_a', 'codex')).toEqual({ ok: true, carries: ['identity', 'inbox', 'history', 'prompt'], from: 'claude', to: 'codex', discarded: 'claude-sess-9', droppedModel: 'opus' });
        expect(f.calls).toEqual(['stop:agent_a', 'ended:agent_a', 'setProvider:agent_a:codex:keepModel=false']);
        expect(f.current()).toMatchObject({ provider: 'codex', threadId: null, name: 'atlas' });
        expect(f.current()?.model).toBeUndefined();
    });

    it('a model the NEW provider lists is kept — the list is the provider’s, never one Genie made up', async () => {
        const f = fakes({ record: record({ model: 'gpt-5.1' } as Partial<AgentRecord>), models: { codex: codexModels('gpt-5.1-codex', 'gpt-5.1') } });
        expect(await switchDriver(f.ports, 'agent_a', 'codex')).toMatchObject({ ok: true, droppedModel: null });
        expect(f.calls).toEqual(['stop:agent_a', 'ended:agent_a', 'setProvider:agent_a:codex:keepModel=true']);
        expect(f.current()?.model).toBe('gpt-5.1');
    });

    it('when the new provider cannot say what it runs, the model is dropped (back to its default) rather than guessed', async () => {
        const f = fakes({ record: record({ model: 'opus' } as Partial<AgentRecord>), models: {} });
        expect(await switchDriver(f.ports, 'agent_a', 'codex')).toMatchObject({ ok: true, droppedModel: 'opus' });
        const none = fakes({ record: record({ model: 'opus' } as Partial<AgentRecord>) });
        expect(await switchDriver(none.ports, 'agent_a', 'codex')).toMatchObject({ ok: true, droppedModel: 'opus' });
    });

    it('a never-run agent has no conversation to leave: discarded is null', async () => {
        const f = fakes({ record: record({ threadId: null }) });
        expect(await switchDriver(f.ports, 'agent_a', 'codex')).toMatchObject({ ok: true, discarded: null, droppedModel: null });
    });
});

describe('delete only ever removes a folder inside the workspace’s .agents/', () => {
    const agents = resolve('/w/tynn', '.agents');

    it.each([
        ['..', 'the workspace itself'],
        ['../../etc', 'outside the workspace'],
        ['.', '.agents/ itself — every agent’s files'],
        ['', '.agents/ itself — every agent’s files'],
    ])('a name of %j (%s) is refused before anything is stopped, forgotten or removed — preview and delete alike', async (name) => {
        const f = fakes({ record: record({ name } as Partial<AgentRecord>) });
        expect(await previewDelete(f.ports, 'agent_a', 'delete', [])).toMatchObject({ ok: false, reason: expect.stringMatching(/not inside .*[.]agents/) });
        expect(await deleteAgent(f.ports, 'agent_a', 'delete', [])).toMatchObject({ ok: false, reason: expect.stringMatching(/not inside .*[.]agents/) });
        expect(f.calls).toEqual([]);
        expect(f.current()).not.toBeNull();
    });

    it('a persona folder that is a SYMLINK out of .agents/ is refused and nothing is touched', async () => {
        const f = fakes({ realPaths: { [resolve(agents, 'atlas')]: resolve('/home/someone/precious') } });
        expect(await deleteAgent(f.ports, 'agent_a', 'delete', [])).toMatchObject({ ok: false, reason: expect.stringMatching(/precious/) });
        expect(f.calls).toEqual([]);
    });

    it('a .agents/ that is itself a symlink is judged where it really is: a folder inside it is still inside', async () => {
        const real = resolve('/data/tynn-agents');
        const f = fakes({ realPaths: { [agents]: real, [resolve(agents, 'atlas')]: resolve(real, 'atlas') } });
        expect(await deleteAgent(f.ports, 'agent_a', 'delete', [])).toMatchObject({ ok: true });
        expect(f.calls).toContain(`rmdir:${join('/w/tynn', '.agents', 'atlas')}`);
    });

    it('a persona folder already gone is no reason to refuse: the record still goes', async () => {
        const f = fakes({ realPaths: { [resolve(agents, 'atlas')]: null } });
        expect(await deleteAgent(f.ports, 'agent_a', 'delete', [])).toMatchObject({ ok: true });
        expect(f.current()).toBeNull();
    });

    it('UNMOUNT removes no file, so a bad name does not stop an unmount', async () => {
        const f = fakes({ record: record({ name: '..' } as Partial<AgentRecord>) });
        expect(await deleteAgent(f.ports, 'agent_a', 'unmount', [])).toMatchObject({ ok: true });
        expect(f.calls).toEqual(['stop:agent_a', 'forget:agent_a']);
    });
});

describe('ask for a handoff first (Genie 1’s AgentDeleteModal)', () => {
    const running = { running: true, turnState: 'idle', startedAt: 1, pendingApproval: null, failure: null } as unknown as LiveSession;

    it('a running agent is asked to call imDone with a handoff BEFORE it is stopped; once it lands the delete goes on and says so', async () => {
        const f = fakes({ probe: running, handoffLandsAfterMs: 3_000 });
        const r = await deleteAgent(f.ports, 'agent_a', 'delete', [], { handoff: true });
        expect(r).toMatchObject({ ok: true, handoff: 'landed' });
        // The note it just wrote (.ai/handoff/atlas.md) is the point of asking: the delete keeps it, and its plan says so.
        expect(f.calls).toEqual(['ask-handoff:agent_a', 'stop:agent_a', 'forget:agent_a', `rmdir:${join('/w/tynn', '.agents', 'atlas')}`]);
        expect(r.ok && r.plan.keeps).toContain('its stored handoff');
        expect(r.ok && r.plan.removes).not.toContain('its stored handoff');
        expect(f.asked[0]).toMatch(/imDone/);
        expect(f.asked[0]).toMatch(/handoff/);
        expect(f.asked[0]).toMatch(/deleted/);
        // It waited only as long as the handoff took, not the whole bound.
        expect(f.clock() - 1_000).toBeLessThan(10_000);
    });

    it('the wait is BOUNDED: no handoff in time, and the unmount still happens — said as missing, never as landed', async () => {
        const f = fakes({ probe: running, handoffLandsAfterMs: null });
        expect(await deleteAgent(f.ports, 'agent_a', 'unmount', [], { handoff: true })).toMatchObject({ ok: true, handoff: 'missing' });
        expect(f.calls).toEqual(['ask-handoff:agent_a', 'stop:agent_a', 'forget:agent_a']);
        expect(f.asked[0]).toMatch(/unmounted/);
        expect(f.clock() - 1_000).toBeGreaterThanOrEqual(45_000);
        expect(f.clock() - 1_000).toBeLessThan(47_000);
    });

    it('an agent that is not running has nobody to ask: no prompt, no wait', async () => {
        const f = fakes({ probe: null, handoffLandsAfterMs: 0 });
        expect(await deleteAgent(f.ports, 'agent_a', 'unmount', [], { handoff: true })).toMatchObject({ ok: true, handoff: 'not-running' });
        expect(f.calls).toEqual(['stop:agent_a', 'forget:agent_a']);
        expect(f.clock()).toBe(1_000);
    });

    it('not asked for → not asked; and a REFUSED delete asks nobody', async () => {
        const f = fakes({ probe: running, handoffLandsAfterMs: 0 });
        expect(await deleteAgent(f.ports, 'agent_a', 'unmount', [])).toMatchObject({ ok: true, handoff: 'not-asked' });
        expect(f.calls).toEqual(['stop:agent_a', 'forget:agent_a']);

        const bad = fakes({ record: record({ name: '..' } as Partial<AgentRecord>), probe: running, handoffLandsAfterMs: 0 });
        expect(await deleteAgent(bad.ports, 'agent_a', 'delete', [], { handoff: true })).toMatchObject({ ok: false });
        expect(bad.calls).toEqual([]);
    });
});

describe('budget and diagnose', () => {
    it('setBudget stores the limit and judges it at once: no provider reports cost today, so it is UNENFORCEABLE and says so', async () => {
        const f = fakes();
        const r = await setBudget(f.ports, 'agent_a', 5);
        expect(r).toMatchObject({ ok: true, record: { dailyBudgetUsd: 5 }, decision: { kind: 'unenforceable' } });
        expect(await setBudget(f.ports, 'agent_a', null)).toMatchObject({ ok: true, decision: { kind: 'proceed', remainingUsd: null } });
        expect(await setBudget(f.ports, 'agent_zz', 5)).toEqual({ ok: false, reason: 'unknown agent' });
    });

    it('diagnose names a cause and a fitting repair; a never-run agent is dormant and no fault', async () => {
        expect(await diagnose(fakes({ record: record({ threadId: null, lastUsedAt: null }) }).ports, 'agent_a')).toMatchObject({ ok: true, diagnosis: { state: 'dormant', fault: false } });
        expect(await diagnose(fakes({ installed: false }).ports, 'agent_a')).toMatchObject({ ok: true, diagnosis: { state: 'broken', cause: 'claude is not installed', repair: { action: 'install-provider' } } });
        expect(await diagnose(fakes({ probe: { running: true, turnState: 'working', startedAt: 1, pendingApproval: null, failure: null } as unknown as LiveSession }).ports, 'agent_a')).toMatchObject({ ok: true, diagnosis: { state: 'healthy', fault: false } });
        expect(await diagnose(fakes().ports, 'agent_zz')).toEqual({ ok: false, reason: 'unknown agent' });
    });
});

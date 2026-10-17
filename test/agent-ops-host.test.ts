import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentRecord } from '../src/core/identity.js';
import type { LiveSession } from '../src/core/roster.js';
import { deleteAgent, diagnose, previewDelete, restartAgent, setBudget, switchDriver, type AgentOpsPorts } from '../src/main/agent-ops-host.js';

/**
 * AGENT OPERATIONS IN THE APP (§6.2) — the main-process half over the pure plans. Restart is two
 * named operations (graceful resumes the SAME thread and refuses when it cannot; fresh clears the
 * thread first); delete is previewed with its plan BEFORE it acts and the cross-system opt-in is in
 * the same call; switch driver reads the persona's `tuis:`; a budget is set and immediately judged
 * (unenforceable when the provider reports no cost); diagnose names a cause and a fitting repair.
 */

const record = (over: Partial<AgentRecord> = {}): AgentRecord =>
    ({ id: 'agent_a', workspaceId: 'tynn', provider: 'claude', name: 'atlas', instructions: '.agents/atlas/AGENT.md', threadId: 'sess-1', createdAt: 't', lastUsedAt: 't', mode: 'manual', accessScope: 'self', ...over }) as unknown as AgentRecord;

function fakes(over: { record?: AgentRecord; probe?: LiveSession | null; manifest?: string | null; installed?: boolean; signedIn?: boolean; linked?: string[] } = {}) {
    let current: AgentRecord | null = over.record ?? record();
    const calls: string[] = [];
    const ports: AgentOpsPorts = {
        registry: {
            find: (id) => (current && current.id === id ? current : null),
            forget: async (id) => { if (!current || current.id !== id) return false; calls.push(`forget:${id}`); current = null; return true; },
            clearThread: async (id) => { if (!current || current.id !== id) return null; current = { ...current, threadId: null }; calls.push(`clearThread:${id}`); return current; },
            setProvider: async (id, provider) => { if (!current || current.id !== id) return { ok: false, reason: 'no agent' }; current = { ...current, provider: provider as never }; calls.push(`setProvider:${id}:${provider}`); return { ok: true, record: current }; },
            setBudget: async (id, usd) => { if (!current || current.id !== id) return null; current = { ...current, dailyBudgetUsd: usd } as AgentRecord; calls.push(`setBudget:${id}:${usd}`); return current; },
            setMode: async (id, mode) => { if (!current || current.id !== id) return null; current = { ...current, mode }; return current; },
            setAccessScope: async (id, accessScope) => { if (!current || current.id !== id) return null; current = { ...current, accessScope }; return current; },
            setAutoApprove: async (id, autoApprove) => { if (!current || current.id !== id) return null; current = { ...current, autoApprove }; return current; },
            setPermissions: async (id, permissions) => { if (!current || current.id !== id) return null; current = { ...current, permissions }; return current; },
            setModel: async (id, model) => { if (!current || current.id !== id) return null; const { model: _previous, ...rest } = current; current = model === null ? rest : { ...rest, model }; return current; },
        },
        host: {
            start: (r, cwd) => { calls.push(`start:${r.id}:${r.threadId}:${cwd}`); return { ok: true }; },
            stop: (id) => { calls.push(`stop:${id}`); return true; },
            probe: () => over.probe ?? null,
        },
        cwdFor: () => '/w/tynn',
        workspacePathFor: () => '/w/tynn',
        readManifest: async () => over.manifest ?? null,
        removeDir: async (path) => { calls.push(`rmdir:${path}`); },
        removeHandoff: async (r) => { calls.push(`rmhandoff:${r.name}`); },
        linkedSystems: () => over.linked ?? [],
        providerInstalled: () => over.installed ?? true,
        signedIn: () => over.signedIn ?? true,
    };
    return { ports, calls, current: () => current };
}

describe('restart', () => {
    it('graceful: stops and starts with the SAME thread; refused when there is no thread or the agent is wedged — never a silent new chat', async () => {
        const f = fakes();
        expect(await restartAgent(f.ports, 'agent_a', 'graceful')).toEqual({ ok: true, kind: 'graceful' });
        expect(f.calls).toEqual(['stop:agent_a', 'start:agent_a:sess-1:/w/tynn']);

        const none = fakes({ record: record({ threadId: null }) });
        expect(await restartAgent(none.ports, 'agent_a', 'graceful')).toMatchObject({ ok: false, reason: expect.stringMatching(/no conversation to resume/) });
        expect(none.calls).toEqual([]);

        const wedged = fakes({ probe: { running: true, turnState: 'failed', startedAt: 1, pendingApproval: null, failure: { reason: 'crashed', fixes: [] } } as unknown as LiveSession });
        expect(await restartAgent(wedged.ports, 'agent_a', 'graceful')).toMatchObject({ ok: false, reason: expect.stringMatching(/only a fresh restart/) });
    });

    it('fresh: clears the thread FIRST, then starts with none; works on a wedged agent; an unknown agent is refused', async () => {
        const f = fakes({ probe: { running: true, turnState: 'failed', startedAt: 1, pendingApproval: null, failure: { reason: 'x', fixes: [] } } as unknown as LiveSession });
        expect(await restartAgent(f.ports, 'agent_a', 'fresh')).toEqual({ ok: true, kind: 'fresh', discarded: 'sess-1' });
        expect(f.calls).toEqual(['stop:agent_a', 'clearThread:agent_a', 'start:agent_a:null:/w/tynn']);
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
        expect(await switchDriver(open.ports, 'agent_a', 'codex')).toEqual({ ok: true, carries: ['identity', 'inbox', 'history', 'prompt'], from: 'claude', to: 'codex' });
        expect(open.calls).toEqual(['stop:agent_a', 'setProvider:agent_a:codex']);
        expect(open.current()?.provider).toBe('codex');

        expect(await switchDriver(fakes().ports, 'agent_a', 'claude')).toMatchObject({ ok: true, noop: true });
        expect(await switchDriver(fakes().ports, 'agent_a', 'kimi')).toMatchObject({ ok: false, reason: expect.stringMatching(/cannot run a "kimi"/) });
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

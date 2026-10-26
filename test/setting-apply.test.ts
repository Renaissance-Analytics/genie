import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AgentRecord } from '../src/core/identity.js';
import type { LiveSession } from '../src/core/roster.js';
import { SettingApplier, setModel, setPermissions, type AgentOpsPorts } from '../src/main/agent-ops-host.js';

/**
 * A START-TIME SETTING REACHES A RUNNING AGENT (the owner, 2026-10-14: "I had to restart you because I was not able to
 * change your model"). The model and a Claude agent's tool setting are read on the provider's command line, so a running
 * session takes them by restarting on the same conversation — at the first moment that costs nothing: now when idle,
 * at the end of a turn (or of a parked question), after its background tasks end; a stopped or failed agent reads it at
 * its next start. One restart per change, however many session events follow.
 */

const record = (over: Partial<AgentRecord> = {}): AgentRecord =>
    ({ id: 'agent_a', workspaceId: 'tynn', provider: 'claude', name: 'atlas', instructions: null, threadId: 'sess-1', createdAt: 't', lastUsedAt: 't', mode: 'manual', accessScope: 'self', ...over }) as unknown as AgentRecord;

const session = (over: Partial<LiveSession> = {}): LiveSession =>
    ({ running: true, turnState: 'idle', startedAt: 1, pendingApproval: null, failure: null, ...over }) as unknown as LiveSession;

function fakes(over: { record?: AgentRecord; probe?: LiveSession | null; shells?: number } = {}) {
    let current: AgentRecord = over.record ?? record();
    let probe: LiveSession | null = over.probe === undefined ? session() : over.probe;
    let shells = over.shells ?? 0;
    const calls: string[] = [];
    const ports = {
        registry: {
            find: (id: string) => (id === current.id ? current : null),
            clearThread: async () => { current = { ...current, threadId: null }; calls.push('clearThread'); return current; },
            setModel: async (_id: string, model: string | null) => { current = { ...current, ...(model === null ? {} : { model }) }; return current; },
            setPermissions: async (_id: string, permissions: NonNullable<AgentRecord['permissions']>) => { current = { ...current, permissions }; return current; },
        },
        host: {
            start: (r: AgentRecord) => { calls.push(`start:${r.threadId}`); return { ok: true }; },
            stop: () => { calls.push('stop'); return true; },
            ended: async () => null,
            probe: () => probe,
            deliverOwed: async () => 0,
        },
        cwdFor: () => '/w/tynn',
        startRefusal: () => null,
    } as unknown as AgentOpsPorts;
    const applier = new SettingApplier(ports, () => shells);
    ports.applyOnStart = (id) => applier.requested(id);
    return {
        ports, applier, calls,
        set: (next: Partial<LiveSession>) => { probe = session({ ...next }); },
        stopSession: () => { probe = null; },
        setShells: (n: number) => { shells = n; },
    };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('a model change reaches a running agent', () => {
    it('idle: applied NOW — one graceful restart on the same conversation, and the answer says so', async () => {
        const f = fakes();
        expect(await setModel(f.ports, 'agent_a', 'opus')).toMatchObject({ ok: true, apply: { when: 'now' } });
        await settle();
        expect(f.calls).toEqual(['stop', 'start:sess-1']);
    });

    it('mid-turn: nothing restarts until the turn ends — then exactly once, however many events follow', async () => {
        const f = fakes({ probe: session({ turnState: 'working' }) });
        expect(await setModel(f.ports, 'agent_a', 'opus')).toMatchObject({ apply: { when: 'after-turn' } });
        f.applier.changed('agent_a' as AgentRecord['id']);
        await settle();
        expect(f.calls).toEqual([]);
        f.set({ turnState: 'idle' });
        f.applier.changed('agent_a' as AgentRecord['id']);
        f.applier.changed('agent_a' as AgentRecord['id']);
        await settle();
        // COUNTED: one stop, one start.
        expect(f.calls).toEqual(['stop', 'start:sess-1']);
        expect(f.applier.pending('agent_a' as AgentRecord['id'])).toBe(false);
    });

    it('a question parked on the person is never cancelled by it: it waits like a turn', async () => {
        const f = fakes({ probe: session({ turnState: 'idle', pendingApproval: { question: 'run it?' } as never }) });
        expect(await setModel(f.ports, 'agent_a', 'opus')).toMatchObject({ apply: { when: 'after-turn' } });
        await settle();
        expect(f.calls).toEqual([]);
    });

    it('background tasks running: it waits for them (a restart would stop them), then applies', async () => {
        const f = fakes({ shells: 2 });
        // A model the host cannot switch in place is read at start (the tool setting no longer is: genie#1188).
        expect(await setModel(f.ports, 'agent_a', 'opus')).toMatchObject({ ok: true, apply: { when: 'after-shells', shells: 2 } });
        f.applier.changed('agent_a' as AgentRecord['id']);
        await settle();
        expect(f.calls).toEqual([]);
        f.setShells(0);
        f.applier.changed('agent_a' as AgentRecord['id']);
        await settle();
        expect(f.calls).toEqual(['stop', 'start:sess-1']);
    });

    it('the TOOL SETTING restarts nothing, whatever the session is doing (genie#1188): it is answered per shell call', async () => {
        for (const probe of [session(), session({ turnState: 'working' }), null]) {
            const f = fakes({ probe, shells: 2 });
            expect(await setPermissions(f.ports, 'agent_a', 'edits')).toMatchObject({ ok: true, apply: { when: 'live' } });
            f.applier.changed('agent_a' as AgentRecord['id']);
            await settle();
            expect(f.calls).toEqual([]);
            expect(f.applier.pending('agent_a' as AgentRecord['id'])).toBe(false);
        }
    });

    it('not running: the next start reads it — nothing is started on its behalf', async () => {
        const f = fakes({ probe: null });
        expect(await setModel(f.ports, 'agent_a', 'opus')).toMatchObject({ apply: { when: 'next-start' } });
        await settle();
        expect(f.calls).toEqual([]);
    });

    it('failed: not restarted by a setting (a graceful restart refuses it, a fresh one would lose the conversation)', async () => {
        const f = fakes({ probe: session({ turnState: 'failed', failure: { reason: 'x', fixes: [] } }) });
        expect(await setModel(f.ports, 'agent_a', 'opus')).toMatchObject({ apply: { when: 'next-start' } });
        await settle();
        expect(f.calls).toEqual([]);
    });

    it('stopped while waiting: the pending change is dropped, and a later start does not trigger a surprise restart', async () => {
        const f = fakes({ probe: session({ turnState: 'working' }) });
        await setModel(f.ports, 'agent_a', 'opus');
        f.stopSession();
        f.applier.changed('agent_a' as AgentRecord['id']);
        f.set({ turnState: 'idle' });
        f.applier.changed('agent_a' as AgentRecord['id']);
        await settle();
        expect(f.calls).toEqual([]);
    });

    it('never prompted (no conversation): a plain restart — nothing to resume, nothing lost', async () => {
        const f = fakes({ record: record({ threadId: null }) });
        await setModel(f.ports, 'agent_a', 'opus');
        await settle();
        expect(f.calls).toEqual(['stop', 'start:null', 'clearThread']);
    });
});

describe('main wires it', () => {
    // Comments stripped first, so a sentence about the wiring cannot stand in for the wiring.
    const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8')
        .split(/\r?\n/)
        .map((line) => line.replace(/\/\/.*$/, ''))
        .join('\n');

    it('every model / tool-setting change asks the applier (window and remote share these ports)', () => {
        expect(main.match(/applyOnStart:\s*\(id\)\s*=>\s*settingApplier!\.requested\(id\)/g) ?? []).toHaveLength(1);
    });

    it('every change to an agent\'s session lets a waiting change apply', () => {
        expect(main.match(/settingApplier\?\.changed\(agentId\)/g) ?? []).toHaveLength(1);
    });
});

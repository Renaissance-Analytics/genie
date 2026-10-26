import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AgentRecord } from '../src/core/identity.js';
import type { Finished } from '../src/main/attention-store.js';
import { handoffPrompt, restartWithHandoff, type RestartPorts } from '../src/main/restart-with-handoff.js';

/**
 * "RESTART WITH THIS" (§4.5 Since-you-looked) — a finished agent is started again and its own
 * handoff note is its next prompt, so the next run picks up where the last one stopped. The restart
 * is THE ONE RESTART (genie#1238: `restartAgent(…, 'graceful')`, which waits for the old run, starts
 * from every state and delivers what is owed); then the prompt, and only then the finish is marked
 * seen. A restart that is refused or a prompt the session does not take leaves the item on the Deck
 * with the refusal said. The main process's handler is a thin call into this.
 */

const record: AgentRecord = { id: 'agent_a', workspaceId: 'tynn', provider: 'claude', name: 'atlas', instructions: null, threadId: null, createdAt: 't', lastUsedAt: 't', mode: 'manual', accessScope: 'workspace' } as unknown as AgentRecord;
const fin = { id: 'fin_1', agentId: 'agent_a', agentName: 'atlas', handoff: 'PR #50 is up; next: merge it and rebase the Deck branch.', at: 't', seen: false } as Finished;

function ports(over: Partial<RestartPorts> = {}) {
    const calls: string[] = [];
    const seen: string[] = [];
    const p: RestartPorts = {
        restart: async (id) => { calls.push(`restart:${id}`); return { ok: true }; },
        prompt: (id, text) => { calls.push(`prompt:${id}:${text}`); return true; },
        ...over,
    };
    const attention = { finished: () => [fin], markSeen: (id: string) => { seen.push(id); } };
    return { p, attention, calls, seen };
}

describe('the handoff prompt', () => {
    it('names the note as the agent’s own handoff and carries it verbatim', () => {
        expect(handoffPrompt('do X next')).toBe('You are restarting from your own handoff note. Pick up where it leaves off:\n\ndo X next');
    });
});

describe('restartWithHandoff', () => {
    it('restarts through the one restart, prompts with the handoff, then marks the finish seen — in that order', async () => {
        const f = ports();
        expect(await restartWithHandoff(f.p, f.attention, record, 'fin_1')).toEqual({ ok: true });
        expect(f.calls).toEqual(['restart:agent_a', `prompt:agent_a:${handoffPrompt(fin.handoff!)}`]);
        expect(f.seen).toEqual(['fin_1']);
    });

    it('a finish that is not this agent’s, or has no handoff, is refused before anything is touched', async () => {
        const f = ports();
        expect(await restartWithHandoff(f.p, f.attention, record, 'fin_other')).toEqual({ ok: false, reason: 'no handoff fin_other for atlas' });
        expect(await restartWithHandoff(f.p, { finished: () => [{ ...fin, handoff: null }], markSeen: f.attention.markSeen }, record, 'fin_1')).toEqual({ ok: false, reason: 'no handoff fin_1 for atlas' });
        expect(f.calls).toEqual([]);
        expect(f.seen).toEqual([]);
    });

    it('a restart that is refused is reported with its reason and the finish stays on the Deck', async () => {
        const f = ports({ restart: async () => ({ ok: false, reason: 'Genie cannot run a "kimi" agent. It stays registered and idle.' }) });
        expect(await restartWithHandoff(f.p, f.attention, record, 'fin_1')).toEqual({ ok: false, reason: 'Genie cannot run a "kimi" agent. It stays registered and idle.' });
        expect(f.calls).toEqual([]);
        expect(f.seen).toEqual([]);
    });

    it('a prompt the session does not take is reported and the finish stays on the Deck', async () => {
        const f = ports({ prompt: () => false });
        expect(await restartWithHandoff(f.p, f.attention, record, 'fin_1')).toEqual({ ok: false, reason: 'atlas started but did not take the handoff prompt' });
        expect(f.seen).toEqual([]);
    });
});

describe('the bridge', () => {
    it('restartWithHandoff is one channel, named in preload and answered in main — through the one restart', () => {
        const preload = readFileSync(new URL('../src/main/preload.ts', import.meta.url), 'utf8');
        const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
        expect(preload.match(/'genie:restart-with-handoff'/g) ?? []).toHaveLength(1);
        expect(main.match(/'genie:restart-with-handoff'/g) ?? []).toHaveLength(1);
        expect(main).toMatch(/restartWithHandoff\(\{ restart: \(id\) => restartAgent\(agentOps, id, 'graceful'\)/);
    });
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommsCache, commsTally } from '../src/core/comms.js';
import { deckItemsFrom } from '../src/core/deck-sources.js';
import { agentRecord, mintAgentId, type AgentId } from '../src/core/identity.js';
import { InvolvingCache } from '../src/core/inbox-read.js';
import { memoryPair } from '../src/core/line-transport.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { SessionDriverFactory } from '../src/core/session.js';
import { askerLiveFrom, type AskerLiveDeps } from '../src/main/asker-live.js';
import type { PendingQuestion } from '../src/main/attention-store.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * THE DECK RESCANNED THE MAIL (owner's beta.59): recurring 1-2 s window-main stalls, stack
 * `commsOf < comms < probe < askerLive < deckItemsFrom`, on EVERY Deck refresh. The Deck asks only "is the asker still
 * running, and since when"; it computed every asker's Dashboard comms cell (a scan of up to 2000 mails) to answer it.
 *
 * (a) a Deck refresh never scans the mail, through either engine (genie-host's client, and the in-process SessionHost);
 *     a Dashboard probe still gets its comms cell (the control: the spy can count).
 * (b) the comms cell is computed once per change of THAT agent's mail (or its session start), not per read.
 */
const NOW = 1_770_000_000_000;
const at = (ms: number) => new Date(NOW + ms).toISOString();
const tree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
const driverFor: DriverFor = () => {
    const factory: SessionDriverFactory = () => ({ start: () => {}, prompt: () => {}, kill: () => {}, cancel: () => {}, cliSessionId: null });
    return factory;
};
const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r)); };

interface Mail { readonly seq: number; readonly id: string; readonly from: string; readonly to: string; readonly sentAt: string; readonly readAt: string | null }

/** A big inbox: 5000 mails, each agent writing to the next, all since the session start: every agent has 2 peers. */
function bigInbox(ids: readonly string[]): Mail[] {
    const mail: Mail[] = [];
    for (let i = 0; i < 5000; i += 1) mail.push({ seq: i + 1, id: `m${i}`, from: ids[i % ids.length]!, to: ids[(i + 1) % ids.length]!, sentAt: at(1000 + i), readAt: null });
    return mail;
}

/** The window's comms reader, as main.ts wires it, with the scan and the inbox read counted. */
function countedComms(messages: () => readonly Mail[]) {
    const counts = { tally: 0, involving: 0 };
    const involving = new InvolvingCache<Mail>();
    const cache = new CommsCache(
        (agentId) => { counts.involving += 1; return involving.read(messages(), agentId, 2000); },
        (mail, agentId, since) => { counts.tally += 1; return commsTally(mail, agentId, since); },
    );
    return { counts, comms: (agentId: AgentId, since: number) => cache.read(agentId, since, NOW + 60_000) };
}

const question = (agentId: string, i: number): PendingQuestion => ({
    id: `q${i}`, key: `q${i}`, agentId: agentId as AgentId, agentName: agentId, workspaceId: 'ws', priority: 'normal', askedAt: at(500),
    questions: [{ header: 'Engine', question: 'Which engine?', options: [{ label: 'sqlite' }, { label: 'postgres' }] }],
});

function deckRefresh(ids: readonly string[], engine: AskerLiveDeps['engine']) {
    return deckItemsFrom({
        questions: ids.map(question), userList: [], unreadDms: [], finished: [],
        agents: Object.fromEntries(ids.map((id) => [id, { name: id, workspaceId: 'ws' }])),
        asker: askerLiveFrom({ known: () => true, engine, takeOvers: () => null }),
    });
}

let dir: string;
let hosts: SessionHost[] = [];
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-deck-liveness-')); hosts = []; });
afterEach(async () => {
    for (const h of hosts) { h.stopAll(); await h.settled(); }
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

describe('(a) a Deck refresh reads liveness, never the mail', () => {
    it('the in-process SessionHost (the emergency path): N items, a big inbox, ZERO comms scans; a Dashboard probe still has its cell', () => {
        const records = Array.from({ length: 8 }, (_, i) => agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'claude', name: `a${i}` }));
        const ids = records.map((r) => r.id);
        const mail = bigInbox(ids);
        const { counts, comms } = countedComms(() => mail);
        const host = new SessionHost({ userData: dir, driverFor, clock: () => NOW, processTree: tree, comms });
        hosts.push(host);
        for (const r of records) host.start(r, dir);

        const items = deckRefresh(ids, () => host);
        expect(items.filter((i) => i.source === 'agent-question')).toHaveLength(ids.length);
        expect(counts).toEqual({ tally: 0, involving: 0 });

        // CONTROL: the Dashboard's probe still carries its comms cell, and the spy sees that scan.
        const probe = host.probe(ids[0] as AgentId);
        expect(probe?.collaborators).toBe(2);
        expect(counts.tally).toBe(1);
    });

    it('genie-host\'s engine client: N items, a big inbox, ZERO comms scans; a Dashboard probe still has its cell', async () => {
        const server = new SessionEngineServer({ token: 't0k', build: 't', schedule: (_ms, fn) => { const t = setImmediate(fn); return () => clearImmediate(t); } });
        const host = new SessionHost({ userData: dir, driverFor, clock: () => NOW, processTree: tree, ...server.hostOptions() });
        hosts.push(host);
        server.attach(host);
        const [hostSide, windowSide] = memoryPair();
        server.accept(hostSide);
        const records = Array.from({ length: 8 }, (_, i) => agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'claude', name: `a${i}` }));
        const ids = records.map((r) => r.id);
        const mail = bigInbox(ids);
        const { counts, comms } = countedComms(() => mail);
        const client = new SessionEngineClient({ comms });
        expect(await client.connect(windowSide, 't0k')).toMatchObject({ ok: true });
        for (const r of records) expect(await client.start(r, dir)).toEqual({ ok: true });
        await settle();

        const items = deckRefresh(ids, () => client);
        expect(items.filter((i) => i.source === 'agent-question')).toHaveLength(ids.length);
        expect(counts).toEqual({ tally: 0, involving: 0 });

        // CONTROL: the Dashboard's probe still carries its comms cell, and the spy sees that scan.
        const probe = client.probe(ids[0] as AgentId);
        expect(probe?.collaborators).toBe(2);
        expect(counts.tally).toBe(1);
    });
});

describe('(b) comms is computed once per change of that agent\'s mail', () => {
    it('two reads, no new mail: one scan, ages still against now; mail for ANOTHER agent: no scan; mail for it: a scan', () => {
        let mail: Mail[] = [
            { seq: 1, id: 'm1', from: 'agent_a', to: 'agent_b', sentAt: at(1000), readAt: null },
            { seq: 2, id: 'm2', from: 'agent_b', to: 'agent_c', sentAt: at(2000), readAt: null },
        ];
        let tallies = 0;
        const involving = new InvolvingCache<Mail>();
        const cache = new CommsCache((id) => involving.read(mail, id, 2000), (m, id, since) => { tallies += 1; return commsTally(m, id, since); });

        expect(cache.read('agent_a', NOW, NOW + 11_000)).toMatchObject({ collaborators: 1, commsAgeSeconds: 10 });
        expect(cache.read('agent_a', NOW, NOW + 21_000)).toMatchObject({ collaborators: 1, commsAgeSeconds: 20 });
        expect(tallies).toBe(1);

        // Mail between two OTHER agents: agent_a's mail did not change.
        mail.push({ seq: 3, id: 'm3', from: 'agent_b', to: 'agent_c', sentAt: at(3000), readAt: null });
        cache.read('agent_a', NOW, NOW + 21_000);
        expect(tallies).toBe(1);
        // Another agent read its mail (the array is replaced, agent_a's messages are the same ones): still no scan.
        mail = mail.map((m) => (m.to === 'agent_c' ? { ...m, readAt: at(4000) } : m));
        cache.read('agent_a', NOW, NOW + 21_000);
        expect(tallies).toBe(1);

        // Mail FOR agent_a: a scan, and the new peer is counted.
        mail.push({ seq: 4, id: 'm4', from: 'agent_c', to: 'agent_a', sentAt: at(5000), readAt: null });
        expect(cache.read('agent_a', NOW, NOW + 21_000)).toMatchObject({ collaborators: 2, commsAgeSeconds: 16 });
        expect(tallies).toBe(2);

        // A new session start (`since`) is a new answer: a scan.
        expect(cache.read('agent_a', NOW + 4000, NOW + 21_000)).toMatchObject({ collaborators: 1 });
        expect(tallies).toBe(3);
    });

    it('through the Dashboard probe: two probes of the same agent with no new mail scan once', () => {
        const records = Array.from({ length: 4 }, (_, i) => agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'claude', name: `a${i}` }));
        const mail = bigInbox(records.map((r) => r.id));
        const { counts, comms } = countedComms(() => mail);
        const host = new SessionHost({ userData: dir, driverFor, clock: () => NOW, processTree: tree, comms });
        hosts.push(host);
        for (const r of records) host.start(r, dir);
        const first = host.probe(records[0]!.id as AgentId);
        const second = host.probe(records[0]!.id as AgentId);
        expect(second?.collaborators).toBe(first?.collaborators);
        expect(counts.tally).toBe(1);
        host.probe(records[1]!.id as AgentId);
        expect(counts.tally).toBe(2); // CONTROL: another agent is its own scan
    });
});

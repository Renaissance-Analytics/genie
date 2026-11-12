import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRecord, mintAgentId, type AgentId, type AgentRecord } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import { openAgentThread, openDurableStore, RUN_FIELD } from '../src/core/thread-store.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';
import { sessionsDir } from '../src/main/paths.js';

/*
 * TYNN #647 (the owner, 2026-11-12): "Every time I send a msg to you, before my input is shown, all of your messages
 * disappear and I only see the agentinbox entries, then all of a sudden all of the messages reappear with mine at the end."
 * Corrected: not in a back-and-forth — the first send after a quiet spell, or from a fresh start.
 *
 * THE CONDITION: the window's rows are `SessionHost.ledgerFor` — the agent's recorded history, then this run. The history
 * is cached per run (keyed by the run's start). A send to an agent with no session STARTS one (or a restart starts a new
 * run), so the key changes, the history is read again, and until that read lands the ledger was THIS RUN'S ROWS ALONE: every
 * reply already shown vanished, leaving the mail rows (which come from the inbox, not the ledger). In a dialogue the session
 * is already running, the key holds, and nothing is read again — so it never showed there.
 */
let dir: string;
let hosts: SessionHost[] = [];
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-647-')); hosts = []; });
afterEach(async () => { for (const h of hosts) h.stopAll(); await Promise.all(hosts.map((h) => h.settled())); await rm(dir, { recursive: true, force: true }); });
const tree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

function rig() {
    let events: DriverEvents = {};
    const driverFor: DriverFor = () => ((o: { events: DriverEvents }) => {
        events = o.events;
        return { start: () => {}, prompt: () => {}, kill: () => {}, get running() { return true; }, get cliSessionId() { return null; } };
    }) as unknown as SessionDriverFactory;
    const host = new SessionHost({ userData: dir, driverFor, processTree: tree });
    hosts.push(host);
    return { host, events: () => events };
}

/** An agent with a recorded conversation: its replies and a piece of AgentInbox mail between them. */
async function withHistory(): Promise<AgentRecord> {
    const record = agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'claude', name: 'tynn' });
    const thread = openAgentThread(openDurableStore(sessionsDir(dir)), record.id);
    await thread.record([
        { kind: 'message', speaker: 'you', peerName: null, text: 'first question', [RUN_FIELD]: 'run-old' },
        { kind: 'message', speaker: 'agent', peerName: null, text: 'REPLY-ONE', [RUN_FIELD]: 'run-old' },
        { kind: 'message', speaker: 'peer', peerName: 'moic', text: 'mail between', mail: [{ id: 'm1', from: 'moic', subject: 'hi' }], [RUN_FIELD]: 'run-old' },
        { kind: 'message', speaker: 'agent', peerName: null, text: 'REPLY-TWO', [RUN_FIELD]: 'run-old' },
    ] as never);
    return record;
}
const texts = (host: SessionHost, id: AgentId) => host.ledgerFor(id).flatMap((r) => (r.event.kind === 'message' ? [r.event.text] : []));

describe('a send never makes a shown row disappear', () => {
    it('the first send after a quiet spell (no session: the send starts one): the replies stay while the new run’s history is read', async () => {
        const { host } = rig();
        const record = await withHistory();
        // The chat is open on the idle agent: its history is read and shown.
        texts(host, record.id);
        await vi.waitFor(() => expect(texts(host, record.id)).toEqual(['first question', 'REPLY-ONE', 'mail between', 'REPLY-TWO']));
        const shown = texts(host, record.id).length;
        // The person sends: the agent starts on it, a new run.
        host.start(record, dir);
        host.prompt(record.id, 'second question', 'you');
        // Before the new run's history read lands — every row a person saw is still there, in order.
        const between = texts(host, record.id);
        expect(between.length).toBeGreaterThanOrEqual(shown);
        expect(between.slice(0, 4)).toEqual(['first question', 'REPLY-ONE', 'mail between', 'REPLY-TWO']);
        // And once it lands: the same rows, the message at the end, nothing twice.
        await host.settled();
        await vi.waitFor(() => expect(texts(host, record.id)).toEqual(['first question', 'REPLY-ONE', 'mail between', 'REPLY-TWO', 'second question']));
    });

    it('a restart (a new run of a running agent): the same', async () => {
        const { host } = rig();
        const record = await withHistory();
        host.start(record, dir);
        texts(host, record.id);
        await vi.waitFor(() => expect(texts(host, record.id).slice(0, 4)).toEqual(['first question', 'REPLY-ONE', 'mail between', 'REPLY-TWO']));
        host.stop(record.id);
        await host.settled();
        host.start(record, dir);
        expect(texts(host, record.id).slice(0, 4)).toEqual(['first question', 'REPLY-ONE', 'mail between', 'REPLY-TWO']);
    });

    it('CONTROL: in a dialogue (the session already running) a send only appends', async () => {
        const { host } = rig();
        const record = await withHistory();
        host.start(record, dir);
        texts(host, record.id);
        await vi.waitFor(() => expect(texts(host, record.id).slice(0, 4)).toEqual(['first question', 'REPLY-ONE', 'mail between', 'REPLY-TWO']));
        host.prompt(record.id, 'next', 'you');
        expect(texts(host, record.id)).toEqual(['first question', 'REPLY-ONE', 'mail between', 'REPLY-TWO', 'next']);
    });

    it('CONTROL: an agent opened for the first time with nothing read yet shows nothing, then its history (nothing to keep)', async () => {
        const { host } = rig();
        const record = await withHistory();
        expect(texts(host, record.id)).toEqual([]);
        await vi.waitFor(() => expect(texts(host, record.id)).toHaveLength(4));
    });
});

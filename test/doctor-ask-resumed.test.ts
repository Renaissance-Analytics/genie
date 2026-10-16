import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import { openDurableStore, readHistory } from '../src/core/thread-store.js';
import { askAndWait } from '../src/main/doctor-mcp.js';
import { sessionsDir } from '../src/main/paths.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * ASKING AN AGENT THAT HAS A PAST WAITS FOR ITS ANSWER. The doctor trial of 2026-10-13: doctor genie started the owner's
 * genie agent (13 recorded turns) and `askAgent` came back in 0.4 s with an empty reply and no tool calls — the agent
 * answered six seconds later. A session resumed with history numbers its turns on from the record (#223: "Turn 14", not
 * "Turn 1"), so `turnsFor` already read 13 before the question was sent, and the ask compared that with THIS run's one
 * turn marker and called it finished. The ask counts what it means: turns ended in this run.
 */
let dir: string;
const hosts: SessionHost[] = [];
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-askresumed-')); });
// Stop every host, then remove with retries: a session's row writes are fire-and-forget by design and `stop` does not
// await them, so a removal right after can meet a write still landing — CI, 2026-10-14: `ENOTEMPTY ... runtime/sessions`
// on this test, never alone, about one full suite in twelve. The same race and the same answer as session-host.test.ts.
afterEach(async () => {
    for (const h of hosts.splice(0)) h.stopAll();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});
const tree: ProcessTree = { descendantsOf: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

function host() {
    let events: DriverEvents = {};
    const driverFor: DriverFor = () => ((options: { events: DriverEvents }) => {
        events = options.events;
        return { start: () => {}, prompt: () => {}, kill: () => {}, get running() { return true; }, get cliSessionId() { return 'cli-1'; } };
    }) as unknown as SessionDriverFactory;
    const host = new SessionHost({ userData: dir, driverFor, processTree: tree });
    hosts.push(host);
    return {
        host,
        say: (text: string) => events.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }),
        callTool: () => events.onUpdate?.({ sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'mcp__genie__lists', status: 'in_progress' }),
        end: () => events.onTurnEnd?.({ stopReason: 'end_turn' } as never),
    };
}

describe('askAndWait on a resumed agent', () => {
    it('waits for THIS question’s turn and returns its words — not the turns its history already counted', async () => {
        const record = agentRecord({ id: mintAgentId(), workspaceId: 'w', provider: 'claude', name: 'kai' });
        // A past: two turns, recorded.
        const first = host();
        first.host.start(record, dir);
        for (const q of ['one', 'two']) { first.host.prompt(record.id, q, 'you'); first.say(`answer ${q}`); first.end(); }
        await vi.waitFor(async () => expect((await readHistory(openDurableStore(sessionsDir(dir)), record.id)).rows.filter((r) => r.event.kind === 'turn')).toHaveLength(2), { timeout: 3000 });
        first.host.stop(record.id);

        // Genie restarts; the agent resumes, its turn count carried on from the record.
        const second = host();
        second.host.start({ ...record, threadId: 'cli-1' } as typeof record, dir);
        await vi.waitFor(() => expect(second.host.turnsFor(record.id)).toBe(2), { timeout: 3000 });

        let settled: { ok: boolean; reply?: string } | null = null;
        void askAndWait(second.host, record.id, 'call your lists tool', 5000, 'kai').then((r) => { settled = r as never; });
        await new Promise((r) => setTimeout(r, 50));
        // What the real agent did first: called its tool. Every event re-checks the ask — it must still be waiting.
        second.callTool();
        await new Promise((r) => setTimeout(r, 50));
        expect(settled).toBeNull();

        second.say('the lists call worked');
        second.end();
        await vi.waitFor(() => expect(settled).toEqual({ ok: true, reply: 'the lists call worked' }), { timeout: 3000 });
    });
});

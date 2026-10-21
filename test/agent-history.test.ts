import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import type { TimedEvent } from '../src/core/stream-view.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';
import { sessionsDir } from '../src/main/paths.js';
import { openAgentThread, openDurableStore, readHistory } from '../src/core/thread-store.js';

/**
 * WHAT THE AGENT REMEMBERS, THE UI SHOWS. The owner, beta.21: "Why does the claude agent still have a memory of context
 * that my UI does not?" — moic held 740.7k tokens of context while its Agent view showed "Turn 1". Every row was
 * written to the agent's thread, and never read back: each start began an empty ledger, Claude does not replay a
 * resumed conversation, and a stopped agent's view was blank.
 *
 * Played as it happens: an agent runs a turn; Genie restarts (a new host); the stopped agent's view shows that turn;
 * resumed, the view is the earlier run, a run marker, then this run — and its turns continue from 2, not "Turn 1".
 */
let dir: string;
let hosts: SessionHost[] = [];
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-history-')); hosts = []; });
// A row is SHOWN before it is WRITTEN, so the folder goes only after every write the sessions queued has landed. The
// last assertion below passes on the ledger while `turn 2` and `second question` may still be on their way to disk; the
// folder removed under them (a write re-creates it) is the race behind this test failing about one full suite in three
// (2026-10-15; an afterEach error is reported as the test's) — a remove racing a create fails ENOTEMPTY. See
// test/thread-writes-settle.test.ts.
afterEach(async () => { await Promise.all(hosts.map((h) => h.settled())); await rm(dir, { recursive: true, force: true }); });
const tree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

function host(clock?: () => number) {
    let events: DriverEvents = {};
    const driverFor: DriverFor = () => ((options: { events: DriverEvents }) => {
        events = options.events;
        return { start: () => {}, prompt: () => {}, kill: () => {}, get running() { return true; }, get cliSessionId() { return 'cli-1'; } };
    }) as unknown as SessionDriverFactory;
    const made = new SessionHost({ userData: dir, driverFor, processTree: tree, ...(clock ? { clock } : {}) });
    hosts.push(made);
    return { host: made, end: () => events.onTurnEnd?.({ stopReason: 'end_turn' } as never) };
}
const said = (rows: readonly TimedEvent[]) => rows.flatMap((r) => (r.event.kind === 'message' ? [r.event.text] : []));
const kinds = (rows: readonly TimedEvent[]) => rows.map((r) => (r.event.kind === 'turn' ? `turn ${r.event.n}` : r.event.kind === 'run' ? `run${r.event.resumed ? ' resumed' : ''}` : r.event.kind));

describe('an agent’s history', () => {
    it('survives a restart: shown when stopped, then before the resumed run, whose turns continue', async () => {
        const record = agentRecord({ id: mintAgentId(), workspaceId: 'moic', provider: 'claude', name: 'moic' });

        const first = host();
        first.host.start(record, dir);
        first.host.prompt(record.id, 'first question', 'you');
        first.end();
        // Written to the thread — the record a restart reads. Waited for HERE, so the restart below reads a finished
        // record (the writes are asynchronous; a stopped agent writes nothing more, so its history is read once).
        await vi.waitFor(async () => expect(said((await readHistory(openDurableStore(sessionsDir(dir)), record.id)).rows.map((r, i) => ({ id: String(i), ...r })))).toEqual(['first question']), { timeout: 3000 });

        // Genie restarts: a new host, the agent not running yet — its view is its history, not blank.
        const second = host();
        await vi.waitFor(() => expect(said(second.host.ledgerFor(record.id))).toEqual(['first question']), { timeout: 3000 });

        // Resumed: the earlier run, then this run's marker; this run's own rows are not counted twice.
        second.host.start({ ...record, threadId: 'cli-1' } as typeof record, dir);
        await vi.waitFor(() => expect(second.host.turnsFor(record.id)).toBe(1), { timeout: 3000 });
        second.host.prompt(record.id, 'second question', 'you');
        await vi.waitFor(() => expect(said(second.host.ledgerFor(record.id))).toEqual(['first question', 'second question']), { timeout: 3000 });
        // Turn 1 ended cleanly before the restart: its `finished` row is part of the history (beta.33 item 10).
        expect(kinds(second.host.ledgerFor(record.id))).toEqual(['turn 1', 'message', 'finished', 'run resumed', 'turn 2', 'message']);
        // THIS run alone (the doctor channel, file attribution) is still this run alone.
        expect(said(second.host.rowsFor(record.id))).toEqual(['second question']);
    });
});

/*
 * THE PREVIOUS RUN'S ROWS ARE ITS OWN, HOWEVER LATE THEY WERE WRITTEN (main's CI, 2026-10-21, run 39608121777: turn 1's
 * `finished` row vanished across a restart). History and this run were told apart by WRITE time against this run's
 * start: a row the previous run emitted but wrote in the same millisecond the next run started — or after it, a write
 * still landing on a quick restart — counted as this run's, and this run never had it: gone from both. Here the next
 * run's start is pinned to those writes, so the case the CI hit by chance is the case every run.
 */
describe('a restart right on the heels of the last write', () => {
    for (const [when, startAt] of [
        ['in the same millisecond as the last write', (writes: number[]) => Math.max(...writes)],
        ['before the previous run’s writes had landed', (writes: number[]) => Math.min(...writes) - 1],
    ] as const) {
        it(`a run that starts ${when} still shows the previous run whole — and nothing twice`, async () => {
            const record = agentRecord({ id: mintAgentId(), workspaceId: 'moic', provider: 'claude', name: 'moic' });
            const first = host();
            first.host.start(record, dir);
            first.host.prompt(record.id, 'first question', 'you');
            first.end();
            await first.host.settled();
            const writes = (await openAgentThread(openDurableStore(sessionsDir(dir)), record.id).messages()).map((m) => Date.parse(m.recordedAt));
            // The gauge: the record holds the whole first run (the row the CI lost included) before the restart.
            expect(writes.length).toBe(3);

            const at = startAt(writes);
            const second = host(() => at);
            second.host.start({ ...record, threadId: 'cli-1' } as typeof record, dir);
            second.host.prompt(record.id, 'second question', 'you');
            await vi.waitFor(() => expect(said(second.host.ledgerFor(record.id))).toEqual(['first question', 'second question']), { timeout: 3000 });
            expect(kinds(second.host.ledgerFor(record.id))).toEqual(['turn 1', 'message', 'finished', 'run resumed', 'turn 2', 'message']);
            expect(said(second.host.rowsFor(record.id))).toEqual(['second question']);
        });
    }
});

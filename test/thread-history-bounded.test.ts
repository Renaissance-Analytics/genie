import { mkdtemp, readdir, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRecord, mintAgentId, type AgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';
import { sessionsDir } from '../src/main/paths.js';
import { openAgentThread, openDurableStore, readHistory, readWholeHistory, threadLogFile, RUN_FIELD } from '../src/core/thread-store.js';

/**
 * A HISTORY READ COSTS THE WINDOW IT SHOWS, NOT THE THREAD (genie#1340; the owner, 2026-10-29: "right after a restart
 * genie ui lags a lot … I am typing but it took 4 seconds before the text showed up").
 *
 * The owner's agents keep thread logs of 166 MB / 266k rows (660 MB across eleven). Every history read parsed the WHOLE
 * log — `JSON.parse` on every line, in one synchronous run on Electron's main process, which is the browser UI thread
 * that routes every keystroke to the window — and then kept the last 3000 rows. A restart did it several times per
 * agent: the agent view's first ask, again when the agent started (a new run), the session's turn count, and the first
 * write of every run (prism-harness `logLength` on a store opened fresh each time, so its line count was never kept).
 *
 * What is counted here is the thing that blocked: thread lines handed to `JSON.parse`.
 */
let dir: string;
let hosts: SessionHost[] = [];
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-bounded-')); hosts = []; });
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(hosts.map((h) => h.settled())); await rm(dir, { recursive: true, force: true }); });

/** Thread lines parsed while `fn` runs: `JSON.parse` calls on a stored entry (`{"position":…`). */
async function linesParsed<T>(fn: () => Promise<T>): Promise<{ value: T; parsed: number }> {
    const real = JSON.parse;
    let parsed = 0;
    vi.spyOn(JSON, 'parse').mockImplementation(((text: string, reviver?: never) => {
        if (typeof text === 'string' && text.startsWith('{"position":')) parsed += 1;
        return real(text, reviver);
    }) as typeof JSON.parse);
    try {
        return { value: await fn(), parsed };
    } finally {
        vi.mocked(JSON.parse).mockRestore();
    }
}

/** A long thread, written through the real store: `turns` turns of `perTurn` rows, by earlier runs. */
async function seedThread(agentId: AgentId, turns: number, perTurn: number, extra: (turn: number, i: number) => Record<string, unknown> | null = () => null): Promise<number> {
    const thread = openAgentThread(openDurableStore(sessionsDir(dir)), agentId);
    let rows = 0;
    for (let t = 1; t <= turns; t += 1) {
        const run = `run-${Math.ceil(t / 7)}`;
        const batch: Record<string, unknown>[] = [{ kind: 'turn', n: t, by: 'you', [RUN_FIELD]: run }, { kind: 'message', speaker: 'you', peerName: null, text: `question ${t}`, [RUN_FIELD]: run }];
        for (let i = 0; i < perTurn; i += 1) {
            const odd = extra(t, i);
            batch.push(odd ?? { kind: 'tool', toolCallId: `c${t}-${i}`, name: null, title: `step ${i} "turn" of the plan`, status: 'completed', toolKind: 'execute', rawInput: { command: `echo "turn" ${i}` }, output: 'x'.repeat(200), [RUN_FIELD]: run });
        }
        batch.push({ kind: 'message', speaker: 'agent', peerName: null, text: `answer ${t}`, [RUN_FIELD]: run }, { kind: 'finished', n: t, [RUN_FIELD]: run });
        await thread.record(batch as never);
        rows += batch.length;
    }
    return rows;
}

// Each seeds a thread of tens of thousands of rows through the real store: seconds on a loaded 4-CPU test VM.
describe('reading an agent’s history (genie#1340)', { timeout: 60_000 }, () => {
    it('parses only the window it keeps, not the whole thread', async () => {
        const id = mintAgentId();
        const total = await seedThread(id, 100, 200); // 20,400 rows
        const { value, parsed } = await linesParsed(() => readHistory(openDurableStore(sessionsDir(dir)), id, { limit: 3000 }));
        expect(value.rows.length).toBe(3000);
        expect(value.earlier).toBe(total - 3000);
        // The window, plus the few earlier lines that might be a turn (counted exactly) — never the 20,400.
        expect(parsed).toBeLessThan(3000 + 200);
    });

    it('answers exactly what the whole read answers: the window, what it left out, the turns before it and the last turn', async () => {
        const id = mintAgentId();
        // Rows a cheap scan must not miscount: unserialisable ones, a row naming "turn" inside its text, a turn-shaped
        // string in a tool output, and rows of the run that is reading (excluded).
        await seedThread(id, 60, 120, (t, i) => {
            if (i === 7 && t % 5 === 0) return { kind: 'tool', unserialisable: true, [RUN_FIELD]: `run-${Math.ceil(t / 7)}` };
            if (i === 9) return { kind: 'message', speaker: 'agent', peerName: null, text: 'say "turn" and {"kind":"turn","n":999}', [RUN_FIELD]: `run-${Math.ceil(t / 7)}` };
            // Escaped quotes never read as a turn — except a string that ENDS in `"turn`, whose bytes do: parsed, not miscounted.
            if (i === 10) return { kind: 'message', speaker: 'agent', peerName: null, text: 'a string that ends with "turn', [RUN_FIELD]: `run-${Math.ceil(t / 7)}` };
            // Rows from before runs were named (no run field): told apart by when they were written.
            if (i === 13 && t < 3) return { kind: 'notice', level: 'info', message: 'from before runs were named', headroom: null, model: null, estimate: null };
            if (i === 11 && t > 55) return { kind: 'notice', level: 'info', message: 'this run', headroom: null, model: null, estimate: null, [RUN_FIELD]: 'run-now' };
            return null;
        });
        // A torn last line, as a crash mid-write leaves it: never a row.
        const sessions = sessionsDir(dir);
        await appendFile(join(sessions, (await readdir(sessions)).find((f) => f.endsWith('.jsonl'))!), '{"position":99999,"message":{"kind":"tu');
        for (const options of [{ limit: 3000 }, { limit: 3000, run: 'run-now' }, { limit: 1 }, { limit: 0, run: 'run-now' }, { limit: 100_000 }, { limit: 500, before: Date.now() + 60_000 }, { limit: 0, before: 1 }, { limit: 3000, before: 1 }]) {
            const whole = await readWholeHistory(openDurableStore(sessions), id, options);
            const bounded = await readHistory(openDurableStore(sessions), id, options);
            expect(bounded, JSON.stringify(options)).toEqual(whole);
        }
    });

    it('numbers every write right without parsing the log: its own appends, another writer’s, and a torn tail', async () => {
        const id = mintAgentId();
        const sessions = sessionsDir(dir);
        const mine = openAgentThread(openDurableStore(sessions), id);
        const theirs = openAgentThread(openDurableStore(sessions), id);
        const row = (n: number) => ({ kind: 'notice', level: 'info', message: `row ${n}`, headroom: null, model: null, estimate: null });
        const { parsed } = await linesParsed(async () => {
            for (let n = 1; n <= 3; n += 1) await mine.record([row(n)] as never);
            await theirs.record([row(4), row(5)] as never);
            await mine.record([row(6)] as never);
            // A write a crash cut short: the next append cuts it back, and the count must not include it.
            await appendFile(threadLogFile(sessions, id), '{"position":7,"message":{"kind":"no');
            await mine.record([row(7)] as never);
            await theirs.record([row(8)] as never);
        });
        expect(parsed).toBe(0);
        const positions = (await openAgentThread(openDurableStore(sessions), id).messages()).map((m) => m.position);
        expect(positions).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });

    it('finds the log where the store keeps it', async () => {
        const id = mintAgentId();
        await seedThread(id, 1, 1);
        expect((await readdir(sessionsDir(dir))).filter((f) => f.endsWith('.jsonl'))).toEqual([threadLogFile(sessionsDir(dir), id).split(/[\\/]/).at(-1)]);
    });
});

const tree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
function host() {
    let events: DriverEvents = {};
    const driverFor: DriverFor = () => ((options: { events: DriverEvents }) => {
        events = options.events;
        return { start: () => {}, prompt: () => {}, kill: () => {}, get running() { return true; }, get cliSessionId() { return 'cli-1'; } };
    }) as unknown as SessionDriverFactory;
    const made = new SessionHost({ userData: dir, driverFor, processTree: tree });
    hosts.push(made);
    return { host: made, end: () => events.onTurnEnd?.({ stopReason: 'end_turn' } as never) };
}

describe('a restart of an agent with a long thread (genie#1340)', { timeout: 60_000 }, () => {
    it('shows its history, resumes it and writes its next row without parsing the whole thread', async () => {
        const record = agentRecord({ id: mintAgentId(), workspaceId: 'moic', provider: 'claude', name: 'moic' });
        const total = await seedThread(record.id, 150, 200); // 30,600 rows
        const { host: h, end } = host();
        const { parsed } = await linesParsed(async () => {
            // Shown while stopped (the window's first ask), then resumed (a new run reads it again), then a prompt: the
            // run's first write (the store's line count) and the session's turn count.
            await vi.waitFor(() => expect(h.ledgerFor(record.id).length).toBeGreaterThan(1), { timeout: 10_000 });
            h.start({ ...record, threadId: 'cli-1' } as typeof record, dir);
            await vi.waitFor(() => expect(h.ledgerFor(record.id).some((r) => r.event.kind === 'run')).toBe(true), { timeout: 10_000 });
            h.prompt(record.id, 'carry on', 'you');
            end();
            await h.settled();
        });
        const ledger = h.ledgerFor(record.id);
        const said = ledger.flatMap((r) => (r.event.kind === 'message' ? [r.event.text] : []));
        expect(said.slice(-3)).toEqual(['question 150', 'answer 150', 'carry on']);
        // Numbered on from the whole thread: the run's turn is 151, as a whole read said.
        expect(ledger.filter((r) => r.event.kind === 'turn').map((r) => (r.event as { n: number }).n).at(-1)).toBe(151);
        // Two windows of 3000 and the few earlier lines that might be turns — the whole read parsed 30,600 at least four times.
        expect(parsed).toBeLessThan(2 * 3000 + 2 * 400);
        expect(total).toBeGreaterThan(30_000);
    });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { openAgentThread, openDurableStore } from '../src/core/thread-store.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import { AgentSession, type DriverEvents, type SessionDriver, type SessionDriverFactory } from '../src/core/session.js';
import { ledgerRow, visibleRows, type TimedEvent } from '../src/core/stream-view.js';

/**
 * A TURN IS A ROW IN THE LEDGER (the board's `Turn 14 · started by you · 14:07:12` divider; the index column's
 * `Turn 14 · now`). The session layer sees every turn — it counts them for the budget panel — but until now nothing
 * reached the ledger, so "which turn is this row in" was not derivable from the rows a surface holds. The marker is
 * written where the turn STARTS (a prompt), by whoever started it when the caller says so, and `null` when nobody
 * reported who — never guessed to be "you".
 */

const dirs: string[] = [];
function tempDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'genie2-turn-'));
    dirs.push(d);
    return d;
}
afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

function fakeDriver() {
    let events: DriverEvents = {};
    const factory: SessionDriverFactory = (options) => {
        events = options.events;
        const driver: SessionDriver = {
            start: () => {},
            prompt: () => {},
            kill: () => {},
            cliSessionId: null,
        };
        return driver;
    };
    return { factory, endTurn: () => events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null }) };
}

describe('a prompt opens a TURN in the ledger', () => {
    it('Turn n+1 with who started it when the caller says so, null when nobody did; persisted to the thread like any row', async () => {
        const dir = tempDir();
        const store = openDurableStore(dir);
        const id = mintAgentId();
        const rows: StreamEvent[] = [];
        const d = fakeDriver();
        const session = new AgentSession({ agentId: id, cwd: dir, store, driverFactory: d.factory, processTree: noProcessTree, onEvent: (e) => rows.push(e) });

        session.start();
        session.prompt('hello', 'you');
        // The marker, then the prompt itself as your message (recorded when sent — Claude does not echo it).
        expect(rows.slice(-2)).toEqual([{ kind: 'turn', n: 1, by: 'you' }, { kind: 'message', speaker: 'you', peerName: null, text: 'hello' }]);

        d.endTurn();
        session.prompt('again');
        expect(rows.slice(-2)).toEqual([{ kind: 'turn', n: 2, by: null }, { kind: 'message', speaker: 'you', peerName: null, text: 'again' }]);
        expect(rows.filter((r) => r.kind === 'turn')).toHaveLength(2);

        // The thread keeps the structure a resumed session is drawn from. Every row written, then counted (not polled
        // against a 1 s clock: prism-harness 0.7.0 writes asynchronously, and a loaded machine missed it).
        await session.settled();
        expect(await openAgentThread(store, id).count()).toBe(4);
        const persisted = await openAgentThread(store, id).messages();
        expect(persisted.map((r) => (r.message as { kind: string }).kind)).toEqual(['turn', 'message', 'turn', 'message']);
    });
});

const timed = (id: string, event: StreamEvent, at: number | null = 1_000): TimedEvent => ({ id, event, at });

describe('the turn row', () => {
    it('reads `Turn 14 · started by you` — kind turn, muted, no lane; `Turn 14` alone when nobody is named', () => {
        const named = ledgerRow(timed('r1', { kind: 'turn', n: 14, by: 'you' }));
        expect(named).toMatchObject({ kind: 'turn', main: 'Turn 14 · started by you', tone: 'muted', lane: null, expandable: false, inspectable: false });

        const peer = ledgerRow(timed('r2', { kind: 'turn', n: 15, by: 'wren' }));
        expect(peer.main).toBe('Turn 15 · started by wren');

        const anon = ledgerRow(timed('r3', { kind: 'turn', n: 16, by: null }));
        expect(anon.main).toBe('Turn 16');
    });

    it('is STRUCTURE, not content: visible under every lane selection, like the compaction divider', () => {
        const rows = [
            timed('t', { kind: 'turn', n: 1, by: 'you' }),
            timed('m', { kind: 'message', speaker: 'agent', peerName: null, text: 'hi' }),
            timed('k', { kind: 'think', text: 'hmm', tokens: null }),
        ];
        expect(visibleRows(rows, ['thoughts']).map((r) => r.id)).toEqual(['t', 'k']);
        expect(visibleRows(rows, []).map((r) => r.id)).toEqual(['t']);
    });
});

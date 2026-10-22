import { describe, expect, it, vi } from 'vitest';
import type { AgentPushPayload } from '../src/core/agent-push-wire.js';
import type { TimedEvent } from '../src/core/stream-view.js';

/**
 * THE WHOLE UI FROZE EVERY TIME AN AGENT DID ANYTHING (the owner, 2026-10-22: "Nearly every time you do anything the whole
 * UI freezes for a few seconds … even just spinning up a new agent"). Measured on his machine, Genie 2.0.0-beta.36: while
 * the agent `tynn` ran three trivial shell commands, the RENDERER process burned 0.66 CPU-seconds in a ~2 s window (main
 * 0.20, gpu 0.20) — and the renderer's JavaScript is one thread, so that is the freeze.
 *
 * Main already sends only the rows that changed (core/agent-push-wire.ts). But the PRELOAD rebuilt the whole detail from
 * that patch and handed it to the page — and a value handed across `contextBridge` is COPIED, object by object, into the
 * page's world. Every push of a watched agent copied its entire ledger (thousands of rows, megabytes) on the renderer's one
 * thread, once per view watching it. These tests hold what crosses into the page per event to the rows that changed.
 */

const ipc = vi.hoisted(() => ({
    listeners: new Map<string, Set<(event: unknown, payload: unknown) => void>>(),
    sent: [] as unknown[][],
    exposed: new Map<string, Record<string, unknown>>(),
}));
vi.mock('electron', () => ({
    ipcRenderer: {
        invoke: () => Promise.resolve(null),
        send: (...args: unknown[]) => { ipc.sent.push(args); },
        on: (channel: string, fn: (event: unknown, payload: unknown) => void) => { const s = ipc.listeners.get(channel) ?? new Set(); s.add(fn); ipc.listeners.set(channel, s); },
        removeListener: (channel: string, fn: (event: unknown, payload: unknown) => void) => { ipc.listeners.get(channel)?.delete(fn); },
    },
    contextBridge: { exposeInMainWorld: (name: string, api: Record<string, unknown>) => { ipc.exposed.set(name, api); } },
}));

const words = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau'.split(' ');
const text = (n: number, seed: number): string => {
    let out = '';
    for (let i = seed; out.length < n; i = (i * 7 + 3) % 1013) out += `${words[i % words.length]} `;
    return out.slice(0, n);
};

/**
 * A ledger shaped like tynn's (2026-10-22, its newest 7,000 rows, by kind and size only): a tool call and its completion
 * with output (~1.2 KB), a debug notice (~400 B), now and then a reply, a usage report, a turn. Synthetic text.
 */
function ledgerOf(n: number): TimedEvent[] {
    const rows: TimedEvent[] = [];
    let turn = 0;
    for (let i = 0; rows.length < n; i += 1) {
        const at = 1_760_000_000_000 + i * 1_000;
        const push = (event: Record<string, unknown>) => { if (rows.length < n) rows.push({ id: `a:${rows.length}`, event: event as never, at }); };
        if (i % 50 === 0) push({ kind: 'turn', n: (turn += 1), by: null });
        push({ kind: 'tool', toolCallId: `t${i}`, name: 'Bash', title: `run ${i}`, status: 'pending', toolKind: 'execute', rawInput: { command: text(80, i), description: text(40, i + 1) } });
        push({ kind: 'tool', toolCallId: `t${i}`, name: null, title: null, status: 'completed', toolKind: null, rawInput: null, output: text(1_100, i + 2) });
        push({ kind: 'notice', level: 'debug', message: text(300, i + 3), headroom: null, model: null, estimate: null });
        if (i % 20 === 0) push({ kind: 'message', speaker: 'agent', peerName: null, text: text(600, i + 4) });
        if (i % 50 === 49) { push({ kind: 'usage', used: 1_000 + i, size: 200_000, cost: 0.1, inTokens: null, outTokens: null }); push({ kind: 'finished', n: turn }); }
        if (i % 300 === 0) push({ kind: 'plan', entries: [{ content: text(60, i), status: 'completed' }, { content: text(60, i + 1), status: 'in_progress' }] });
    }
    return rows;
}

const detailOf = { agent: { id: 'a', name: 'tynn', provider: 'claude', fidelity: 'declared', cwd: '/w' }, session: null, turns: 1, cost: null, refusal: null };

/** Main's pushes on the agent's channel, as `AgentPush` sends them: the whole ledger first, then a patch per event. */
function mainPushes(agentId: string, payload: AgentPushPayload<typeof detailOf, TimedEvent>): void {
    for (const fn of ipc.listeners.get(`genie:agent-changed:${agentId}`) ?? []) fn({}, payload);
}

/**
 * What the PAGE's world receives per event, in JSON bytes: every argument the preload passes into a callback the page
 * handed it (each one is a copy across `contextBridge`). Through the subscription the page uses for an agent's live detail.
 */
async function crossingPerEvent(agentId: string, n: number): Promise<{ first: number; perEvent: number; views: number }> {
    await import('../src/main/preload.js');
    const api = ipc.exposed.get('genie') as Record<string, unknown>;
    const subscribe = (api['subscribeAgentWire'] ?? api['subscribeAgent']) as (id: string, cb: (value: unknown) => void) => () => void;
    const crossings: number[] = [];
    const view = (value: unknown) => { crossings.push(JSON.stringify(value).length); };
    // Two views watch the same agent (the Agent view and the chat do, for the agent on screen).
    const offs = [subscribe(agentId, view), subscribe(agentId, view)];
    const rows = ledgerOf(n);
    mainPushes(agentId, { seq: 1, detail: detailOf, rows: { base: null, keep: 0, append: rows } });
    const first = crossings.splice(0).reduce((a, b) => a + b, 0);
    // 10 events: a new row each (a tool call), the way the host's push sends them.
    let seq = 1;
    for (let i = 0; i < 10; i += 1) {
        const row: TimedEvent = { id: `n:${i}`, event: { kind: 'tool', toolCallId: `x${i}`, name: 'Bash', title: 'ls', status: 'pending', toolKind: 'execute', rawInput: { command: 'ls' } } as never, at: 1 };
        mainPushes(agentId, { seq: seq + 1, detail: detailOf, rows: { base: seq, keep: n + i, append: [row] } });
        seq += 1;
    }
    const perEvent = crossings.reduce((a, b) => a + b, 0) / 10;
    for (const off of offs) off();
    return { first, perEvent, views: 2 };
}

describe('what crosses into the page per event of a watched agent', () => {
    it('is the rows that changed — the same at 100,000 rows as at 1,000, not a copy of the ledger', async () => {
        const small = await crossingPerEvent('small', 1_000);
        const large = await crossingPerEvent('large', 100_000);
        console.log(`PERF: bytes into the page per event: ${Math.round(small.perEvent)} at 1k rows, ${Math.round(large.perEvent)} at 100k rows (first push ${small.first} / ${large.first})`);
        // POSITIVE CONTROL: the gauge sees a ledger when one crosses — the first push carries all of it.
        expect(large.first).toBeGreaterThan(50_000_000);
        // One row is ~250 bytes, and the detail around it under 1 KB: 4 KB for both views is a row, not a ledger.
        expect(large.perEvent, `bytes per event at 100k rows: ${Math.round(large.perEvent)}`).toBeLessThan(4_096);
        expect(large.perEvent / small.perEvent).toBeLessThan(1.5);
    });

    it('the page still sees EXACTLY the ledger, every view the same detail, through ONE subscription per agent; the last view to leave stops the watch', async () => {
        await import('../src/main/preload.js');
        const { pageBridge } = await import('../src/renderer/bridge.js');
        const preload = ipc.exposed.get('genie') as unknown as import('../src/renderer/bridge.js').PreloadBridge;
        const bridge = pageBridge(preload);
        // One per window: the same page bridge every time, so views share a receiver.
        expect(pageBridge(preload)).toBe(bridge);
        ipc.sent.length = 0;
        const seen: { a: unknown[]; b: unknown[] } = { a: [], b: [] };
        const offA = bridge.subscribeAgent('exact', (d) => seen.a.push(d));
        const offB = bridge.subscribeAgent('exact', (d) => seen.b.push(d));
        // Counted: ONE watch asked of main for two views (a second would reset what main holds and resend the ledger).
        expect(ipc.sent.filter((s) => s[0] === 'genie:agent-watch' && s[1] === 'exact')).toEqual([['genie:agent-watch', 'exact', true]]);
        expect(ipc.listeners.get('genie:agent-changed:exact')?.size).toBe(1);

        let ledger = ledgerOf(300);
        mainPushes('exact', { seq: 1, detail: detailOf, rows: { base: null, keep: 0, append: ledger } });
        const grow = (seq: number, keep: number, append: TimedEvent[]) => {
            ledger = [...ledger.slice(0, keep), ...append];
            mainPushes('exact', { seq, detail: { ...detailOf, turns: seq }, rows: { base: seq - 1, keep, append } });
        };
        grow(2, 300, [{ id: 'n:1', event: { kind: 'tool', toolCallId: 'x', name: 'Bash', title: 'ls', status: 'pending', toolKind: 'execute', rawInput: null } as never, at: 2 }]);
        grow(3, 300, [{ id: 'n:1', event: { kind: 'tool', toolCallId: 'x', name: null, title: null, status: 'completed', toolKind: null, rawInput: null } as never, at: 3 }]);
        grow(4, 301, [{ id: 'n:2', event: { kind: 'message', speaker: 'agent', peerName: null, text: 'done' } as never, at: 4 }]);
        // A patch for a base the page does not hold is ignored, never guessed at.
        mainPushes('exact', { seq: 9, detail: detailOf, rows: { base: 7, keep: 1, append: [] } });

        expect(seen.a).toHaveLength(4);
        const last = seen.a.at(-1) as { rows: TimedEvent[]; turns: number };
        expect(last.rows).toEqual(ledger);
        expect(last.turns).toBe(4);
        // The same detail object to both views: rebuilt once per push, not once per view.
        expect(seen.b).toHaveLength(4);
        seen.a.forEach((d, i) => expect(seen.b[i]).toBe(d));
        // Rows the page already held are reused by reference, not copied.
        expect((seen.a[3] as { rows: TimedEvent[] }).rows[0]).toBe((seen.a[0] as { rows: TimedEvent[] }).rows[0]);

        offA();
        expect(ipc.sent.filter((s) => s[0] === 'genie:agent-watch' && s[2] === false)).toEqual([]);
        offB();
        expect(ipc.sent.filter((s) => s[0] === 'genie:agent-watch' && s[1] === 'exact' && s[2] === false)).toHaveLength(1);
        expect(ipc.listeners.get('genie:agent-changed:exact')?.size ?? 0).toBe(0);
    });
});

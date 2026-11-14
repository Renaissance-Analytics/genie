import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentPushPayload } from '../src/core/agent-push-wire.js';
import type { TimedEvent } from '../src/core/stream-view.js';
import { LOCAL_FRAME_CHANNELS, LOCAL_FRAME_LIMIT_BYTES, type LocalFramePort } from '../src/core/local-frame.js';
import { Baton, PairingPins } from '../src/core/remote.js';
import { inMemoryPair, type ServerConnection } from '../src/core/remote-protocol.js';
import { buildHostApi } from '../src/main/host-api.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost } from '../src/main/remote-host.js';
import { pageBridge, type PreloadBridge } from '../src/renderer/bridge.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';
import { protocolContractDeps } from './support/protocol-contract-deps.js';

/**
 * THE WHOLE UI FROZE EVERY TIME AN AGENT DID ANYTHING (the owner, 2026-10-22: "Nearly every time you do anything the whole
 * UI freezes for a few seconds … even just spinning up a new agent"). Measured on his machine, Genie 2.0.0-beta.36: while
 * the agent `tynn` ran three trivial shell commands, the RENDERER process burned 0.66 CPU-seconds in a ~2 s window (main
 * 0.20, gpu 0.20) — and the renderer's JavaScript is one thread, so that is the freeze.
 *
 * Main already sends only the rows that changed (core/agent-push-wire.ts). But the PRELOAD rebuilt the whole detail from
 * that patch and handed it to the page — and a value handed across `contextBridge` is COPIED, object by object, into the
 * page's world. Every push of a watched agent copied its entire ledger (thousands of rows, megabytes) on the renderer's one
 * thread, once per view watching it. These tests now use the actual preload frame port, host blob/patch production,
 * protocol client and shared page receiver. One frame crosses per event, however many views show that agent.
 */

const ipc = vi.hoisted(() => ({
    listeners: new Map<string, Set<(event: unknown, payload: unknown) => void>>(),
    sent: [] as unknown[][],
    exposed: new Map<string, Record<string, unknown>>(),
    send: (_channel: string, ..._args: unknown[]) => {},
}));
vi.mock('electron', () => ({
    ipcRenderer: {
        invoke: () => Promise.resolve(null),
        send: (channel: string, ...args: unknown[]) => { ipc.sent.push([channel, ...args]); ipc.send(channel, ...args); },
        on: (channel: string, fn: (event: unknown, payload: unknown) => void) => { const s = ipc.listeners.get(channel) ?? new Set(); s.add(fn); ipc.listeners.set(channel, s); },
        removeListener: (channel: string, fn: (event: unknown, payload: unknown) => void) => { ipc.listeners.get(channel)?.delete(fn); },
    },
    contextBridge: { exposeInMainWorld: (name: string, api: Record<string, unknown>) => { ipc.exposed.set(name, api); } },
}));

const words = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau'.split(' ');
/** The reference: words chained from `seed`, cut at `n` characters. */
const textByWords = (n: number, seed: number): string => {
    let out = '';
    for (let i = seed; out.length < n; i = (i * 7 + 3) % 1013) out += `${words[i % words.length]} `;
    return out.slice(0, n);
};
/*
 * The SAME text, read from precomputed chains (genie#1273). After its first word the chain depends only on
 * (seed * 7 + 3) % 1013, so each of the 1,013 tails is built once. Building 100,000 rows word by word was 1.2 s of this
 * file on omarchy-test — most of what timed it out — and none of it was the cost under test. Checked against the
 * reference below.
 */
const LONGEST = 1_100;
const tails = Array.from({ length: 1013 }, (_, j) => textByWords(LONGEST, j));
const text = (n: number, seed: number): string => {
    if (n > LONGEST) return textByWords(n, seed);
    return `${words[seed % words.length]} ${tails[(seed * 7 + 3) % 1013]}`.slice(0, n);
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

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
    // Disconnect the test host without telling an abandoned page to reconnect after the test.
    ipc.listeners.clear(); ipc.send = () => {};
    for (const close of cleanup.splice(0)) await close();
    ipc.sent.length = 0; vi.unstubAllGlobals();
});
const settle = async () => { for (let i = 0; i < 12; i += 1) await new Promise<void>(resolve => setImmediate(resolve)); };

async function frameHost(agentId: string, initial: TimedEvent[]) {
    const dir = await mkdtemp(join(tmpdir(), 'genie-per-event-'));
    let seq = 0, accept!: (connection: ServerConnection) => void;
    const devices = await DeviceStore.open(dir, { now: Date.now, random: () => `fixture-${++seq}` });
    const deps = protocolContractDeps(dir), changes = new Set<(id: string) => void>();
    let rows = initial;
    Object.assign(deps, { detailFor: () => ({ ...detailOf, rows }) });
    Object.assign(deps.host, { subscribe: (listener: (id: string) => void) => { changes.add(listener); return () => { changes.delete(listener); }; } });
    new RemoteHost({ api: buildHostApi(deps), hostName: 'frame-test', baton: new Baton(), devices,
        pins: new PairingPins({ now: Date.now }), confirm: allowEveryPairing,
        transport: { onConnection: listener => { accept = listener; return () => {}; } } });
    const pair = inMemoryPair(), costs: Copied[] = [];
    let handle = '';
    pair.client.onMessage(text => {
        const bytes = Buffer.byteLength(text);
        expect(bytes).toBeLessThanOrEqual(LOCAL_FRAME_LIMIT_BYTES);
        costs.push(copiedInto(JSON.parse(text), bytes));
        for (const listener of ipc.listeners.get(LOCAL_FRAME_CHANNELS.toWindow) ?? []) {
            (listener as (...args: unknown[]) => void)({}, 'frame', handle, text);
        }
    });
    ipc.send = (channel, action, connection, text) => {
        if (channel !== LOCAL_FRAME_CHANNELS.toHost) return;
        if (action === 'open') {
            handle = connection as string;
            accept({ ...pair.server, preAuth: { kind: 'local', label: 'page', isOwner: true, workspaceId: null, readonly: false, window: 'main' } });
        } else if (action === 'frame') pair.client.send(text as string);
        else pair.client.close();
    };
    cleanup.push(async () => { pair.client.close(); await devices.flushed(); await rm(dir, { recursive: true, force: true }); });
    vi.resetModules(); ipc.listeners.clear();
    await import('../src/main/preload.js');
    const preload = ipc.exposed.get('genie') as unknown as PreloadBridge;
    vi.stubGlobal('window', { genieLocalProtocol: ipc.exposed.get('genieLocalProtocol') as unknown as LocalFramePort });
    const bridge = pageBridge(preload);
    await vi.waitFor(() => expect(bridge.localProtocol!.state().phase).toBe('ready'));
    return { bridge, costs,
        change: (next: TimedEvent[]) => { rows = next; for (const listener of changes) listener(agentId); },
        push: (payload: AgentPushPayload<typeof detailOf, TimedEvent>) => pair.server.send(JSON.stringify({ kind: 'event', channel: 'local-agent', payload: { agentId, payload } })),
        calls: (method: string) => ipc.sent.filter(args => args[0] === LOCAL_FRAME_CHANNELS.toHost && args[1] === 'frame')
            .map(args => JSON.parse(args[3] as string) as { method?: string; args?: unknown[] })
            .filter(frame => frame.method === method && frame.args?.[0] === agentId),
    };
}

/** Decoded row/object counts and actual UTF-8 bytes in a frame crossing into the page. */
interface Copied { readonly objects: number; readonly rows: number; readonly bytes: number }

/**
 * Walk the decoded frame structure without serialising another copy. The preload now passes a string; its byte count is
 * measured before parsing, and row/object counts detect a whole-ledger regression in an event's payload. The large first
 * transfer uses the actual host's blob chunks; subscribers separately verify every reconstructed ledger row.
 */
function copiedInto(value: unknown, frameBytes: number): Copied {
    let objects = 0;
    let rows = 0;
    const stack: unknown[] = [value];
    while (stack.length > 0) {
        const v = stack.pop();
        if (v === null || typeof v !== 'object') continue;
        objects += 1;
        if (Array.isArray(v)) { for (const x of v) stack.push(x); continue; }
        const o = v as Record<string, unknown>;
        if ('id' in o && 'event' in o) rows += 1;
        for (const k in o) stack.push(o[k]);
    }
    return { objects, rows, bytes: frameBytes };
}

const sum = (xs: readonly Copied[]): Copied => xs.reduce((a, b) => ({ objects: a.objects + b.objects, rows: a.rows + b.rows, bytes: a.bytes + b.bytes }), { objects: 0, rows: 0, bytes: 0 });
const per = (c: Copied, n: number): Copied => ({ objects: c.objects / n, rows: c.rows / n, bytes: c.bytes / n });

/**
 * What actually crosses the page's frame port. Large initial ledgers arrive as capped blob chunks; new events are one
 * small patch for the shared receiver, rather than one ledger copy per view. The initial delivery is also checked whole.
 */
async function crossingPerEvent(agentId: string, n: number): Promise<{ first: Copied; perEvent: Copied; views: number }> {
    const rows = ledgerOf(n), h = await frameHost(agentId, rows), seen: unknown[] = [];
    const view = (value: unknown) => { seen.push(value); };
    // Two views watch the same agent (the Agent view and the chat do, for the agent on screen).
    const offs = [h.bridge.subscribeAgent(agentId, view), h.bridge.subscribeAgent(agentId, view)];
    await vi.waitFor(() => expect(seen).toHaveLength(2), { timeout: 20_000 });
    expect(seen[0]).toBe(seen[1]);
    for (const detail of seen) expect((detail as { rows: TimedEvent[] }).rows).toEqual(rows);
    await settle();
    const first = sum(h.costs.splice(0));
    expect(first.bytes).toBeGreaterThan(n * 100); // Positive control: the gauge sees the real whole-ledger transfer.
    const firstRows = seen.reduce<number>((total, detail) => total + (detail as { rows: TimedEvent[] }).rows.length, 0);
    // 10 events: a new row each (a tool call), the way the host's push sends them.
    for (let i = 0; i < 10; i += 1) {
        const row: TimedEvent = { id: `n:${i}`, event: { kind: 'tool', toolCallId: `x${i}`, name: 'Bash', title: 'ls', status: 'pending', toolKind: 'execute', rawInput: { command: 'ls' } } as never, at: 1 };
        rows.push(row); h.change(rows);
        await vi.waitFor(() => expect(seen).toHaveLength((i + 2) * 2));
    }
    await settle();
    const perEvent = per(sum(h.costs), 10);
    for (const off of offs) off();
    return { first: { ...first, rows: firstRows }, perEvent, views: 2 };
}

describe('the synthetic ledger', () => {
    it('its text is the word-by-word reference, character for character, for every length the ledger uses', () => {
        for (const n of [40, 60, 80, 300, 600, 1_100]) {
            for (let seed = 0; seed < 40_000; seed += 7) expect(text(n, seed) === textByWords(n, seed), `n ${n}, seed ${seed}`).toBe(true);
        }
    });
});

describe('what crosses into the page per event of a watched agent', () => {
    it('is the rows that changed — the same at 100,000 rows as at 1,000, not a copy of the ledger', async () => {
        const small = await crossingPerEvent('small', 1_000);
        const large = await crossingPerEvent('large', 100_000);
        console.log(`PERF: into the page per event: ${small.perEvent.rows} rows, ${small.perEvent.objects} objects, ${Math.round(small.perEvent.bytes)} bytes at 1k rows; ${large.perEvent.rows} rows, ${large.perEvent.objects} objects, ${Math.round(large.perEvent.bytes)} bytes at 100k (first push ${small.first.rows} / ${large.first.rows} rows)`);
        // POSITIVE CONTROL: both views received the complete ledger; the frame-byte gauge also saw the whole transfer.
        expect(large.first.rows).toBe(100_000 * large.views);
        expect(small.first.rows).toBe(1_000 * small.views);
        // One row crosses ONCE for both views; the shared receiver rebuilds it inside the page.
        expect(large.perEvent.rows, `rows into the page per event at 100k rows: ${large.perEvent.rows}`).toBe(1);
        expect(small.perEvent.rows).toBe(1);
        // And the same copy at 100,000 rows as at 1,000: object for object.
        expect(large.perEvent.objects, `objects copied per event: ${large.perEvent.objects} at 100k rows, ${small.perEvent.objects} at 1k`).toBe(small.perEvent.objects);
        // One row is ~250 bytes, and the detail around it under 1 KB: 4 KB for both views is a row, not a ledger.
        expect(large.perEvent.bytes, `bytes per event at 100k rows: ${Math.round(large.perEvent.bytes)}`).toBeLessThan(4_096);
        expect(large.perEvent.bytes / small.perEvent.bytes).toBeLessThan(1.5);
    }, 30_000);

    it('the page still sees EXACTLY the ledger, every view the same detail, through ONE subscription per agent; the last view to leave stops the watch', async () => {
        const h = await frameHost('exact', ledgerOf(300)), bridge = h.bridge;
        // One per window: the same page bridge every time, so views share a receiver.
        expect(pageBridge(ipc.exposed.get('genie') as unknown as PreloadBridge)).toBe(bridge);
        ipc.sent.length = 0;
        const seen: { a: unknown[]; b: unknown[] } = { a: [], b: [] };
        const offA = bridge.subscribeAgent('exact', (d) => seen.a.push(d));
        const offB = bridge.subscribeAgent('exact', (d) => seen.b.push(d));
        // Counted: ONE watch asked of main for two views (a second would reset what main holds and resend the ledger).
        expect(h.calls('agent.watch')).toHaveLength(1);
        expect(ipc.listeners.get(LOCAL_FRAME_CHANNELS.toWindow)?.size).toBe(1);

        let ledger = ledgerOf(300);
        await vi.waitFor(() => expect(seen.a).toHaveLength(1));
        const grow = (seq: number, keep: number, append: TimedEvent[]) => {
            ledger = [...ledger.slice(0, keep), ...append];
            h.push({ seq, detail: { ...detailOf, turns: seq }, rows: { base: seq - 1, keep, append } });
        };
        grow(2, 300, [{ id: 'n:1', event: { kind: 'tool', toolCallId: 'x', name: 'Bash', title: 'ls', status: 'pending', toolKind: 'execute', rawInput: null } as never, at: 2 }]);
        grow(3, 300, [{ id: 'n:1', event: { kind: 'tool', toolCallId: 'x', name: null, title: null, status: 'completed', toolKind: null, rawInput: null } as never, at: 3 }]);
        grow(4, 301, [{ id: 'n:2', event: { kind: 'message', speaker: 'agent', peerName: null, text: 'done' } as never, at: 4 }]);
        // A patch for a base the page does not hold is ignored, never guessed at.
        h.push({ seq: 9, detail: detailOf, rows: { base: 7, keep: 1, append: [] } });
        await settle();

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
        expect(h.calls('agent.unwatch')).toEqual([]);
        offB();
        expect(h.calls('agent.unwatch')).toHaveLength(1);
        const delivered = seen.a.length;
        h.push({ seq: 10, detail: detailOf, rows: { base: null, keep: 0, append: [] } });
        await settle();
        expect(seen.a).toHaveLength(delivered); expect(seen.b).toHaveLength(delivered);
    });
});

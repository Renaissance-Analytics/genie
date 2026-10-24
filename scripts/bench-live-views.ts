/**
 * MEASURE THE PER-PUSH COST OF THE LIVE VIEWS' DATA WORK (chat-lag work, the owner 2026-10-22: "are we redrawing the
 * whole chat and work streams every time they update?"). For a history of N rows, how long one push's recompute takes:
 * the chat's `chatThreadFrom` (chatMessages over every row) and the Stream's preparation (activityRows +
 * resolveThinkTokens + resolveTurnCosts + resolveToolDurations over every row). If the time grows with N, an update is
 * paying for the whole history — the thing the owner's rule forbids.
 *
 * Usage (in a test VM): npx tsx scripts/bench-live-views.ts
 */
import { performance } from 'node:perf_hooks';
import { chatThreadFrom, type ChatDetail } from '../src/core/chat-view.js';
import { activityRows, resolveThinkTokens, resolveToolDurations, resolveTurnCosts, type TimedEvent } from '../src/core/stream-view.js';
import { StreamPrep } from '../src/core/stream-prep.js';

function history(n: number): TimedEvent[] {
    const rows: TimedEvent[] = [];
    for (let i = 0; i < n; i += 1) {
        const k = i % 4;
        if (i % 40 === 0) { rows.push({ id: `t${i}`, event: { kind: 'turn', n: i / 40, by: 'you' } as unknown as TimedEvent['event'], at: 1_700_000_000_000 + i * 1000 }); }
        const event = k === 0 ? { kind: 'message', speaker: 'you', peerName: null, text: `ask ${i}` }
            : k === 1 ? { kind: 'think', text: `thinking about ${i}` }
            : k === 2 ? { kind: 'tool', name: 'Bash', input: `ls ${i}`, status: 'done' }
            : { kind: 'message', speaker: 'agent', peerName: null, text: `reply ${i}\nsecond line` };
        rows.push({ id: `e${i}`, event: event as unknown as TimedEvent['event'], at: 1_700_000_000_000 + i * 1000 });
    }
    return rows;
}

function time(label: string, runs: number, fn: () => unknown): number {
    for (let i = 0; i < 3; i += 1) fn();
    const t0 = performance.now();
    for (let i = 0; i < runs; i += 1) fn();
    const ms = (performance.now() - t0) / runs;
    console.log(`  ${label.padEnd(36)} ${ms.toFixed(2)} ms per push`);
    return ms;
}

for (const n of [3_000, 30_000, 100_000]) {
    const rows = history(n);
    const detail: ChatDetail = { agent: { id: 'agent_a', name: 'atlas', provider: 'claude', fidelity: 'declared' }, session: null, rows, comms: null };
    console.log(`${n.toLocaleString('en-US')} rows`);
    time('chat: chatThreadFrom', 20, () => chatThreadFrom(detail, 'agent_a', [], Date.now));
    time('chat: chatThreadFrom, last 500 lines', 20, () => chatThreadFrom(detail, 'agent_a', [], Date.now, 500));
    time('stream: prepare (activity+tokens+costs+durations)', 20, () => { resolveTurnCosts(resolveThinkTokens(activityRows(rows))); resolveToolDurations(rows); });
    const prep = new StreamPrep();
    prep.update(rows);
    // The pushed ledgers are built BEFORE timing (the preload builds them, not the Stream): each one row longer.
    const pushes: TimedEvent[][] = [];
    let grown = rows;
    for (let k = 0; k < 23; k += 1) { grown = [...grown, { id: `x${k}`, event: { kind: 'think', text: `t${k}`, tokens: null } as unknown as TimedEvent['event'], at: null }]; pushes.push(grown); }
    let next = 0;
    time('stream: StreamPrep, one row appended', 20, () => prep.update(pushes[next++]!));
}
console.log('\nAt 20 pushes a second, every 50 ms of work per push is a whole core.');

import { describe, expect, it } from 'vitest';
import { deliveryFrom } from '../src/core/delivery.js';
import { LiveReadings, modelFrom, planFrom, usageFrom } from '../src/core/live-readings.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';
import { turnNow } from '../src/core/turn-now.js';

/**
 * THE READINGS KEPT AS ROWS ARRIVE MUST BE THE READINGS READ FROM ALL OF THEM.
 *
 * `probe()` used to read every row of an agent's ledger for its context figure, latest delivery, plan, model and what it
 * is doing now — on every event, several times (the owner, 2026-10-20: Genie's main process at a full core). They are now
 * kept as rows arrive (core/live-readings.ts). This holds every one of them equal to the batch function it replaces, after
 * EVERY row of random ledgers shaped the way a session writes them: rows appended, and the newest message or thought
 * growing in place.
 */

const NOW = 1_760_000_000_000;

function random(seed: number): () => number {
    let s = seed;
    return () => { s = (s * 1_103_515_245 + 12_345) % 2 ** 31; return s / 2 ** 31; };
}

const pick = <T,>(rand: () => number, xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

function toolEvent(rand: () => number, id: string): StreamEvent {
    const status = pick(rand, ['pending', 'in_progress', 'completed', 'failed', null] as const);
    const shape = pick(rand, ['commit', 'edit', 'inbox', 'done', 'read', 'bare'] as const);
    const base = { kind: 'tool' as const, toolCallId: id, name: null as string | null, title: null as string | null, status, toolKind: null as 'edit' | 'read' | 'execute' | null, rawInput: null as unknown };
    if (rand() < 0.4) return { ...base, title: rand() < 0.5 ? `t ${id}` : null };
    switch (shape) {
        case 'commit': return { ...base, name: 'Bash', toolKind: 'execute', rawInput: { command: 'git commit -m "x"' }, ...(rand() < 0.7 ? { output: `[main ${id.padEnd(7, 'a').replace(/[^0-9a-f]/g, 'b').slice(0, 7)}] the message` } : {}) };
        case 'edit': return { ...base, name: 'Edit', toolKind: 'edit', rawInput: rand() < 0.8 ? { file_path: `src/${id}.ts`, old_string: 'a\nb', new_string: 'a\nb\nc' } : {} };
        case 'inbox': return { ...base, name: 'mcp__genie__agentinbox', rawInput: { action: 'send', to: 'moic', text: 'hello\nthere' } };
        case 'done': return { ...base, name: 'mcp__genie__imDone', rawInput: { handoff: 'all done' } };
        case 'read': return { ...base, name: 'Read', toolKind: 'read', rawInput: { file_path: 'x' } };
        default: return { ...base, name: rand() < 0.5 ? 'Bash' : null };
    }
}

function ledger(seed: number, length: number, check: (rows: readonly TimedEvent[], readings: LiveReadings) => void): void {
    const rand = random(seed);
    const rows: TimedEvent[] = [];
    const readings = new LiveReadings();
    let id = 0;
    const append = (event: StreamEvent) => {
        rows.push({ id: `r${id++}`, event, at: rand() < 0.1 ? null : NOW - Math.floor(rand() * 3_600_000) });
        readings.added(rows, rows.length - 1);
    };
    for (let step = 0; step < length; step += 1) {
        const last = rows.at(-1);
        const x = rand();
        if (last && (last.event.kind === 'message' || last.event.kind === 'think') && x < 0.3) {
            // The newest message or thought grows in place (the session's `replacesLast`).
            const before = last.event;
            const grown: StreamEvent = before.kind === 'message' ? { ...before, text: before.text + pick(rand, ['', '\n', ' more', 'word\nnext']) } : before.kind === 'think' ? { ...before, text: `${before.text}…` } : before;
            rows[rows.length - 1] = { ...last, event: grown };
            readings.replaced(rows, rows.length - 1, before);
        } else if (x < 0.55) {
            append(toolEvent(rand, `c${Math.floor(rand() * 12)}`));
        } else if (x < 0.7) {
            append({ kind: 'message', speaker: pick(rand, ['agent', 'you', 'peer'] as const), text: pick(rand, ['', '\n', 'hi', '  \nsecond line', 'Do the thing']), peerName: rand() < 0.3 ? 'wren' : null });
        } else if (x < 0.76) {
            append({ kind: 'usage', used: Math.floor(rand() * 1e5), size: 200_000, cost: null });
        } else if (x < 0.82) {
            const n = Math.floor(rand() * 4);
            append({ kind: 'plan', entries: Array.from({ length: n }, (_, i) => (rand() < 0.1 ? 'junk' : { content: `step ${i}`, status: pick(rand, ['completed', 'in_progress', 'pending']) })) });
        } else if (x < 0.9) {
            append({ kind: 'notice', level: 'debug', message: 'm', headroom: null, model: pick(rand, [null, '', 'opus', 'sonnet']), estimate: null } as StreamEvent);
        } else if (x < 0.95) {
            append({ kind: 'think', text: 'hmm', tokens: null });
        } else {
            append({ kind: 'turn', n: step, by: null } as StreamEvent);
        }
        check(rows, readings);
    }
}

describe('the readings a live session keeps as its rows arrive', () => {
    it('equal the readings read from every row, after every row of 40 random ledgers', () => {
        let checked = 0;
        for (let seed = 1; seed <= 40; seed += 1) {
            ledger(seed, 400, (rows, readings) => {
                expect(readings.usage).toEqual(usageFrom(rows));
                expect(readings.plan).toEqual(planFrom(rows));
                expect(readings.model).toEqual(modelFrom(rows));
                expect(readings.delivery(rows, NOW)).toEqual(deliveryFrom(rows, NOW));
                expect(readings.turnNow()).toEqual(turnNow(rows));
                checked += 1;
            });
        }
        expect(checked).toBe(16_000);
    });

    it('a ledger read again from the start (`rebuild`) reads the same', () => {
        ledger(99, 600, (rows, readings) => {
            if (rows.length % 97 !== 0) return;
            const again = new LiveReadings();
            again.rebuild(rows);
            expect(again.delivery(rows, NOW)).toEqual(readings.delivery(rows, NOW));
            expect(again.turnNow()).toEqual(readings.turnNow());
            expect([again.usage, again.plan, again.model]).toEqual([readings.usage, readings.plan, readings.model]);
        });
    });

    it('the random ledgers reach every reading (a positive control: an equality over nulls proves nothing)', () => {
        const seen = { usage: 0, plan: 0, model: 0, commit: 0, file: 0, handoff: 0, answer: 0, prompt: 0, tool: 0 };
        for (let seed = 1; seed <= 40; seed += 1) {
            ledger(seed, 400, (rows, readings) => {
                if (readings.usage) seen.usage += 1;
                if (readings.plan) seen.plan += 1;
                if (readings.model) seen.model += 1;
                const d = readings.delivery(rows, NOW);
                if (d) seen[d.kind as 'commit' | 'file' | 'handoff' | 'answer'] += 1;
                const t = readings.turnNow();
                if (t.prompt) seen.prompt += 1;
                if (t.tool) seen.tool += 1;
            });
        }
        for (const [k, v] of Object.entries(seen)) expect(v, k).toBeGreaterThan(50);
    });
});

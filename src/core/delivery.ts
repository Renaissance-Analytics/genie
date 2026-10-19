import type { Delivery } from './dashboard-view.js';
import { editLineCounts, type TimedEvent } from './stream-view.js';

/**
 * THE DASHBOARD'S "LATEST DELIVERY" — the design mockup's column, filled (the owner, 2026-10-19: "make sure the dashboard
 * is actually following the design mockups"). The session host answered `lastDelivery: null` for every agent; this reads
 * the agent's OWN latest delivery from its session's rows, newest first:
 *
 *   - commit: the sha and message from git's own output (`[branch sha] message`) — a commit whose output names no sha,
 *     or that failed, is no delivery; a sha is never guessed;
 *   - file: an edit it finished — the path, and + / − from the real edit (`editLineCounts`); none for a whole-file write;
 *   - handoff: `→ peer` and what it said (agentinbox send), or its imDone handoff;
 *   - answer: the first line of what it said, when nothing above came later.
 *
 * Reads, searches and fetches are not deliveries.
 */

interface Call {
    name: string | null;
    toolKind: string | null;
    input: unknown;
    status: string | null;
    output: string | null;
    at: number | null;
    index: number;
}

const firstLine = (text: string): string => (text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '').slice(0, 160);
const nameIs = (name: string | null, tool: string): boolean => name !== null && (name === tool || name.endsWith(`__${tool}`) || name.endsWith(`.${tool}`));
const record = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null);

/** Git's own line after a commit: `[branch sha] message` (the branch may carry `(root-commit)`). */
const COMMIT_LINE = /\[[^\]\n]*?\s([0-9a-f]{7,40})\]\s+([^\n]+)/;

/** The age as the roster writes it: `now` under a minute, `12m`, `1h 5m`; empty when the row carries no time. */
export function ageOf(at: number | null, now: number): string {
    if (at === null) return '';
    const minutes = Math.floor((now - at) / 60_000);
    if (minutes < 1) return 'now';
    if (minutes < 60) return `${minutes}m`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function deliveryOfCall(c: Call, now: number): Delivery | null {
    if (c.status === 'failed') return null;
    const input = record(c.input);
    const age = ageOf(c.at, now);
    const command = typeof input?.['command'] === 'string' ? (input['command'] as string) : '';
    if (/\bgit\b[^\n|;&]*\bcommit\b/.test(command)) {
        const m = c.status === 'completed' && c.output !== null ? COMMIT_LINE.exec(c.output) : null;
        return m ? { kind: 'commit', main: m[1]!, sub: m[2]!.trim(), plus: null, minus: null, age } : null;
    }
    if (nameIs(c.name, 'agentinbox') && input?.['action'] === 'send' && typeof input['to'] === 'string') {
        return { kind: 'handoff', main: `→ ${input['to'] as string}`, sub: typeof input['text'] === 'string' ? firstLine(input['text'] as string) : null, plus: null, minus: null, age };
    }
    if (nameIs(c.name, 'imDone') && typeof input?.['handoff'] === 'string') {
        return { kind: 'handoff', main: 'handoff', sub: firstLine(input['handoff'] as string), plus: null, minus: null, age };
    }
    if (c.toolKind === 'edit' && c.status === 'completed') {
        const path = [input?.['file_path'], input?.['path'], input?.['filePath']].find((p): p is string => typeof p === 'string' && p.length > 0);
        if (!path) return null;
        const counts = editLineCounts(c.input);
        return { kind: 'file', main: path, sub: null, plus: counts?.plus ?? null, minus: counts?.minus ?? null, age };
    }
    return null;
}

export function deliveryFrom(rows: readonly TimedEvent[], now: number): Delivery | null {
    // A tool call arrives as several rows: its input on the call, its status and output on the updates.
    const calls = new Map<string, Call>();
    rows.forEach((r, index) => {
        const e = r.event;
        if (e.kind !== 'tool' || !e.toolCallId) return;
        const c = calls.get(e.toolCallId) ?? { name: null, toolKind: null, input: null, status: null, output: null, at: null, index };
        calls.set(e.toolCallId, {
            name: c.name ?? e.name,
            toolKind: c.toolKind ?? e.toolKind,
            input: c.input ?? e.rawInput ?? null,
            status: e.status ?? c.status,
            output: e.output ?? c.output,
            at: r.at ?? c.at,
            index,
        });
    });
    const byCallEnd = [...calls.values()].sort((a, b) => b.index - a.index);
    let next = 0;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
        // Every call that ended at or after this row is weighed first: the newest delivery wins.
        while (next < byCallEnd.length && byCallEnd[next]!.index >= i) {
            const d = deliveryOfCall(byCallEnd[next]!, now);
            if (d) return d;
            next += 1;
        }
        const e = rows[i]!.event;
        if (e.kind === 'message' && e.speaker === 'agent' && firstLine(e.text).length > 0) {
            return { kind: 'answer', main: firstLine(e.text), sub: null, plus: null, minus: null, age: ageOf(rows[i]!.at, now) };
        }
    }
    for (; next < byCallEnd.length; next += 1) {
        const d = deliveryOfCall(byCallEnd[next]!, now);
        if (d) return d;
    }
    return null;
}

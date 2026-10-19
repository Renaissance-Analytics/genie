import type { TimedEvent } from './stream-view.js';

/**
 * WHAT AN AGENT IS DOING NOW — the workspace dashboard's card (the owner, 2026-10-19; the design approved in q_09d1f4a0:
 * "what it was asked; what it is doing now (the tool it's in)"). Read from the agent's own rows, newest first:
 *
 *   - `prompt`: the first line of the latest message that STARTED a turn — yours or a peer's; the agent's own words are
 *     an answer, not an ask;
 *   - `tool`: a call made after that prompt whose latest status is `pending` or `in_progress` — by its title, else its
 *     name. A call with no status reported is not claimed to be running (`null` is not `pending`, stream-event.ts), and
 *     one left open in an earlier turn is not what the agent is in now.
 */
export interface TurnNow {
    prompt: string | null;
    tool: string | null;
}

const firstLine = (text: string): string => (text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '').slice(0, 200);

export function turnNow(rows: readonly TimedEvent[]): TurnNow {
    let start = -1;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
        const e = rows[i]!.event;
        if (e.kind === 'message' && e.speaker !== 'agent' && firstLine(e.text).length > 0) {
            start = i;
            break;
        }
    }
    const prompt = start >= 0 ? firstLine((rows[start]!.event as { text: string }).text) : null;

    // A call arrives as several rows (its input, then its updates): the latest status wins, the first title or name.
    const calls = new Map<string, { label: string | null; status: string | null; index: number }>();
    for (let i = start + 1; i < rows.length; i += 1) {
        const e = rows[i]!.event;
        if (e.kind !== 'tool' || !e.toolCallId) continue;
        const c = calls.get(e.toolCallId);
        calls.set(e.toolCallId, {
            label: c?.label ?? e.title ?? e.name,
            status: e.status ?? c?.status ?? null,
            index: c?.index ?? i,
        });
    }
    const open = [...calls.values()].filter((c) => (c.status === 'pending' || c.status === 'in_progress') && c.label !== null).sort((a, b) => b.index - a.index);
    return { prompt, tool: open[0]?.label ?? null };
}

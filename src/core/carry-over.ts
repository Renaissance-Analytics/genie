import type { PlanStepRecord } from './identity.js';
import type { StreamEvent } from './stream-event.js';

/**
 * WHAT COMES WITH AN AGENT TO ANOTHER PROVIDER (Tynn story #380). The owner: "We dropped tui as a t1 model, it's just the
 * acp over cli and I should be able to switch providers and models without losing context."
 *
 * A provider's own session means nothing to another provider, so a switch hands the new one a CARRY-OVER built from
 * Genie's own ledger of the agent: the person's, the agent's and its peers' messages in order, each tool call as ONE line
 * (its title and last status — never its input or output), thinking left out, newest last. At most the last
 * {@link CARRY_OVER_TURNS} turns and {@link CARRY_OVER_CHARS} characters, the oldest dropped first, and what was cut is
 * said at the top. Then the agent's current plan. An earlier carry-over is never carried again (no nesting).
 *
 * It is held on the agent's record and attached ONCE to the next prompt, above the person's words (core/session.ts); the
 * chat marks that turn with {@link carriedLabel}, opening to the exact text sent.
 */

export const CARRY_OVER_TURNS = 40;
export const CARRY_OVER_CHARS = 24_000;

/** A carry-over held for the next prompt: what it says, where it came from, and how much of the conversation it holds. */
export interface CarryOver {
    readonly from: string;
    readonly text: string;
    /** Turns included. */
    readonly turns: number;
    /** Turns there were in what could be carried (`since` on). */
    readonly of: number;
    /** It ends with the agent's plan. */
    readonly plan: boolean;
}

export interface CarryOverInput {
    readonly from: string;
    readonly to: string;
    readonly agentName: string;
    readonly rows: readonly { readonly event: StreamEvent; readonly at: number | null }[];
    readonly plan: readonly PlanStepRecord[];
    /** Only rows recorded after this time (epoch ms): switching BACK carries only what happened since the agent left. `null` = all. */
    readonly since: number | null;
    readonly maxTurns?: number;
    readonly maxChars?: number;
}

/** The heading the provider reads first. */
export function carryOverHeading(from: string): string {
    return `Conversation so far, from ${from}:`;
}

/** The chat's marker for the turn that carried it. */
export function carriedLabel(carry: { from: string; turns: number }): string {
    return `Context carried from ${carry.from} (${carry.turns} turn${carry.turns === 1 ? '' : 's'})`;
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The lines each turn says, oldest turn first. Rows before the first turn marker are a turn of their own. */
function turnsOf(input: CarryOverInput): string[][] {
    const turns: string[][] = [];
    let current: string[] | null = null;
    /** Each tool call's line, by its id in the current turn: a later update of the same call rewrites its line. */
    let tools = new Map<string, number>();
    const open = (): string[] => {
        if (current === null) { current = []; turns.push(current); tools = new Map(); }
        return current;
    };
    for (const { event: e, at } of input.rows) {
        if (input.since !== null && (at === null || at <= input.since)) continue;
        if (e.kind === 'turn') { current = []; turns.push(current); tools = new Map(); continue; }
        if (e.kind === 'message') {
            const text = e.text.trim();
            if (text === '') continue;
            const who = e.speaker === 'you' ? 'Person' : e.speaker === 'peer' ? (e.peerName ?? 'A peer') : input.agentName;
            open().push(`${who}: ${text}`);
            continue;
        }
        if (e.kind === 'tool') {
            const what = oneLine(e.title || e.name || 'a tool');
            const line = `- tool: ${what}${e.status ? ` (${e.status})` : ''}`;
            const lines = open();
            const at = e.toolCallId ? tools.get(e.toolCallId) : undefined;
            if (at !== undefined) lines[at] = line;
            else {
                if (e.toolCallId) tools.set(e.toolCallId, lines.length);
                lines.push(line);
            }
        }
        // Thinking, notices (an earlier carry-over among them), usage and the rest: not carried.
    }
    return turns.filter((lines) => lines.length > 0);
}

/** The last `max` characters of `s`, never splitting a character (a surrogate pair stays whole). */
function tailChars(s: string, max: number): string {
    const chars = Array.from(s);
    let start = chars.length;
    let length = 0;
    while (start > 0 && length + chars[start - 1]!.length <= max) { start -= 1; length += chars[start]!.length; }
    return chars.slice(start).join('');
}

/** The carry-over for a switch from `from`, or `null` when there is nothing to carry (no turn and no plan). */
export function buildCarryOver(input: CarryOverInput): CarryOver | null {
    const maxTurns = input.maxTurns ?? CARRY_OVER_TURNS;
    const maxChars = input.maxChars ?? CARRY_OVER_CHARS;
    const all = turnsOf(input);
    const planLines = input.plan.length > 0 ? ['', 'Current plan', ...input.plan.map((s) => `- [${s.status}] ${oneLine(s.content)}`)] : [];
    if (all.length === 0 && planLines.length === 0) return null;

    const head = (turns: number, cutText: boolean): string[] => {
        const scope = all.length > turns ? `the last ${turns} of ${all.length} turns` : `all ${turns} turn${turns === 1 ? '' : 's'}`;
        const cut = all.length - turns;
        return [
            carryOverHeading(input.from),
            `Genie carried this from your conversation on ${input.from}, so you can continue it on ${input.to}. It is context, not a request: the person's message follows it.`,
            `Included: ${scope} (at most ${maxTurns} turns and ${maxChars.toLocaleString('en-US')} characters)${cut > 0 ? `; ${cut} earlier turn${cut === 1 ? ' was' : 's were'} left out` : ''}${cutText ? '; the oldest included turn is cut short' : ''}.`,
            '',
        ];
    };
    const render = (turns: readonly string[][]): string => turns.map((lines) => lines.join('\n')).join('\n\n');

    let kept = all.slice(-maxTurns);
    const compose = (k: readonly string[][], body: string, cutText: boolean): string => [...head(k.length, cutText), body, ...planLines].join('\n');
    // The oldest turns go first, until the whole fits.
    while (kept.length > 1 && compose(kept, render(kept), false).length > maxChars) kept = kept.slice(1);
    let text = compose(kept, render(kept), false);
    if (text.length > maxChars) {
        // One turn alone is too long: its newest part is kept, whole characters only, and the top says so.
        const room = maxChars - compose(kept, '', true).length;
        text = compose(kept, `…${tailChars(render(kept), Math.max(0, room - 1))}`, true);
    }
    // A plan alone longer than the cap: whole characters, from the start.
    if (text.length > maxChars) text = Array.from(text).reduce((out, ch) => (out.length + ch.length <= maxChars ? out + ch : out), '');
    return { from: input.from, text, turns: kept.length, of: all.length, plan: planLines.length > 0 };
}

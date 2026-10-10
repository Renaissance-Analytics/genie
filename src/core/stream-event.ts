import type { ToolStatus } from '@particle-academy/prism-acp';

/**
 * THE STREAM LEDGER — one line per event.
 *
 * The Agent view is a ledger, not a chat transcript. Every event the agent reports gets
 * exactly one row: a time, an icon, a main field and a meta field. Messages are the only
 * thing that is ever expanded; a thought is one line with its cost and **never expands, even
 * while streaming**, because content jumping as reasoning arrives is the worst reading
 * experience in agent UIs.
 *
 * The build this replaces rendered a chat feed instead, which is why it looked nothing like
 * the approved design even though most of the data was present.
 *
 * ## The rule this module is really about
 *
 * **What the wire does not carry renders as NOTHING.** Not a dash, not a zero, not an
 * assumed shape. Every optional field below is `| null` for that reason, and each one has a
 * real case behind it: codex sends no cost, per-thought tokens are not an ACP field at all,
 * and a `tool_call_update` without a status is an agent that did not say rather than one
 * that said "pending".
 */

export type StreamEvent =
    | { kind: 'message'; speaker: 'agent' | 'you' | 'peer'; peerName: string | null; text: string }
    | {
          kind: 'think';
          text: string;
          /**
           * ALWAYS null from the wire. Per-thought token counts are not an ACP field.
           *
           * The design's `842 tok` is derived downstream from the change in
           * `usage.used` across the thought's span and labelled as a delta (`Δ+0.9k`) —
           * a measured difference with a unit, not a figure presented as exact. Estimating
           * from character count was considered and rejected: it is a confident number about
           * someone's spend, invented here.
           */
          tokens: number | null;
      }
    | {
          kind: 'tool';
          toolCallId: string;
          /** The machine lookup key, verbatim. */
          name: string | null;
          /** UI chrome — already ANSI-stripped by prism-acp. */
          title: string | null;
          /** `null` = the agent did not report one. Never defaulted to 'pending'. */
          status: ToolStatus | null;
          rawInput: unknown;
      }
    | {
          kind: 'usage';
          used: number;
          size: number;
          /** `null` = not reported. codex reports none, and a `0` would claim it was free. */
          cost: number | null;
      }
    | { kind: 'plan'; entries: readonly unknown[] }
    | { kind: 'divider'; variant: 'compaction'; before: number | null; after: number | null }
    | { kind: 'notice'; level: string; message: string }
    /**
     * A kind Genie does not map yet.
     *
     * RETAINED rather than dropped, matching prism-acp's own `unmapped` policy. A protocol
     * addition we silently discarded would present as an agent that went quiet — which is
     * the failure this product is least equipped to notice.
     */
    | { kind: 'unknown'; sessionUpdate: string; raw: Record<string, unknown> };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOf(update: Record<string, unknown>): string {
    const content = update['content'];
    if (!isRecord(content)) return '';
    const text = content['text'];
    return typeof text === 'string' ? text : '';
}

function numberOrNull(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

const TOOL_STATUSES: readonly string[] = ['pending', 'in_progress', 'completed', 'failed'];

function toolStatusOf(value: unknown): ToolStatus | null {
    return typeof value === 'string' && TOOL_STATUSES.includes(value) ? (value as ToolStatus) : null;
}

/**
 * Map one ACP `session/update` to a ledger row.
 *
 * Returns `null` ONLY for kinds that deliberately do not belong in the stream — today just
 * `available_commands_update`, which populates the composer's slash menu. Anything
 * unrecognised comes back as `kind: 'unknown'` instead, so a gap is visible rather than
 * silent.
 */
export function toStreamEvent(update: Record<string, unknown>): StreamEvent | null {
    const kind = update['sessionUpdate'];
    if (typeof kind !== 'string') return null;

    switch (kind) {
        case 'agent_message_chunk':
            return { kind: 'message', speaker: 'agent', peerName: null, text: textOf(update) };

        case 'user_message_chunk':
            return { kind: 'message', speaker: 'you', peerName: null, text: textOf(update) };

        case 'session_message': {
            // A named peer — rendered `atlas → wren`, never as `user`. Labelling a sibling
            // agent's message with the same word as the owner's own was a real defect.
            const from = stringOrNull(update['from']);
            return { kind: 'message', speaker: 'peer', peerName: from, text: textOf(update) };
        }

        case 'agent_thought_chunk':
            return { kind: 'think', text: textOf(update), tokens: null };

        case 'tool_call':
        case 'tool_call_update':
            return {
                kind: 'tool',
                toolCallId: stringOrNull(update['toolCallId']) ?? '',
                name: stringOrNull(update['name']),
                title: stringOrNull(update['title']),
                status: toolStatusOf(update['status']),
                rawInput: update['rawInput'] ?? null,
            };

        case 'usage_update': {
            const cost = update['cost'];
            return {
                kind: 'usage',
                used: numberOrNull(update['used']) ?? 0,
                size: numberOrNull(update['size']) ?? 0,
                cost: isRecord(cost) ? numberOrNull(cost['amount']) : null,
            };
        }

        case 'plan_update': {
            const entries = update['entries'] ?? update['plan'];
            return { kind: 'plan', entries: Array.isArray(entries) ? entries : [] };
        }

        case 'compaction_update':
            // A divider, always rendered, and NOT filterable — a drop in quality needs a
            // visible cause, and a silent compaction is amnesia with no notice.
            return {
                kind: 'divider',
                variant: 'compaction',
                before: numberOrNull(update['before']),
                after: numberOrNull(update['after']),
            };

        case 'notice': {
            const notice = isRecord(update['notice']) ? update['notice'] : {};
            return {
                kind: 'notice',
                level: stringOrNull(notice['level']) ?? 'info',
                message: stringOrNull(notice['message']) ?? '',
            };
        }

        case 'available_commands_update':
            // The composer's slash menu, not a ledger row.
            return null;

        default:
            return { kind: 'unknown', sessionUpdate: kind, raw: update };
    }
}

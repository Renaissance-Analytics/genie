import { backgroundTasksOf, taskEventOf, type BackgroundTask, type TaskEvent } from './background-tasks.js';
import { RATE_LIMIT_META, headroomFromMeta, type Headroom } from './headroom.js';
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
    | { kind: 'message'; speaker: 'agent' | 'you' | 'peer'; peerName: string | null; text: string; attachments?: readonly string[] }
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
          /**
           * The PROVIDER's estimate of this thought's tokens — prism-acp's
           * `_meta["particle.academy/thinking_tokens_estimate"]`, kept out of `usage_update` because it is an
           * estimate. Shown as `~842 tok`; `null` (or absent, in older threads) when the provider gave none.
           */
          estimate?: number | null;
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
          /**
           * ACP's tool category, and **`null` is not `'other'`**.
           *
           * `prism-acp` OMITS `kind` when its table does not recognise the tool, and `other`
           * is a value that same table emits on purpose. The two are different claims:
           * `other` is "we know what this is and it fits no category", `null` is "we do not
           * know what this is". Collapsing them would file every MCP tool and every future
           * provider tool under a category the provider never claimed.
           *
           * This is what the Stream reads to know a call is an EDIT — the one row type that
           * gets tinted, anchors the diff inspector and carries line counts. Deriving it from
           * the tool's NAME here would be Genie second-guessing a mapping the provider layer
           * already did, with a table of fifteen names to maintain in a second place.
           */
          toolKind: ToolKind | null;
          rawInput: unknown;
      }
    | {
          kind: 'usage';
          used: number;
          size: number;
          /**
           * The session's RUNNING total as the provider reports it (ACP's `usage_update.cost`; Claude's
           * `total_cost_usd`, cumulative over the session). `null` = not reported — codex reports none.
           */
          cost: number | null;
          /** What THIS turn cost: the rise from the previous report (`resolveTurnCosts`); absent until resolved. */
          turnCost?: number | null;
          /** The provider's RUNNING input / output totals (codex's `_meta.inputTokens` / `outputTokens`); `null` = not sent. */
          inTokens?: number | null;
          outTokens?: number | null;
          /** THIS turn's input / output: the rise from the previous report (`resolveTurnCosts`). */
          turnIn?: number | null;
          turnOut?: number | null;
      }
    | { kind: 'plan'; entries: readonly unknown[] }
    | { kind: 'divider'; variant: 'compaction'; before: number | null; after: number | null }
    /**
     * WHERE THIS RUN BEGINS, between an agent's recorded history and its live rows (the host places it; it is not
     * recorded). `resumed`: the provider was asked to continue its conversation, which it remembers in full —
     * including anything from before Genie recorded it.
     */
    | { kind: 'run'; resumed: boolean }
    /** The ledger's history was cut to its most recent rows: `count` earlier recorded rows are not shown. */
    | { kind: 'earlier'; count: number }
    /**
     * A TURN STARTED — written by the session when a prompt goes in, not read off the wire (ACP reports turn ENDS,
     * and nothing a surface holds says where one began). `by` is whoever started it when the caller said so
     * (`you`, `genie`, a peer's name) and `null` when nobody reported who — never guessed to be "you".
     */
    | { kind: 'turn'; n: number; by: string | null }
    /**
     * A TURN WAS STOPPED — written by the session when the provider ends a turn `cancelled` (ACP's stop reason), not read
     * off the wire as a row. `n` is the turn that stopped; `by` is who asked for the stop (`you` from the composer's
     * `Stop this turn`) and `null` when nobody here asked — never guessed to be "you".
     */
    | { kind: 'stopped'; n: number; by: string | null }
    | {
          kind: 'notice';
          level: string;
          message: string;
          /** The provider's rate-limit headroom when the notice carried it (`core/headroom.ts`); `null` otherwise. */
          headroom?: Headroom | null;
          /** A thinking-token ESTIMATE riding the notice (Claude's `system/thinking_tokens` frame); it belongs to its thought. */
          estimate?: number | null;
          /** The model IN USE when the notice reported one (`MODEL_META`); `null` when it did not say. */
          model?: string | null;
          /** Claude's FULL live set of background tasks (`core/background-tasks.ts`); absent when the notice is not one. */
          tasks?: BackgroundTask[];
          /** One background task's event — started, updated, ended; absent when the notice is not one. */
          task?: TaskEvent;
      }
    /**
     * A DECISION on a permission request — minted by the session when the human answers (or the session stops with
     * one parked), never read off the wire. The request itself is state (the parked card) until then; the decision
     * is history, and the chips row's Approvals count it. `optionId` is the provider's own, verbatim.
     */
    | { kind: 'approval'; question: string; tool: string | null; outcome: 'allowed' | 'denied' | 'answered' | 'cancelled'; optionId: string | null }
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

/**
 * ACP's tool categories, as `prism-acp`'s own table emits them.
 *
 * Validated rather than passed through: a value outside this list would reach the UI and
 * select no icon, no tint and no inspector, which renders as a row that exists and does
 * nothing. `null` is the honest reading of a kind we cannot interpret.
 */
export type ToolKind = 'read' | 'edit' | 'execute' | 'search' | 'fetch' | 'think' | 'other';

const TOOL_KINDS: readonly string[] = ['read', 'edit', 'execute', 'search', 'fetch', 'think', 'other'];

function toolKindOf(value: unknown): ToolKind | null {
    return typeof value === 'string' && TOOL_KINDS.includes(value) ? (value as ToolKind) : null;
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
/** prism-acp's thinking-token ESTIMATE on a thought chunk, or `null` when the provider sent none. */
/**
 * Where prism-acp (0.8.0+) puts the model IN USE on a `notice` (its exported `META_MODEL`, spelled here as
 * RATE_LIMIT_META is, so this module needs nothing at runtime from the driver package). Claude says it on its first
 * init notice; Codex after thread start or resume and on `model/rerouted`. No key = the provider did not say.
 */
export const MODEL_META = 'particle.academy/model';

function thinkingEstimateOf(update: Record<string, unknown>): number | null {
    const meta = update['_meta'];
    if (!isRecord(meta)) return null;
    const n = meta['particle.academy/thinking_tokens_estimate'];
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}

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
            return { kind: 'think', text: textOf(update), tokens: null, estimate: thinkingEstimateOf(update) };

        case 'tool_call':
        case 'tool_call_update':
            return {
                kind: 'tool',
                toolCallId: stringOrNull(update['toolCallId']) ?? '',
                name: stringOrNull(update['name']),
                title: stringOrNull(update['title']),
                status: toolStatusOf(update['status']),
                toolKind: toolKindOf(update['kind']),
                rawInput: update['rawInput'] ?? null,
            };

        case 'usage_update': {
            const cost = update['cost'];
            return {
                kind: 'usage',
                used: numberOrNull(update['used']) ?? 0,
                size: numberOrNull(update['size']) ?? 0,
                cost: isRecord(cost) ? numberOrNull(cost['amount']) : null,
                inTokens: isRecord(update['_meta']) ? numberOrNull(update['_meta']['inputTokens']) : null,
                outTokens: isRecord(update['_meta']) ? numberOrNull(update['_meta']['outputTokens']) : null,
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
            const tasks = backgroundTasksOf(update['_meta']);
            const task = taskEventOf(update['_meta']);
            return {
                kind: 'notice',
                level: stringOrNull(notice['level']) ?? 'info',
                message: stringOrNull(notice['message']) ?? '',
                headroom: isRecord(update['_meta']) ? headroomFromMeta(update['_meta'][RATE_LIMIT_META]) : null,
                model: isRecord(update['_meta']) ? stringOrNull(update['_meta'][MODEL_META]) : null,
                estimate: thinkingEstimateOf(update),
                ...(tasks ? { tasks } : {}),
                ...(task ? { task } : {}),
            };
        }

        case 'available_commands_update':
            // The composer's slash menu, not a ledger row.
            return null;

        default:
            return { kind: 'unknown', sessionUpdate: kind, raw: update };
    }
}

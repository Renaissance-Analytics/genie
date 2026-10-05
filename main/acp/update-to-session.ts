/**
 * ACP `session/update` → `AgentSession`.
 *
 * The translation layer, and the one thing it must not do is lose a variant quietly.
 * The protocol gains them between versions, and a mapper with a `default: break`
 * absorbs a new one so the surface simply stops showing something nobody remembers it
 * had — a cost figure, a plan, a tool call. So {@link HANDLED_UPDATE_KINDS} is
 * exhaustive and a test compares it against the SDK's own shipped schema in both
 * directions.
 *
 * Pure. The client does the I/O; this decides what an update MEANS.
 *
 * ## Handled is not the same as stored
 *
 * Several kinds are acknowledged and deliberately change nothing, because
 * `AgentSession` has no field for them yet: a notice, a subagent's progress, a config
 * option, a session title. Listing them explicitly is what keeps the schema guard
 * honest — the alternative is a silent fallthrough that would also swallow a variant
 * we DO care about.
 *
 * The notable one is `agent_thought_chunk`. It moves the turn state and nothing else:
 * appending reasoning to `live` would splice the agent's private thinking into what it
 * actually said.
 */

import type { AgentSession, Message, PlanEntry, SlashCommand, ToolCall } from '../agentsession/model';

/** Every `sessionUpdate` discriminant in the ACP stable schema. Compared against the
 *  shipped `schema.json` in both directions by the tests. */
export const HANDLED_UPDATE_KINDS = [
    'user_message_chunk',
    'agent_message_chunk',
    'agent_thought_chunk',
    'tool_call',
    'tool_call_update',
    'plan',
    'plan_update',
    'plan_removed',
    'available_commands_update',
    'current_mode_update',
    'config_option_update',
    'session_info_update',
    'usage_update',
    'notice',
    'compaction_update',
    'compaction_summary_chunk',
    'subagent_update',
    'session_message',
    'session_message_chunk',
] as const;

export type HandledUpdateKind = (typeof HANDLED_UPDATE_KINDS)[number];

/** The shape this reads off an update. Structural on purpose: the SDK's generated
 *  types are a union of nineteen branches and narrowing them here would couple the
 *  mapping to their internal naming rather than to the wire. */
export interface AcpSessionUpdate {
    sessionUpdate: string;
    /** A ContentBlock. Only `text` carries text; the other kinds (`image`, `audio`,
     *  `resource_link`, `resource`) carry their own fields, which is why this permits
     *  them rather than rejecting a payload the protocol really sends. */
    content?: { type: string; text?: string; [extra: string]: unknown };
    messageId?: string;
    toolCallId?: string;
    title?: string;
    name?: string;
    status?: string;
    /** PlanEntry also carries `priority`, which the model has no field for — accepted
     *  and ignored rather than making a real payload fail to type. */
    entries?: Array<{ content?: string; status?: string; [extra: string]: unknown }>;
    availableCommands?: Array<{ name?: string; description?: string; [extra: string]: unknown }>;
    used?: number;
    size?: number;
    cost?: number;
}

/** Only a text block carries text. An image or an embedded resource has none, and
 *  inventing `[image]` would put words in the agent's mouth. */
function textOf(content: AcpSessionUpdate['content']): string | null {
    if (!content || content.type !== 'text') return null;
    return typeof content.text === 'string' ? content.text : null;
}

/** ACP has four tool statuses; the model has three. `in_progress` is still pending
 *  from a reader's point of view — the thing has not finished. */
function toolStatus(status: string | undefined): ToolCall['status'] {
    if (status === 'completed') return 'success';
    if (status === 'failed') return 'failure';
    return 'pending';
}

function planStatus(status: string | undefined): PlanEntry['status'] {
    if (status === 'completed') return 'done';
    if (status === 'in_progress') return 'in-progress';
    return 'pending';
}

/**
 * Fold one update into the session.
 *
 * Returns a NEW session; never mutates. A surface re-rendering from a mutated object
 * is the class of bug where the screen is correct only after the next unrelated
 * update.
 */
export function applySessionUpdate(s: AgentSession, u: AcpSessionUpdate, now: number): AgentSession {
    switch (u.sessionUpdate as HandledUpdateKind) {
        case 'agent_message_chunk':
        case 'session_message_chunk':
        case 'session_message': {
            const chunk = textOf(u.content);
            if (chunk === null) return s;
            const id = u.messageId ?? 'live';
            // A DIFFERENT id means the previous message is finished. Committing it is
            // the real streaming semantic — overwriting instead would drop a reply
            // mid-turn with nothing reporting it.
            if (s.live && s.live.id !== id) {
                return {
                    ...s,
                    transcript: [...s.transcript, s.live],
                    live: { id, role: 'agent', author: null, content: chunk },
                    turn: { state: 'thinking', since: now },
                };
            }
            const live: Message = s.live
                ? { ...s.live, content: s.live.content + chunk }
                : { id, role: 'agent', author: null, content: chunk };
            return { ...s, live, turn: { state: 'thinking', since: now } };
        }

        case 'user_message_chunk': {
            const chunk = textOf(u.content);
            if (chunk === null) return s;
            // Already committed: the human sent it.
            const id = u.messageId ?? `user-${s.transcript.length}`;
            const last = s.transcript[s.transcript.length - 1];
            if (last && last.id === id && last.role === 'user') {
                return {
                    ...s,
                    transcript: [...s.transcript.slice(0, -1), { ...last, content: last.content + chunk }],
                };
            }
            return { ...s, transcript: [...s.transcript, { id, role: 'user', author: null, content: chunk }] };
        }

        case 'agent_thought_chunk':
            // Handled, not stored. The model has no field for reasoning, and appending
            // it to `live` would splice private thinking into the visible reply.
            return { ...s, turn: { state: 'thinking', since: now } };

        case 'tool_call': {
            if (!u.toolCallId) return s;
            const call: ToolCall = {
                id: u.toolCallId,
                name: u.title ?? u.name ?? u.toolCallId,
                status: toolStatus(u.status),
            };
            return {
                ...s,
                tools: [...s.tools, call],
                // Distinct from 'thinking' for the reason the protocol separates them: a
                // build or a test suite can run silently for minutes.
                turn: { state: 'tool', since: now },
            };
        }

        case 'tool_call_update': {
            if (!u.toolCallId) return s;
            const index = s.tools.findIndex((t) => t.id === u.toolCallId);
            // An update for a call we never saw is ignored rather than invented. A
            // phantom row with no name is worse than a missing one.
            if (index === -1) return s;
            const existing = s.tools[index]!;
            const next: ToolCall = {
                ...existing,
                // Keep the title when the update omits one.
                name: u.title ?? u.name ?? existing.name,
                status: u.status === undefined ? existing.status : toolStatus(u.status),
            };
            const tools = [...s.tools];
            tools[index] = next;
            return { ...s, tools };
        }

        case 'plan':
        case 'plan_update': {
            const entries = u.entries ?? [];
            const plan: PlanEntry[] = entries.map((e, i) => ({
                id: `plan-${i}`,
                title: e.content ?? '',
                status: planStatus(e.status),
            }));
            return { ...s, plan };
        }

        case 'plan_removed':
            // EMPTY, not unseen. `[]` means the agent said it has no plan; `null` would
            // mean Genie cannot see one, and the surface renders those differently.
            return { ...s, plan: [] };

        case 'usage_update':
            return {
                ...s,
                usage: {
                    contextUsed: u.used ?? null,
                    contextMax: u.size ?? null,
                    // Null, not zero: an agent reporting context but not price is common,
                    // and zero would be a claim about money.
                    costUsd: u.cost ?? null,
                },
            };

        case 'available_commands_update': {
            const commands: SlashCommand[] = (u.availableCommands ?? []).map((c) => ({
                name: c.name ?? '',
                hint: c.description ?? null,
            }));
            return { ...s, commands };
        }

        case 'current_mode_update':
        case 'config_option_update':
        case 'session_info_update':
        case 'notice':
        case 'compaction_update':
        case 'compaction_summary_chunk':
        case 'subagent_update':
            // Acknowledged, and deliberately unstored — the model has no field for any
            // of these yet. Named individually so the schema guard stays honest: a
            // `default:` here would also swallow a variant we DO care about.
            return s;
    }
}

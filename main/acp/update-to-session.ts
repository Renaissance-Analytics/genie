import {
    META_CLI_SESSION_ID,
    META_RATE_LIMIT,
    META_UNMAPPED_FRAME,
    readRateLimit,
} from '@particle-academy/prism-acp';
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

import { applyPlanTool, isUnrecognisedPlanTool } from './plan-synthesis';
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
    /** A tool call's arguments, straight off the wire. Untrusted. */
    rawInput?: unknown;
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
 * The id a streaming message wears when the agent sent none — ACP's `messageId` is optional and
 * claude does not always send one.
 *
 * A PLACEHOLDER, not an identity, and exported so nothing has to re-guess the literal. It is only
 * ever correct for the ONE message currently streaming: committing it verbatim at every turn
 * boundary produces two transcript entries with the same id, and `AgentView` uses the id as its
 * React key. `DeclaredSessionStore.endTurn` renames it on commit, where the message is finished and
 * a fresh id is free — the mapper cannot, because minting a stable one needs state it does not have.
 */
export const LIVE_MESSAGE_ID = 'live';

/**
 * Fold one update into the session.
 *
 * Returns a NEW session; never mutates. A surface re-rendering from a mutated object
 * is the class of bug where the screen is correct only after the next unrelated
 * update.
 */
export function applySessionUpdate(s: AgentSession, u: AcpSessionUpdate, now: number): AgentSession {
    /**
     * THE CLI'S SESSION ID — captured from whichever update carries it first.
     *
     * ACP's `session/new` returns an id prism-acp MINTS; the provider's real id is a
     * different string, and `session/load` needs THAT one. Before prism-acp 0.3.0 it was
     * recorded as unmapped and reached nobody, which is why resume was unreachable from a
     * client at all.
     *
     * Taken before the kind switch because it rides on the FIRST update of a session,
     * whatever kind that happens to be — keying off `agent_message_chunk` would miss a
     * session whose first update was a tool call.
     *
     * Never overwritten by a later update that omits it: every subsequent chunk arrives with
     * no `_meta`, and clearing the id would lose resume one message after gaining it.
     *
     * Validated rather than trusted. `_meta` is `unknown` on the wire, and a number or an
     * empty string passed to `session/load` fails ONE TURN LATE — after the load reported
     * success — which is the shape prism-acp measured on claude 2.1.292 and the reason
     * Genie's old "a wrong resume starts fresh" doctrine is wrong for this CLI.
     */
    const metaCliId = (u as { _meta?: Record<string, unknown> })._meta?.[META_CLI_SESSION_ID];
    if (typeof metaCliId === 'string' && metaCliId.trim() !== '' && !s.session.sessionId) {
        s = { ...s, session: { ...s.session, sessionId: metaCliId } };
    }

    switch (u.sessionUpdate as HandledUpdateKind) {
        case 'agent_message_chunk':
        case 'session_message_chunk':
        case 'session_message': {
            const chunk = textOf(u.content);
            if (chunk === null) return s;
            const id = u.messageId ?? LIVE_MESSAGE_ID;
            // A DIFFERENT id means the previous message is finished. Committing it is
            // the real streaming semantic — overwriting instead would drop a reply
            // mid-turn with nothing reporting it.
            if (s.live && s.live.id !== id) {
                return {
                    ...s,
                    transcript: [...s.transcript, s.live],
                    live: { id, role: 'agent', author: null, content: chunk, at: now },
                    turn: { state: 'thinking', since: now },
                };
            }
            // `at` is stamped when the message STARTS and carried through every chunk, so a
            // long reply is ordered by when the agent began speaking rather than by when it
            // stopped. `mergeDeclared` interleaves on it — see `Message.at`.
            const live: Message = s.live
                ? { ...s.live, content: s.live.content + chunk }
                : { id, role: 'agent', author: null, content: chunk, at: now };
            return { ...s, live, turn: { state: 'thinking', since: now } };
        }

        case 'user_message_chunk': {
            const chunk = textOf(u.content);
            if (chunk === null) return s;
            // Already committed: the human sent it.
            const id = u.messageId ?? `user-${s.transcript.length}`;
            const last = s.transcript[s.transcript.length - 1];
            // AN ID is the agent saying these belong together, and the only case where
            // concatenation is a fact rather than a guess.
            if (u.messageId && last && last.id === u.messageId && last.role === 'user') {
                return {
                    ...s,
                    transcript: [...s.transcript.slice(0, -1), { ...last, content: last.content + chunk }],
                };
            }
            /**
             * AN UN-IDED REPEAT OF THE TAIL IS A DUPLICATE, not a new message.
             *
             * ## Why, after the loud reason stopped being true
             *
             * Measured against a real codex child on prism-acp 0.5.2, this fired twice —
             * **two identical frames, each carrying the FULL text, with no `messageId`.** That turned
             * out to be prism's own defect, not codex's: `#mapItem` runs at both `item/started` and
             * `item/completed`, and the `userMessage` branch was missing the `if (replay || completed)`
             * guard its sibling branches have. Fixed in 0.5.3 and re-measured here — `prompt echoes=1`.
             *
             * So this guard is NOT here for that, and saying so matters: a rule justified by a defect
             * somebody else has fixed is a rule nobody can evaluate.
             *
             * It is here for the smaller and permanent reason. codex genuinely reports the user's turn
             * as `user_message_chunk`, and Genie genuinely records the owner's prompt itself
             * (`recordHumanPromptForSpec`) because claude never echoes and never replays one. One
             * honest echo plus one honest record is still **two renderings of one message**, and that
             * does not go away with any amount of fixing on either side.
             *
             * Keyed on the TEXT rather than the id, because that is the pair that collides: Genie's
             * record carries a `human:` id an echo cannot match by construction. Worth keeping for its
             * own sake — `user-${transcript.length}` GROWS as messages are appended, so an id built
             * that way can never match what was just appended and was guaranteed never to coalesce.
             *
             * Dropping is the lesser error, and the judgement is worth stating rather than leaving as
             * a silent heuristic. For an un-ided chunk there is NO information distinguishing "that
             * message again" from "the owner typed the same word twice". A duplicated message reads as
             * a bug in Genie; a collapsed exact repeat reads as the owner having typed once.
             */
            if (!u.messageId && last && last.role === 'user' && last.content === chunk) return s;
            return {
                ...s,
                transcript: [...s.transcript, { id, role: 'user', author: null, content: chunk, at: now }],
            };
        }

        case 'agent_thought_chunk':
            // Handled, not stored. The model has no field for reasoning, and appending
            // it to `live` would splice private thinking into the visible reply.
            return { ...s, turn: { state: 'thinking', since: now } };

        case 'tool_call': {
            if (!u.toolCallId) return s;
            // The RAW name decides plan-ness. `title` is a DISPLAY string and may be
            // humanised or localised; matching on it would be matching on prose.
            const rawName = u.name ?? '';
            const synthesised = applyPlanTool(s.plan ?? [], { name: rawName, input: u.rawInput });
            if (synthesised) {
                // SUPPRESSED as a tool call and surfaced as the plan instead. The adapter
                // did exactly this; emitting both shows the plan twice -- once as the rail
                // and once as tool rows -- which reads as a rendering bug in Genie.
                return { ...s, plan: synthesised, turn: { state: 'tool', since: now } };
            }
            if (isUnrecognisedPlanTool(rawName)) {
                // THE CANARY FIRING. A plan-shaped tool we do not know -- i.e. the rename
                // happened again. Say so loudly: the alternative is the plan rail quietly
                // going dark, which is the specific risk accepted when choosing synthesis.
                // Worded to blame Genie, not the agent, and never overwrites a real error.
                return {
                    ...s,
                    error:
                        s.error ??
                        `Genie does not recognise the plan tool "${rawName}", so the plan rail may be incomplete. Its name has probably changed.`,
                    tools: [...s.tools, { id: u.toolCallId, name: u.title ?? rawName ?? u.toolCallId, status: toolStatus(u.status) }],
                    turn: { state: 'tool', since: now },
                };
            }
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
        case 'notice': {
            /**
             * A NOTICE CARRIES THE RATE-LIMIT READING, and this used to throw it away.
             *
             * The old comment was honest — *"the model has no field for any of these yet"* —
             * and the cost was that the one thing the owner asked to see arrived on every
             * turn and was discarded.
             *
             * BOTH `_meta` keys are read. Prism refuses an unrecognised payload totally and
             * routes the frame to `unmapped_frame` with a reason naming the field that
             * failed; reading only `rate_limit` would leave "no gauge and no explanation",
             * which is their warning and would have been my bug.
             */
            const meta = (u as { _meta?: Record<string, unknown> })._meta ?? {};
            const noticeText =
                (u as { notice?: { message?: string } }).notice?.message ?? null;

            if (meta[META_RATE_LIMIT] !== undefined) {
                const read = readRateLimit(meta[META_RATE_LIMIT]);
                if (read.ok) {
                    // The sentence is OURS to carry and display only — Prism changed it once
                    // already and says it is deliberately unstable.
                    return { ...s, rateLimit: { ...read.limit, notice: noticeText }, rateLimitUnavailable: null };
                }
                return { ...s, rateLimit: null, rateLimitUnavailable: read.reason };
            }

            const unmapped = meta[META_UNMAPPED_FRAME] as { reason?: string } | undefined;
            // `unmapped_frame` is a GENERAL channel: any frame with no mapping lands there.
            // Reporting "no gauge because <unrelated frame>" would be a false explanation, so
            // only a rate-limit refusal is taken.
            if (unmapped?.reason?.startsWith('rate_limit')) {
                return { ...s, rateLimit: null, rateLimitUnavailable: unmapped.reason };
            }
            return s;
        }

        case 'compaction_update':
        case 'compaction_summary_chunk':
        case 'subagent_update':
            // Acknowledged, and deliberately unstored — the model has no field for any
            // of these yet. Named individually so the schema guard stays honest: a
            // `default:` here would also swallow a variant we DO care about.
            return s;
    }
}

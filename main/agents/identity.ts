/**
 * PURE. An agent's IDENTITY, and the two forms it takes (Tynn #254).
 *
 * An agent used to be three loose fields — `agentType`, `whisper_purpose`,
 * `chat_session_id` — plus a display string (`"claude · tynn"`) assembled at each
 * call site. Nothing composed them, so nothing could be addressed: an agent was
 * discoverable by a uuid nobody could type and describable by a label nobody
 * could parse. This module makes the composed form canonical.
 *
 * TWO FORMS, and keeping them apart is the whole point:
 *
 *   machine-facing   `claude:tynn:{chat-id}`   — AgentInbox routing, the
 *                                                workspace registry, tool args
 *   human-facing     `[logo] tynn`             — the rail, panel headers, the
 *                                                inbox list
 *
 * The chat-id is ADDRESSING, not identity. It belongs in the wire format and
 * nowhere a person reads, which is why {@link agentDisplay} cannot return one —
 * a surface that wants to show it has to go and fetch it deliberately.
 *
 * The SAVED-CONFIG KEY is deliberately the chat-id-free prefix
 * ({@link savedAgentKey}). Codex cannot know its session id until its harness is
 * running, so a saved agent identified by the full triple could never be
 * resolved before spawning — which is exactly when it has to be resolved. The
 * chat-id is bound DURING startup (see `agentinbox/session-registration.ts`),
 * onto a record that already exists.
 */

import type { AgentType } from '../mcp/protocol';
import { normalizePurpose } from '../agentinbox/types';

/** The AI TUI an agent runs. Mirrors `AgentType` / `AgentInboxAgentType`. */
export type AgentProvider = AgentType;

/** The parts of an agent's identity, as every surface needs them. */
export interface AgentIdentity {
    provider: AgentProvider;
    /** The saved agent's NAME — stable, human-chosen, kebab. */
    name: string;
    /** The harness's chat session, when it is known yet. Null before Codex's
     *  SessionStart fires, and for any agent whose capture never resolved. */
    chatSessionId?: string | null;
}

/** The separator between an agent ref's parts. */
const SEP = ':';

/**
 * An agent's NAME, normalised.
 *
 * The same normaliser the AgentInbox purpose already uses, because they are the
 * same field: a saved agent's name IS its channel purpose, stored in
 * `terminal_specs.meta.whisper_purpose`. Introducing a second name with its own
 * rules would give one agent two names that drift — and the ref would then say
 * something the inbox disagreed with.
 *
 * An empty name resolves to `general`, which is what an unnamed agent already
 * gets today, so the default is the existing data rather than a new convention.
 */
export function agentName(raw: string | null | undefined): string {
    return normalizePurpose(raw);
}

/**
 * The SAVED-CONFIG key — `{provider}:{name}`, no chat-id.
 *
 * This is what a saved agent is looked up by, and the reason the lookup works
 * for Codex: it is knowable before the harness has run. Two agents may share a
 * name across providers (`claude:tynn` and `codex:tynn` are different agents
 * with different conversations); no two may share this key inside a workspace.
 */
export function savedAgentKey(provider: AgentProvider, name: string): string {
    return `${provider}${SEP}${agentName(name)}`;
}

/**
 * The canonical machine-facing ref — `{provider}:{name}:{chat-id}`.
 *
 * Degrades to the saved-config key when the chat-id is not bound yet, rather
 * than emitting an empty third field: a ref with a blank tail reads as "this
 * agent's chat is called nothing", and Codex spends its entire startup in that
 * state. Absence is the honest answer, and it round-trips through
 * {@link parseAgentRef}.
 */
export function agentRef(identity: AgentIdentity): string {
    const key = savedAgentKey(identity.provider, identity.name);
    const chat = identity.chatSessionId?.trim();
    return chat ? `${key}${SEP}${chat}` : key;
}

/** The providers a ref may name. Anything else is not one of ours. */
const PROVIDERS: readonly string[] = ['claude', 'codex', 'custom'];

export function isAgentProvider(value: unknown): value is AgentProvider {
    return typeof value === 'string' && PROVIDERS.includes(value);
}

/**
 * Parse a ref back into its parts, or null when it is not one.
 *
 * Accepts both forms — with and without a chat-id — because both are legitimate
 * things to be handed: an agent naming a peer it wants to reach knows the
 * `{provider}:{name}` half and often nothing more. The chat-id is taken as the
 * REMAINDER after the second separator, so a harness that ever puts a colon in a
 * session id survives instead of being silently truncated.
 */
export function parseAgentRef(ref: string): AgentIdentity | null {
    const raw = String(ref ?? '').trim();
    if (!raw) return null;
    const first = raw.indexOf(SEP);
    if (first <= 0) return null;
    const provider = raw.slice(0, first);
    if (!isAgentProvider(provider)) return null;
    const rest = raw.slice(first + 1);
    const second = rest.indexOf(SEP);
    const name = second === -1 ? rest : rest.slice(0, second);
    if (!name.trim()) return null;
    const chat = second === -1 ? null : rest.slice(second + 1).trim() || null;
    return { provider, name: agentName(name), chatSessionId: chat };
}

/**
 * What a HUMAN-facing surface renders: the provider (so the right logo is drawn)
 * and the name. Never the chat-id — there is no field for it here, which is what
 * stops one leaking into a header again.
 *
 * `provider` is returned rather than a logo component because this module is
 * pure and main-process; the renderer maps it through its own icon registry
 * (`renderer/lib/terminal-types.ts`). Two agents with the same name on different
 * providers therefore differ by logo alone, as required.
 */
export function agentDisplay(identity: AgentIdentity): {
    provider: AgentProvider;
    name: string;
} {
    return { provider: identity.provider, name: agentName(identity.name) };
}

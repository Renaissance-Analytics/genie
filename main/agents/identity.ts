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
import { isTuiId } from './registry';

/** The AI TUI an agent runs. Mirrors `AgentType` / `AgentInboxAgentType`. */
export type AgentTui = AgentType;

/** The parts of an agent's identity, as every surface needs them. */
export interface AgentIdentity {
    tui: AgentTui;
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
 * The SAVED-CONFIG key — the agent's NAME, and nothing else.
 *
 * This used to be `{tui}:{name}`, which made the TUI part of the agent's
 * IDENTITY. The schema says otherwise: v55 collapsed
 * `UNIQUE (workspace_id, tui, name)` to `UNIQUE (workspace_id, name)` and
 * moved the tui onto `agent_runtimes`, because an agent that switches
 * drivers is the same agent. The key disagreeing with the schema is how
 * `claude:tynn` and `codex:tynn` could still read as two agents.
 *
 * Still knowable before the harness runs, which is what the lookup needs and
 * why the chat-id is not in it: Codex cannot know its session id until it is
 * running, and that is exactly when the agent has to be resolvable.
 */
export function savedAgentKey(name: string): string {
    return agentName(name);
}

/**
 * The canonical machine-facing ref — `{tui}:{name}[:{chat-id}]`.
 *
 * ★ This emitted the NAME alone for a while, and the docblock went on describing
 * the form above. Read the history rather than either half on its own.
 *
 * `ddece5f7` dropped the tui, correctly for the schema at the time: v55 had
 * collapsed identity to `(workspace, name)`. **v60 reversed that a day later** —
 * `idx_workspace_agents_tui_name` is UNIQUE on `(workspace_id, tui, name)`,
 * because `codex:tynn` and `claude:tynn` are two agents (genie#324) — and the
 * ref was not moved back with it.
 *
 * What that cost is genie#388. A ref is an ADDRESS: `list` prints it and `send`
 * takes it, through `agentinbox/address.ts`, which recognises a tag by its
 * leading TUI. Emitting a bare name made every published ref unparseable there,
 * so `send` refused the exact string `list` had just handed over — while the
 * same tool's other error listed that string as reachable, because that list is
 * built from the published refs. Three agents hit it independently and each
 * fell back to the raw uuid.
 *
 * The SAVED-CONFIG KEY stays the name alone ({@link savedAgentKey}) and that is
 * not an inconsistency: it has to resolve BEFORE a harness runs, and a saved
 * agent is the same saved agent under either driver. Identity, addressing and
 * saved configuration are three questions; only the first two include the tui.
 *
 * Degrades to `{tui}:{name}` when the chat-id is not bound yet, rather than
 * emitting an empty third field: a ref with a blank tail reads as "this agent's
 * chat is called nothing", and Codex spends its entire startup in that state.
 * Degrades further to the bare name when the TUI is unknown — `parseAgentRef`
 * returns no tui for a legacy bare ref, and that value round-trips back through
 * here, where `undefined:tynn` would name a driver called "undefined".
 */
export function agentRef(identity: AgentIdentity): string {
    const name = savedAgentKey(identity.name);
    const tui = typeof identity.tui === 'string' && identity.tui.trim() ? identity.tui.trim() : '';
    const head = tui ? `${tui}${SEP}${name}` : name;
    const chat = identity.chatSessionId?.trim();
    return chat ? `${head}${SEP}${chat}` : head;
}

/**
 * The TUIs a ref may name. Anything else is not one of ours.
 *
 * DERIVED from `TUI_REGISTRY` (genie#261). This used to be its own
 * `readonly string[]` — deliberately outside the union, so no compiler checked
 * it — and a tui missing from it was silently dropped by `savedAgentsOf`:
 * the agent launched, ran, and never appeared in the roster, with no error
 * anywhere. Membership is now the registry's answer, by construction.
 */
export function isAgentTui(value: unknown): value is AgentTui {
    return isTuiId(value);
}

/**
 * Parse a ref back into its parts, or null when it is not one.
 *
 * Accepts both forms — with and without a chat-id — because both are legitimate
 * things to be handed: an agent naming a peer it wants to reach knows the
 * `{tui}:{name}` half and often nothing more. The chat-id is taken as the
 * REMAINDER after the second separator, so a harness that ever puts a colon in a
 * session id survives instead of being silently truncated.
 */
export function parseAgentRef(ref: string): AgentIdentity | null {
    const raw = String(ref ?? '').trim();
    if (!raw) return null;

    const parts = raw.split(SEP).map((part) => part.trim());

    // LEGACY `{tui}:{name}[:{chat}]`. Agents were told this shape and may
    // still have one written down, so reading it keeps working -- but only when
    // there is something AFTER the tui. A bare `codex` is an agent NAMED
    // codex, which is legal, and reading it as a tui with no name would
    // turn a valid ref into null.
    if (parts.length >= 2 && isAgentTui(parts[0]!)) {
        const name = parts[1]!;
        if (!name) return null;
        return {
            tui: parts[0] as AgentTui,
            name: agentName(name),
            chatSessionId: parts.slice(2).join(SEP).trim() || null,
        };
    }

    const name = parts[0]!;
    if (!name) return null;
    return {
        // The ref no longer carries a driver, because the driver is not the
        // agent. Callers that need one read it off the fronted runtime.
        tui: undefined as unknown as AgentTui,
        name: agentName(name),
        chatSessionId: parts.slice(1).join(SEP).trim() || null,
    };
}

/**
 * What a HUMAN-facing surface renders: the tui (so the right logo is drawn)
 * and the name. Never the chat-id — there is no field for it here, which is what
 * stops one leaking into a header again.
 *
 * `tui` is returned rather than a logo component because this module is
 * pure and main-process; the renderer maps it through its own icon registry
 * (`renderer/lib/terminal-types.ts`). Two agents with the same name on different
 * TUIs therefore differ by logo alone, as required.
 */
export function agentDisplay(identity: AgentIdentity): {
    tui: AgentTui;
    name: string;
} {
    return { tui: identity.tui, name: agentName(identity.name) };
}

/* ── AMS ↔ AgentInbox: one agent, one id ─────────────────────────────────── */

/**
 * AMS and AgentInbox each invented an identity for the same agent:
 *
 *     AgentInbox   `terminal_specs.meta.agent_id`   a uuid  (c024b80b…)
 *     AMS          `workspace_agents.id`            `agent:<terminalSpecId>`
 *
 * Nothing reconciled them, so an agent could be READY in one and INVISIBLE in
 * the other at the same time. Measured on a live workstation: `thumbsUp` set
 * `ready_at` on `agent:f633f4ed…` while `agentinbox list` returned no `self`,
 * because the broker was looking for `c024b80b…`. Both calls returned ok.
 * Neither helped.
 *
 * THE INBOX ID WINS, and the direction is not a preference: that id already keys
 * durable messages, read receipts and peer addressing, so renaming it would break
 * message history and every saved reference. The AMS row is the newer record and
 * nothing outside AMS points at its id yet, so it is the one that moves.
 */
export interface AgentIdentityInputs {
    /** `terminal_specs.meta.agent_id` of the bound terminal, when there is one. */
    inboxAgentId: string | null | undefined;
    /** The current `workspace_agents.id`. */
    amsId: string;
}

/** PURE. The id BOTH systems should use for this agent. */
export function unifiedAgentId(input: AgentIdentityInputs): string {
    const inbox = String(input.inboxAgentId ?? '').trim();
    // A registered agent that has never been started has no terminal and so no
    // inbox identity. Minting one here would invent an id nothing has agreed to;
    // the AMS id is already durable in its own table, so it stands.
    return inbox.length > 0 ? inbox : input.amsId;
}

/**
 * PURE. Should this row's id be rewritten?
 *
 * False when they already agree, so the migration is safe to re-run and a no-op
 * launch does not churn `updated_at` — a row rewritten to itself makes every
 * start look like a change.
 *
 * False for a workspace-level row (`workspace:<id>`), which is not terminal-backed
 * and has no inbox identity to adopt. Those ids are pointed at by
 * `parent_agent_id` and must not move.
 */
export function needsIdentityRewrite(input: AgentIdentityInputs): boolean {
    return unifiedAgentId(input) !== input.amsId;
}

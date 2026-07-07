/**
 * Shared WhisperChat data types — the wire shapes crossing the main↔renderer IPC
 * boundary AND the in-memory broker's records. Pure (no electron / no I/O) so the
 * broker + MCP protocol can import them freely and the whole surface stays
 * unit-testable.
 *
 * WhisperChat is the LOCAL inter-agent messaging network: agents in this Genie
 * instance discover peers (subject to an accessibility SCOPE), DM each other, and
 * broadcast on per-workspace CHANNELS; a human panel watches + joins. Everything
 * is in-memory in the main process (the durable identity rides
 * `terminal_specs.meta`), local-only — no relay, no cross-host.
 */

/** Who can see / DM an agent. `self` (default) = its own workspace only. */
export type WhisperScope = 'none' | 'self' | 'specific' | 'all';

/** Liveness of an agent's terminal. `away` = pty exited but the spec is retained
 *  (revivable); `offline` = the terminal was killed / the spec removed. */
export type WhisperStatus = 'online' | 'away' | 'offline';

/** The AI TUI an agent terminal runs. Mirrors `AgentType` (mcp/protocol). */
export type WhisperAgentType = 'claude' | 'codex' | 'custom';

/** A message's kind — a 1:1 direct message or a channel broadcast. */
export type WhisperKind = 'dm' | 'channel';

/** The human panel's sender identity token. An agent sender is its `agentId`. */
export const WHISPER_HUMAN = 'human';

/** A discoverable agent as the directory / presence surfaces report it. */
export interface WhisperAgentInfo {
    /** Stable whisper identity (uuid), persisted in the spec's `meta.agent_id`. */
    agentId: string;
    /** The owning terminal spec id. */
    terminalId: string;
    workspaceId: string;
    workspaceName: string;
    /** Display slug for the workspace (Tynn slug → envelope slug → kebab name). */
    slug: string;
    agentType: WhisperAgentType;
    /** The terminal's label. */
    label: string;
    /** The agent's channel purpose (kebab), e.g. `general`, `frontend`. */
    purpose: string;
    scope: WhisperScope;
    /** Workspace ids this agent is visible to when `scope: 'specific'`. */
    scopeWorkspaces: string[];
    status: WhisperStatus;
    /** The captured AI chat-session uuid, or null when unknown/uncaptured. */
    chatSessionId: string | null;
}

/**
 * A DM thread (a message-carrying pair) as the human panel's DMs list reports it.
 * Covers BOTH human↔agent AND agent↔agent pairs — the human owns the workstation
 * and sees every thread. Keyed by the order-independent `pairKey`.
 */
export interface WhisperDmThreadInfo {
    /** Order-independent pair key (`idA|idB`, ids sorted). */
    key: string;
    /** The two participant ids (either may be the literal `human`). */
    a: string;
    b: string;
    /** Display label for `a` (`You` for the human; falls back to a logged label
     *  when the agent has already left). */
    aLabel: string;
    /** Display label for `b`. */
    bLabel: string;
    /** True when one participant is the human panel (else it's agent↔agent). */
    withHuman: boolean;
    /** The last message's sender label, short preview, seq, and epoch-ms ts. */
    lastFromLabel: string;
    lastPreview: string;
    lastSeq: number;
    lastTs: number;
    /** Messages in the thread (post-cap). */
    count: number;
}

/** A channel as the channel list reports it. Keyed internally by
 *  `workspaceId:purpose`; displayed as `slug:purpose`. */
export interface WhisperChannelInfo {
    /** Internal key `workspaceId:purpose` (unique; two workspaces can share a slug). */
    key: string;
    /** Display slug for the owning workspace. */
    slug: string;
    purpose: string;
    workspaceId: string;
    workspaceName: string;
    /** Number of agents currently joined. */
    memberCount: number;
}

/** A delivered message — the full record kept in the per-channel / per-DM log and
 *  handed to an agent's `receive`. */
export interface WhisperMessage {
    /** Monotonic global sequence — the cursor an agent pages `receive` with. */
    seq: number;
    /** Stable message uuid. */
    id: string;
    /** Sender: the literal `human`, or an agent's `agentId`. */
    from: string;
    /** Human-readable sender label (`You` for the human; else the agent's label). */
    fromLabel: string;
    kind: WhisperKind;
    /** Channel messages: the channel key. */
    channel?: string;
    /** DM messages: the recipient's `agentId` (or `human`). */
    to?: string;
    text: string;
    /** Epoch ms. */
    ts: number;
    /** DM only: an urgent nudge was requested (glows the recipient's terminal). */
    interrupt?: boolean;
}

/** The `whisper:message` push preview (never the full text stream). */
export interface WhisperMessagePreview {
    kind: WhisperKind;
    /** Channel messages: the channel key. */
    channelKey?: string;
    /** DM messages: the recipient's `agentId`. */
    toAgentId?: string;
    from: string;
    fromLabel: string;
    seq: number;
    ts: number;
    /** A short excerpt of the body (never the full message). */
    preview: string;
}

/** The `whisper:presence` push payload for an agent that LEFT (spec removed). */
export interface WhisperPresenceOffline {
    agentId: string;
    status: 'offline';
    left: true;
}

/**
 * Everything the broker needs to register an agent — resolved by the caller
 * (which owns the db/fs I/O) and handed to the pure broker. `status` defaults to
 * `online`; rehydrate passes `away` (liveness unknown until the agent acts).
 */
export interface WhisperJoinInput {
    agentId: string;
    terminalId: string;
    workspaceId: string;
    workspaceName: string;
    slug: string;
    agentType: WhisperAgentType;
    label: string;
    purpose: string;
    scope: WhisperScope;
    scopeWorkspaces: string[];
    chatSessionId: string | null;
    status?: WhisperStatus;
}

/** The broker's outbound event, mapped by presence.ts to the local broadcast +
 *  mobile push channels (and the terminal attention glow for `interrupt`). */
export type WhisperBrokerEvent =
    | { type: 'presence'; agent: WhisperAgentInfo }
    | { type: 'offline'; agentId: string }
    | { type: 'message'; preview: WhisperMessagePreview }
    | { type: 'interrupt'; terminalId: string };

/** A short preview excerpt for the message push (cap the body). */
export function previewText(text: string, max = 140): string {
    const t = text.replace(/\s+/g, ' ').trim();
    return t.length <= max ? t : t.slice(0, max - 1) + '…';
}

/** Kebab-normalise a channel purpose (≤6 words, a-z0-9 + single dashes). */
export function normalizePurpose(raw: string | undefined | null): string {
    const kebab = String(raw ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    if (!kebab) return 'general';
    return kebab.split('-').filter(Boolean).slice(0, 6).join('-');
}

/**
 * Shared AgentInbox data types — the wire shapes crossing the main↔renderer IPC
 * boundary AND the in-memory broker's records. Pure (no electron / no I/O) so the
 * broker + MCP protocol can import them freely and the whole surface stays
 * unit-testable.
 *
 * AgentInbox is the LOCAL inter-agent messaging network: agents in this Genie
 * instance discover peers (subject to an accessibility SCOPE), DM each other, and
 * broadcast on per-workspace CHANNELS; a human panel watches + joins. Everything
 * is in-memory in the main process (the durable identity rides
 * `terminal_specs.meta`), local-only — no relay, no cross-host.
 */
import type { AgentTuiId } from '../agents/registry';


/**
 * Who can DM an agent — the INNER tier of AgentInbox access control. `self`
 * (default) = its own workspace only.
 *
 * `none` vs `hidden` is the load-bearing distinction: a `none` agent is still
 * LISTED to peers (flagged `reachable: false`) so they can discover it exists and
 * ask for access; a `hidden` agent is omitted from discovery entirely. `hidden`
 * is the true opt-out — `none` only closes the mailbox, not the door.
 *
 * This tier composes with (never overrides) the workspace tier below: a caller
 * must clear BOTH to reach an agent.
 */
export type AgentInboxScope = 'none' | 'self' | 'specific' | 'all' | 'hidden';

/**
 * Who may access a WORKSPACE — the OUTER tier, the front door. Governs whether
 * agents from another workspace may reach into this one at all: join/post to its
 * channels AND discover/DM its agents. Typically ops-only, but configurable.
 *
 * Denial here omits the workspace's agents from discovery entirely — a closed
 * workspace must not advertise its roster or leak topology.
 */
export type WorkspaceAgentAccess = 'none' | 'self' | 'specific' | 'all';

/** A workspace's resolved access policy (the outer tier). */
export interface WorkspaceAccessPolicy {
    access: WorkspaceAgentAccess;
    /** Workspace ids allowed in when `access: 'specific'`. */
    workspaces: string[];
}

/** Liveness of an agent's terminal. `away` = pty exited but the spec is retained
 *  (revivable); `offline` = the terminal was killed / the spec removed. */
export type AgentInboxStatus = 'online' | 'away' | 'offline';

/** The AI TUI an agent terminal runs. Mirrors `AgentType` (mcp/protocol). */
export type AgentInboxAgentType = AgentTuiId;

/** A message's kind — a 1:1 direct message or a channel broadcast. */
export type AgentInboxKind = 'dm' | 'channel';

/** The human panel's sender identity token. An agent sender is its `agentId`. */
export const AGENTINBOX_HUMAN = 'human';

/**
 * Where a just-delivered message landed — passed to the broker's server-push
 * sink so the host can route an MCP `notifications/message` to the recipient's
 * GET SSE stream (per-agent via its terminal, falling back to the whole
 * workspace). Carries all three ids so the host can pick the routing it supports.
 */
export interface AgentInboxNotifyTarget {
    workspaceId: string;
    terminalId: string;
    agentId: string;
}

/** A discoverable agent as the directory / presence surfaces report it. */
export interface AgentInboxAgentInfo {
    /** Stable AgentInbox identity (uuid), persisted in the spec's `meta.agent_id`. */
    agentId: string;
    /** The owning terminal spec id. */
    terminalId: string;
    workspaceId: string;
    workspaceName: string;
    /** Display slug for the workspace (Tynn slug → envelope slug → kebab name). */
    slug: string;
    agentType: AgentInboxAgentType;
    /** The terminal's label. */
    label: string;
    /** The agent's channel purpose (kebab), e.g. `general`, `frontend`. */
    purpose: string;
    scope: AgentInboxScope;
    /** Workspace ids this agent is visible to when `scope: 'specific'`. REDACTED
     *  (empty) for a caller that can't reach this agent — don't leak the ACL to
     *  agents it excludes. The human panel always receives the real list. */
    scopeWorkspaces: string[];
    /** Whether the CALLER this entry was built for may actually DM this agent —
     *  i.e. it cleared both the workspace tier and this agent's scope. A listed
     *  entry with `reachable: false` is the "visible but unavailable" state:
     *  discoverable so peers know to request access, but not messageable.
     *  Always true for the human panel's directory and for an agent's own `self`. */
    reachable: boolean;
    status: AgentInboxStatus;
    /** The captured AI chat-session uuid, or null when unknown/uncaptured. */
    chatSessionId: string | null;
    /**
     * The CANONICAL machine-facing identity — `{provider}:{name}:{chat-id}`, or
     * `{provider}:{name}` while the chat-id is not bound yet (Tynn #254).
     *
     * This is what an agent reads to know WHO a peer is. `agentId` remains the
     * ADDRESS the broker routes on (a uuid, stable across a rename); the ref is
     * the identity a person or an agent can actually say out loud. Human-facing
     * surfaces render `agentType` as a LOGO plus `purpose` and never this — the
     * chat-id belongs in the wire format and nowhere a person reads.
     */
    ref: string;
}

/**
 * A DM thread (a message-carrying pair) as the human panel's DMs list reports it.
 * Covers BOTH human↔agent AND agent↔agent pairs — the human owns the workstation
 * and sees every thread. Keyed by the order-independent `pairKey`.
 */
export interface AgentInboxDmThreadInfo {
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
export interface AgentInboxChannelInfo {
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

/**
 * One FILE riding a message. Metadata only: the bytes live in the
 * content-addressed store (see `attachments.ts`), because the recipient is often
 * an agent in another workspace that can't read the sender's disk — and by the
 * time it drains its inbox the sender's file may be gone.
 *
 * `sha256` is the store address (and the dedup key: the same file passed around
 * a channel is stored once); `id` is what an agent hands to `saveAttachment`.
 */
export interface AgentInboxAttachment {
    /** Stable per-message-attachment id — the handle for `saveAttachment`. */
    id: string;
    /** Base name as sent. NEVER a path — the sender can't steer a recipient's write. */
    filename: string;
    bytes: number;
    /** Best-effort content type, for display. A hint, never a gate. */
    mime: string;
    /** sha256 of the bytes — the blob store's address. */
    sha256: string;
}

/**
 * May `agentId` pull an attachment off `msg`? An attachment id is a handle, NOT
 * a capability: reaching the bytes requires having been party to the message.
 *
 * The sender always qualifies (including a channel poster that has since left —
 * it sent the file, it may fetch it back). A DM's recipient qualifies. A channel
 * message qualifies anyone currently in that room, which is the same membership
 * test delivery itself uses, so access tracks the room rather than a frozen
 * roster. The human panel owns the workstation and sees everything, exactly as
 * it does for the directory and the DM threads.
 */
export function canAccessMessageAttachment(input: {
    msg: Pick<AgentInboxMessage, 'kind' | 'from' | 'to' | 'channel'>;
    agentId: string;
    channelKeys: string[];
}): boolean {
    const { msg, agentId } = input;
    if (agentId === AGENTINBOX_HUMAN) return true;
    if (msg.from === agentId) return true;
    if (msg.kind === 'dm') return msg.to === agentId;
    return !!msg.channel && input.channelKeys.includes(msg.channel);
}

/** A delivered message — the full record kept in the per-channel / per-DM log and
 *  handed to an agent's `receive`. */
export interface AgentInboxMessage {
    /** Monotonic global sequence — the cursor an agent pages `receive` with. */
    seq: number;
    /** Stable message uuid. */
    id: string;
    /** Sender: `human`, `genie:system`, or an agent's `agentId`. */
    from: string;
    /** Human-readable sender label (`You`, `Genie (no reply)`, or the agent label). */
    fromLabel: string;
    kind: AgentInboxKind;
    /** Channel messages: the channel key. */
    channel?: string;
    /** DM messages: the recipient's `agentId` (or `human`). */
    to?: string;
    text: string;
    /** Epoch ms. */
    ts: number;
    /** DM only: an urgent nudge was requested (glows the recipient's terminal). */
    interrupt?: boolean;
    /** Files riding this message. ABSENT (not `[]`) when there are none, so a
     *  plain message is byte-identical to what it was before attachments. */
    attachments?: AgentInboxAttachment[];
}

/** The `agentInbox:message` push preview (never the full text stream). */
export interface AgentInboxMessagePreview {
    kind: AgentInboxKind;
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

/** The `agentInbox:presence` push payload for an agent that LEFT (spec removed). */
export interface AgentInboxPresenceOffline {
    agentId: string;
    status: 'offline';
    left: true;
}

/**
 * Everything the broker needs to register an agent — resolved by the caller
 * (which owns the db/fs I/O) and handed to the pure broker. `status` defaults to
 * `online`; rehydrate passes `away` (liveness unknown until the agent acts).
 */
export interface AgentInboxJoinInput {
    agentId: string;
    terminalId: string;
    workspaceId: string;
    workspaceName: string;
    slug: string;
    agentType: AgentInboxAgentType;
    label: string;
    purpose: string;
    scope: AgentInboxScope;
    scopeWorkspaces: string[];
    chatSessionId: string | null;
    status?: AgentInboxStatus;
    /** Opt-in wake-on-DM (issue #9), restored from spec meta on (re)join. Default false. */
    wakeOnDm?: boolean;
}

/** An unACKed urgent (`interrupt`) DM that escalated to the human oversight
 *  surface — the target didn't drain it within the escalation window (Track C).
 *  `resolved` clears a previously-raised "waiting on X" indicator once the target
 *  finally receives (its cursor passes the message). */
export interface AgentInboxEscalation {
    messageId: string;
    targetAgentId: string;
    targetLabel: string;
    fromLabel: string;
    preview: string;
    /** Epoch ms the urgent DM was sent (how long the human has been waiting). */
    sinceTs: number;
    /** True on the clearing event (the target finally drained it). */
    resolved?: boolean;
}

/** The broker's outbound event, mapped by presence.ts to the local broadcast +
 *  mobile push channels (and the terminal attention glow for `interrupt`). */
export type AgentInboxBrokerEvent =
    | { type: 'presence'; agent: AgentInboxAgentInfo }
    | { type: 'offline'; agentId: string }
    | { type: 'message'; preview: AgentInboxMessagePreview }
    | { type: 'interrupt'; terminalId: string }
    | { type: 'escalation'; escalation: AgentInboxEscalation }
    | { type: 'escalation-resolved'; messageId: string; targetAgentId: string }
    // A conversation's history was WIPED by the human (genie #64) — every open
    // window must drop its cached view of it rather than keep rendering rows the
    // host no longer has.
    | { type: 'cleared'; scope: 'channel' | 'dm'; key: string }
    // AGENT-lag level changed (genie #64) — how many delivered messages agents
    // have not received/ACKed. Drives the header badge; a LEVEL, so it only
    // fires on a transition, never per message.
    | { type: 'lag'; count: number };

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
    // NOTE (genie#324): `general` is NOT only an accident here. It is also the
    // designated name of a workspace's DEFAULT agent — `runAgent start` with no
    // name resolves to it (see `agents/identity.ts` and `agents/saved.ts`).
    // Removing this fallback outright breaks that convention and took out 12
    // runAgent tests. The accidental mint is fixed at the ONE site that lazily
    // invents an agent from an unnamed terminal (`agentInboxForMcp`), which
    // checks the RAW purpose instead of this normalised one.
    if (!kebab) return 'general';
    return kebab.split('-').filter(Boolean).slice(0, 6).join('-');
}

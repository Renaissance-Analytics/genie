import type { AgentId, AgentRecord } from './identity.js';

/**
 * AGENTINBOX — the pure half (§6.4). Addressing, reachability, attachment rules.
 *
 * Local, durable agent-to-agent messaging, with the human as a first-class participant. This
 * file decides WHO a message is for and WHETHER it may be sent; `main/inbox-store.ts` keeps it.
 * Nothing here is ever pasted into a terminal: the transport is Genie's MCP tool surface, and
 * a message a terminal could see is a message a prompt could forge.
 */

/** A party to a message: an agent by its one id, or the person. */
export type Participant = AgentId | typeof HUMAN;

/**
 * The human's address. A constant rather than a minted id because there is exactly one person
 * per Genie and every surface — the Deck's `unread-dm` source, the chat flyout — needs to find
 * their mail without a lookup.
 */
export const HUMAN = 'human' as const;

export interface Address {
    /** `null` for the short form `{provider}:{name}`. */
    readonly workspaceId: string | null;
    readonly provider: string;
    readonly name: string;
}

const SEGMENT = /^[A-Za-z0-9._-]+$/;

/** `{provider}:{name}` or `{workspace}:{provider}:{name}`; anything else is `null`. */
export function parseAddress(text: string): Address | null {
    const parts = text.split(':');
    if (parts.length !== 2 && parts.length !== 3) return null;
    if (!parts.every((p) => SEGMENT.test(p))) return null;
    if (parts.length === 2) return { workspaceId: null, provider: parts[0]!, name: parts[1]! };
    return { workspaceId: parts[0]!, provider: parts[1]!, name: parts[2]! };
}

export function addressOf(record: AgentRecord, form: 'short' | 'full'): string {
    return form === 'short'
        ? `${record.provider}:${record.name}`
        : `${record.workspaceId}:${record.provider}:${record.name}`;
}

export type Resolution =
    | { kind: 'one'; id: AgentId }
    | { kind: 'human' }
    /** Two agents share the short form. Both FULL forms are named so the sender can pick. */
    | { kind: 'ambiguous'; forms: readonly string[] }
    | { kind: 'none' };

/**
 * Resolve an address against the roster.
 *
 * An ambiguous short form is reported, never guessed: v1 routed `claude:review` to whichever
 * agent registered first, and a message meant for one workspace's reviewer landed in another's.
 */
export function resolveAddress(text: string, roster: readonly AgentRecord[]): Resolution {
    if (text === HUMAN || text === 'you') return { kind: 'human' };
    // The `from` on mail is the sender's id, so the id is an address too: an answer goes back to
    // exactly who wrote, with no name to look up. Resolving is not permission — `reachable` still decides.
    const byId = roster.find((r) => r.id === text);
    if (byId) return { kind: 'one', id: byId.id };
    const address = parseAddress(text);
    if (address === null) return { kind: 'none' };

    const matches = roster.filter(
        (r) =>
            r.provider === address.provider &&
            r.name === address.name &&
            (address.workspaceId === null || r.workspaceId === address.workspaceId),
    );
    if (matches.length === 0) return { kind: 'none' };
    if (matches.length === 1) return { kind: 'one', id: matches[0]!.id };
    return { kind: 'ambiguous', forms: matches.map((r) => addressOf(r, 'full')) };
}

/** A workspace's inbox setting: who may discover and message its agents from outside. */
export interface WorkspaceInboxSetting {
    readonly scope: 'none' | 'self' | 'specific' | 'all';
    /** For `specific`: the workspace ids allowed in. */
    readonly workspaces?: readonly string[];
}

/** The workspace's half of the two-tier rule, from its settings; anything unknown falls back to `self`, never to open. */
export function inboxSettingFrom(values: Readonly<Record<string, unknown>>): WorkspaceInboxSetting {
    const v = values.inbox_access;
    return { scope: v === 'none' || v === 'all' || v === 'self' ? v : 'self' };
}

/** How many agents may run in a workspace at once (§6.1 caps); the default when the value is not a number Genie offers. */
export function agentCapFrom(values: Readonly<Record<string, unknown>>): number {
    const n = Number(values.agent_cap);
    return [1, 2, 4, 8, 16].includes(n) ? n : 8;
}

export interface ReachableOptions {
    /** For an agent whose own scope is `specific`: the workspace ids it allows. */
    readonly agentWorkspaces?: readonly string[];
    /** Ops projects (§6.1): true when `fromWorkspace` governs `toWorkspace` — the governor then counts as the child's own workspace in both tiers. */
    readonly governs?: (fromWorkspace: string, toWorkspace: string) => boolean;
    /** Whether `writer` has ever messaged `reader` (the durable mail, never a cache). An agent that wrote to you can be answered. */
    readonly wroteTo?: (writer: AgentId, reader: AgentId) => boolean;
}

function tierAllows(
    scope: WorkspaceInboxSetting['scope'],
    fromWorkspace: string,
    toWorkspace: string,
    allowed: readonly string[],
): boolean {
    switch (scope) {
        case 'none':
            return false;
        case 'self':
            return fromWorkspace === toWorkspace;
        case 'specific':
            return fromWorkspace === toWorkspace || allowed.includes(fromWorkspace);
        case 'all':
            return true;
    }
}

/**
 * Whether `from` may message `to`. **Permission, not liveness** — a reachable agent may be
 * asleep, and an unreachable one may be running; `reachable` says nothing about either.
 *
 * Two tiers, both of which must allow it: the TARGET workspace's setting, and the target
 * agent's own `accessScope`. The human reaches everyone and everyone reaches the human — DND
 * is a reply, not a wall.
 *
 * **An agent that wrote to you can always be answered** (Genie 1's contract: "when one messages
 * you first, you may reply in that durable thread"; the owner: an agent "is visible to any agents
 * that it talks to"). The tiers guard who may OPEN a conversation with an agent; the agent that
 * opened one gave its permission by sending. Direction is the rule — writing to someone earns the
 * writer nothing — and it lets nobody else in: the tiers still decide for every other sender.
 */
export function reachable(
    from: AgentRecord | typeof HUMAN,
    to: AgentRecord | typeof HUMAN,
    workspaceSetting: (workspaceId: string) => WorkspaceInboxSetting,
    options: ReachableOptions = {},
): boolean {
    if (from === HUMAN || to === HUMAN) return true;
    if (options.wroteTo?.(to.id, from.id) === true) return true;
    if (to.accessScope === 'none') return false;

    // A governor (§6.1) stands where the child's own workspace stands — in both tiers; the reverse is not implied.
    const fromWorkspace = options.governs?.(from.workspaceId, to.workspaceId) === true ? to.workspaceId : from.workspaceId;
    const ws = workspaceSetting(to.workspaceId);
    const workspaceTier = tierAllows(ws.scope, fromWorkspace, to.workspaceId, ws.workspaces ?? []);
    const agentTier = tierAllows(to.accessScope, fromWorkspace, to.workspaceId, options.agentWorkspaces ?? []);
    return workspaceTier && agentTier;
}

const MB = 1024 * 1024;

export const ATTACHMENT_LIMITS = {
    perFileBytes: 25 * MB,
    perMessageBytes: 40 * MB,
    files: 10,
} as const;

/**
 * Natively-executable names, refused at both ends.
 *
 * Deliberately NOT `.sh`, `.js`, `.py`: those are the files agents most often share and none
 * runs on a double-click. The list is what an OS will execute as-is.
 */
const EXECUTABLE_EXTENSIONS = new Set([
    'exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'pif', 'ps1', 'psm1', 'vbs', 'vbe', 'wsf', 'wsh',
    'msc', 'jar', 'dll', 'app', 'dmg', 'pkg', 'deb', 'rpm', 'appimage', 'run',
]);

export function isExecutableName(name: string): boolean {
    const dot = name.lastIndexOf('.');
    if (dot < 0) return false;
    return EXECUTABLE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/** The reason a set of attachments is refused, or `null` when it is within every rule. */
export function attachmentRefusal(files: readonly { name: string; size: number }[]): string | null {
    if (files.length > ATTACHMENT_LIMITS.files) {
        return `${files.length} attachments; the limit is ${ATTACHMENT_LIMITS.files} files per message`;
    }
    let total = 0;
    for (const f of files) {
        if (isExecutableName(f.name)) return `${f.name} is a natively executable file and is refused`;
        if (f.size > ATTACHMENT_LIMITS.perFileBytes) {
            return `${f.name} is ${(f.size / MB).toFixed(1)} MB; the limit is 25 MB per file`;
        }
        total += f.size;
    }
    if (total > ATTACHMENT_LIMITS.perMessageBytes) {
        return `attachments total ${(total / MB).toFixed(1)} MB; the limit is 40 MB per message`;
    }
    return null;
}

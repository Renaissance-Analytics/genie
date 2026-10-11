/**
 * THE REMOTE WIRE (§6.8) — the pure half of driving another machine's Genie.
 *
 * One message shape both ways: `hello` → `welcome` | `refused`, then `call` → `result`, with
 * `event` pushed host → client. Parsed defensively: a bad frame is a refusal with a reason, never a
 * throw. ONE table says what every bridge method is — a READ (never gated on the baton), a WRITE
 * (gated on the baton), an UPGRADE (gated on ownership of the host), or HOST-ONLY (a window or a
 * picker on the host, refused remotely with where to do it). Everything else derives from it.
 */

export const REMOTE_METHODS = [
    'snapshot',
    'agentDetail',
    'openAgent',
    'stopAgent',
    'prompt',
    'addAgent',
    'answerApproval',
    'restartWithHandoff',
    'agents.restart',
    'agents.previewDelete',
    'agents.delete',
    'agents.switchDriver',
    'agents.setBudget',
    'agents.diagnose',
    'workspaces.previewAdd',
    'workspaces.confirmAdd',
    'workspaces.hibernate',
    'workspaces.wake',
    'workspaces.remove',
    'workspaces.listRepos',
    'workspaces.addRepo',
    'workspaces.removeRepo',
    'addWorkspace',
    'takeOver',
    'terminals.open',
    'terminals.write',
    'terminals.resize',
    'terminals.close',
    'terminals.list',
    'features.snapshot',
    'features.act',
    'features.setBrowserBounds',
    'updates.state',
    'updates.check',
    'updates.download',
    'updates.install',
    'updates.cancel',
] as const;
export type RemoteMethod = (typeof REMOTE_METHODS)[number];

/** Protocol-level calls that are not bridge methods: the baton and the owner's lock. */
export const CONTROL_METHODS = ['baton.take', 'baton.release', 'baton.status', 'host.lock', 'host.unlock'] as const;
export type ControlMethod = (typeof CONTROL_METHODS)[number];

export type RemoteCapability = 'read' | 'write' | 'upgrade' | 'host-only';

const CAPABILITIES: Readonly<Record<RemoteMethod, RemoteCapability>> = {
    snapshot: 'read',
    agentDetail: 'read',
    'terminals.list': 'read',
    'features.snapshot': 'read',
    'updates.state': 'read',
    openAgent: 'write',
    stopAgent: 'write',
    prompt: 'write',
    addAgent: 'write',
    answerApproval: 'write',
    restartWithHandoff: 'write',
    'agents.restart': 'write',
    'agents.previewDelete': 'read',
    'agents.delete': 'write',
    'agents.switchDriver': 'write',
    'agents.setBudget': 'write',
    'agents.diagnose': 'read',
    'workspaces.previewAdd': 'host-only',
    'workspaces.confirmAdd': 'write',
    'workspaces.hibernate': 'write',
    'workspaces.wake': 'write',
    'workspaces.remove': 'write',
    'workspaces.listRepos': 'read',
    'workspaces.addRepo': 'write',
    'workspaces.removeRepo': 'write',
    'terminals.open': 'write',
    'terminals.write': 'write',
    'terminals.resize': 'write',
    'terminals.close': 'write',
    'features.act': 'write',
    'updates.check': 'write',
    'updates.download': 'write',
    'updates.install': 'upgrade',
    // Abandoning a drain changes nothing on the host but the wait, so a writer may; an upgrade needs ownership, a cancel does not.
    'updates.cancel': 'write',
    addWorkspace: 'host-only',
    takeOver: 'host-only',
    'features.setBrowserBounds': 'host-only',
};

export function capabilityOf(method: RemoteMethod): RemoteCapability {
    return CAPABILITIES[method];
}

/** Methods whose FIRST argument is an agent id — what a guest's workspace scope is checked against. */
export const AGENT_SCOPED_METHODS: readonly RemoteMethod[] = ['agentDetail', 'openAgent', 'stopAgent', 'prompt', 'answerApproval', 'restartWithHandoff', 'takeOver', 'agents.restart', 'agents.previewDelete', 'agents.delete', 'agents.switchDriver', 'agents.setBudget', 'agents.diagnose'];
/** Methods whose FIRST argument is a workspace id. */
export const WORKSPACE_SCOPED_METHODS: readonly RemoteMethod[] = ['addAgent', 'terminals.open', 'terminals.list', 'workspaces.hibernate', 'workspaces.wake', 'workspaces.remove', 'workspaces.listRepos', 'workspaces.addRepo', 'workspaces.removeRepo'];

export type AuthRequest =
    | { kind: 'pin'; code: string; label?: string }
    | { kind: 'token'; token: string; label?: string }
    | { kind: 'share'; id: string; secret: string; label?: string };

export type WireMessage =
    | { kind: 'hello'; auth: AuthRequest; label?: string }
    | { kind: 'welcome'; connectionId: string; host: string; isOwner: boolean; workspaceId: string | null; token?: string }
    | { kind: 'refused'; reason: string }
    | { kind: 'call'; id: number; method: RemoteMethod | ControlMethod; args: unknown[] }
    | { kind: 'result'; id: number; ok: true; value: unknown }
    | { kind: 'result'; id: number; ok: false; reason: string }
    | { kind: 'event'; channel: string; payload: unknown };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isMethod = (m: unknown): m is RemoteMethod | ControlMethod =>
    typeof m === 'string' && ((REMOTE_METHODS as readonly string[]).includes(m) || (CONTROL_METHODS as readonly string[]).includes(m));

export function parseMessage(text: string): { ok: true; message: WireMessage } | { ok: false; reason: string } {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return { ok: false, reason: 'not JSON' };
    }
    if (!isRecord(raw)) return { ok: false, reason: 'not a message object' };
    const kind = raw.kind;
    switch (kind) {
        case 'hello': {
            const auth = raw.auth;
            if (!isRecord(auth)) return { ok: false, reason: 'hello needs an auth object' };
            const okAuth =
                (auth.kind === 'pin' && typeof auth.code === 'string') ||
                (auth.kind === 'token' && typeof auth.token === 'string') ||
                (auth.kind === 'share' && typeof auth.id === 'string' && typeof auth.secret === 'string');
            if (!okAuth) return { ok: false, reason: 'hello auth must be a pin {code}, a token {token} or a share {id, secret}' };
            if (raw.label !== undefined && typeof raw.label !== 'string') return { ok: false, reason: 'hello label must be a string' };
            return { ok: true, message: raw as unknown as WireMessage };
        }
        case 'call': {
            if (typeof raw.id !== 'number' || typeof raw.method !== 'string' || !Array.isArray(raw.args)) {
                return { ok: false, reason: 'a call needs a numeric id, a method and an args array' };
            }
            if (!isMethod(raw.method)) return { ok: false, reason: `"${raw.method}" is not a bridge method` };
            return { ok: true, message: { kind: 'call', id: raw.id, method: raw.method, args: raw.args } };
        }
        case 'result': {
            if (typeof raw.id !== 'number' || typeof raw.ok !== 'boolean') return { ok: false, reason: 'a result needs a numeric id and ok' };
            if (raw.ok) return { ok: true, message: { kind: 'result', id: raw.id, ok: true, value: raw.value } };
            return { ok: true, message: { kind: 'result', id: raw.id, ok: false, reason: typeof raw.reason === 'string' ? raw.reason : 'refused' } };
        }
        case 'event':
            if (typeof raw.channel !== 'string') return { ok: false, reason: 'an event needs a channel' };
            return { ok: true, message: { kind: 'event', channel: raw.channel, payload: raw.payload } };
        case 'welcome':
            if (typeof raw.connectionId !== 'string' || typeof raw.host !== 'string' || typeof raw.isOwner !== 'boolean') return { ok: false, reason: 'a welcome needs connectionId, host and isOwner' };
            return { ok: true, message: raw as unknown as WireMessage };
        case 'refused':
            return { ok: true, message: { kind: 'refused', reason: typeof raw.reason === 'string' ? raw.reason : 'refused' } };
        default:
            return { ok: false, reason: `unknown message kind "${String(kind)}"` };
    }
}

/** Loud, and names the host (§6.8). */
export function remoteBadge(host: string): string {
    return `● REMOTE — ${host}`;
}

/** What a guest with a share link to one workspace sees of the estate. */
export function filterSnapshotForWorkspace<T extends { agents?: readonly { workspaceId: string }[]; workspaces?: readonly { id: string }[] | null; deckItems?: readonly { workspaceId: string | null }[] | null }>(snapshot: T, workspaceId: string): T {
    return {
        ...snapshot,
        ...(snapshot.agents ? { agents: snapshot.agents.filter((a) => a.workspaceId === workspaceId) } : {}),
        ...(snapshot.workspaces ? { workspaces: snapshot.workspaces.filter((w) => w.id === workspaceId) } : {}),
        ...(snapshot.deckItems ? { deckItems: snapshot.deckItems.filter((d) => d.workspaceId === workspaceId) } : {}),
    };
}

/** One end of a connection: text frames out, text frames in, a close that fires once on the peer. */
export interface ClientTransport {
    send(text: string): void;
    onMessage(listener: (text: string) => void): () => void;
    onClose(listener: () => void): () => void;
    close(): void;
}

export interface ServerConnection extends ClientTransport {
    readonly remoteAddress: string;
}

/** Where connections come from — fancy-ws on a real socket, or the in-memory pair in tests. */
export interface ServerTransport {
    onConnection(listener: (connection: ServerConnection) => void): () => void;
    /** Where this transport listens, for the device to type; absent or `null` while nothing listens. */
    address?(): string | null;
    /** Why nothing listens, in words a person can act on; `null` while something does. */
    unavailable?(): string | null;
}

/** Two ends wired to each other in memory. Frames are delivered on the microtask queue, in order. */
export function inMemoryPair(): { client: ClientTransport; server: ServerConnection } {
    const make = () => {
        const messages = new Set<(text: string) => void>();
        const closes = new Set<() => void>();
        return { messages, closes, closed: false };
    };
    const a = make();
    const b = make();
    const end = (mine: typeof a, peer: typeof b): ClientTransport => ({
        send: (text) => {
            if (mine.closed) return;
            queueMicrotask(() => { for (const l of peer.messages) l(text); });
        },
        onMessage: (l) => { mine.messages.add(l); return () => { mine.messages.delete(l); }; },
        onClose: (l) => { mine.closes.add(l); return () => { mine.closes.delete(l); }; },
        close: () => {
            if (mine.closed) return;
            mine.closed = true;
            peer.closed = true;
            queueMicrotask(() => { for (const l of peer.closes) l(); for (const l of mine.closes) l(); });
        },
    });
    return { client: end(a, b), server: { ...end(b, a), remoteAddress: 'memory' } };
}

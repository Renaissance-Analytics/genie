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
    'cancelTurn',
    'resumeLimit',
    'providerLogin',
    'prompt',
    'resolvePrompt',
    'addAgent',
    'answerApproval',
    'restartWithHandoff',
    'agents.restart',
    'agents.previewDelete',
    'agents.delete',
    'agents.switchDriver',
    'agents.setBudget',
    'agents.setMode',
    'agents.setAccessScope',
    'agents.setAutoApprove',
    'agents.setManageTabs',
    'agents.setDrivePages',
    'activity',
    'agents.setIssueWatch',
    'agents.setPermissions',
    'agents.setModel',
    'agents.models',
    'agents.diagnose',
    'workspaces.previewAdd',
    'workspaces.confirmAdd',
    'workspaces.create',
    'workspaces.previewAddFromGit',
    'workspaces.confirmAddFromGit',
    'workspaces.readSource',
    'workspaces.stageFromGit',
    'workspaces.registerExisting',
    'workspaces.buildEnvelope',
    'workspaces.discardStaged',
    'workspaces.githubRepos',
    'workspaces.tynnProjects',
    'workspaces.tynnOwnerOptions',
    'workspaces.createTynnProject',
    'workspaces.importedAgents',
    'workspaces.adoptAgent',
    'workspaces.previewAddFromTynn',
    'workspaces.confirmAddFromTynn',
    'workspaces.hibernate',
    'workspaces.wake',
    'workspaces.remove',
    'workspaces.listRepos',
    'workspaces.tynnBoard',
    'workspaces.tynnBoardAction',
    'workspaces.tynnPage',
    'workspaces.tynnIssues',
    'workspaces.tynnIssueAction',
    'workspaces.addRepo',
    'workspaces.removeRepo',
    'workspaces.removeRepoLock',
    'workspaces.locateRepo',
    'workspaces.commitsSince',
    'workspaces.settings',
    'workspaces.setSetting',
    'workspaces.resetSetting',
    'workspaces.setGoverns',
    'workspaces.setDefaultAgent',
    'workspaces.setColor',
    'addWorkspace',
    'takeOver',
    'terminals.open',
    'terminals.write',
    'terminals.resize',
    'terminals.close',
    'terminals.attach',
    'terminals.list',
    'features.snapshot',
    'features.act',
    'features.setBrowserBounds',
    'updates.state',
    'host.listDir',
    'host.mkdir',
    'updates.check',
    'updates.download',
    'updates.install',
    /** A phone's upload (§6.8): bytes over the socket → the inbox's byte copy; never a path from the device. */
    'inbox.sendFile',
    /*
     * THE PHONE'S FILE BROWSER (genie#1346): one folder, a text file, a media file's bytes — through the files host the panel
     * uses, confined to the workspace — and an upload into a folder of it, from bytes staged on the connection.
     */
    'files.children',
    'files.open',
    'files.readMedia',
    'files.upload',
] as const;
export type RemoteMethod = (typeof REMOTE_METHODS)[number];

/** Protocol-level calls that are not bridge methods: the baton and the owner's lock. */
/*
 * `agent.watch` / `agent.unwatch` (genie#1346): a phone's window on ONE agent's ledger, then patches (core/mobile-wire.ts).
 * `upload.begin` / `upload.chunk` / `upload.abort`: bytes staged on the connection under the 1 MiB frame cap, taken by
 * `files.upload` or a prompt's attachments.
 */
export const CONTROL_METHODS = ['baton.take', 'baton.release', 'baton.status', 'host.lock', 'host.unlock', 'agent.watch', 'agent.unwatch', 'upload.begin', 'upload.chunk', 'upload.abort'] as const;
export type ControlMethod = (typeof CONTROL_METHODS)[number];

export type RemoteCapability = 'read' | 'write' | 'upgrade' | 'host-only';

const CAPABILITIES: Readonly<Record<RemoteMethod, RemoteCapability>> = {
    snapshot: 'read',
    agentDetail: 'read',
    'terminals.list': 'read',
    'terminals.attach': 'read',
    'features.snapshot': 'read',
    'updates.state': 'read',
    openAgent: 'write',
    stopAgent: 'write',
    // `Stop this turn`: the current turn ends, the agent keeps running. A write like stopAgent, agent-scoped like it.
    cancelTurn: 'write',
    // `Resume now` while a provider's login is held for its rate limit (Tynn #794): a write, agent-scoped.
    resumeLimit: 'write',
    prompt: 'write',
    resolvePrompt: 'write',
    addAgent: 'write',
    answerApproval: 'write',
    restartWithHandoff: 'write',
    'agents.restart': 'write',
    'agents.previewDelete': 'read',
    'agents.delete': 'write',
    'agents.switchDriver': 'write',
    'agents.setBudget': 'write',
    'agents.setMode': 'write',
    'agents.setAccessScope': 'write',
    // Autonomy (Tynn #801): what an agent may do without asking — a write, agent-scoped like the other settings.
    'agents.setAutoApprove': 'write',
    'agents.setManageTabs': 'write',
    'agents.setDrivePages': 'write',
    // The Dashboard's lanes (beta.33 item 10): every agent's activity feed in one workspace — a read, workspace-scoped.
    activity: 'read',
    'agents.setIssueWatch': 'write',
    'agents.setPermissions': 'write',
    'agents.setModel': 'write',
    // The provider's own model list for an agent's picker (the owner, 2026-10-21): a read, agent-scoped.
    'agents.models': 'read',
    'agents.diagnose': 'read',
    // Tynn #835: the folder is picked IN THE WINDOW (a FileBrowser over the host's own disk); the preview reads a path.
    'workspaces.previewAdd': 'read',
    // One folder of the host, for every file and folder picker (main/host-fs.ts); a guest only inside its workspace(s).
    'host.listDir': 'read',
    // The folder picker's New folder (2026-10-22): a folder made on the host's disk — a write, and owner-only on a host.
    'host.mkdir': 'write',
    'workspaces.confirmAdd': 'write',
    'workspaces.create': 'write',
    'workspaces.previewAddFromGit': 'read',
    'workspaces.confirmAddFromGit': 'write',
    // The Open existing / Import from Git wizard (Add workspace parity item 7): reading a folder is a read; the staging
    // clone, the build, the registration and dropping a staging clone all write on the host.
    'workspaces.readSource': 'read',
    'workspaces.stageFromGit': 'write',
    'workspaces.registerExisting': 'write',
    'workspaces.buildEnvelope': 'write',
    'workspaces.discardStaged': 'write',
    // Import from Git's browser (Add workspace parity item 8): the repositories the HOST's GitHub sign-in reaches.
    'workspaces.githubRepos': 'read',
    // The signed-in person's projects lead to the host's folder picker: the whole From Tynn is done on the host.
    'workspaces.tynnProjects': 'read',
    // The optional link's "New project" (Add workspace parity item 5): who may own it is a read; creating it writes on Tynn.
    'workspaces.tynnOwnerOptions': 'read',
    'workspaces.createTynnProject': 'write',
    // "It came with agents" (Add workspace parity item 6): the unregistered `.agents/*` is a read; adopting one registers it.
    'workspaces.importedAgents': 'read',
    'workspaces.adoptAgent': 'write',
    'workspaces.previewAddFromTynn': 'read',
    'workspaces.confirmAddFromTynn': 'write',
    'workspaces.hibernate': 'write',
    'workspaces.wake': 'write',
    'workspaces.remove': 'write',
    'workspaces.listRepos': 'read',
    // The Tynn tab (genie#1295): reading the workspace's Tynn board is a read; a step, drag or delete writes on Tynn.
    'workspaces.tynnBoard': 'read',
    'workspaces.tynnBoardAction': 'write',
    'workspaces.tynnPage': 'read',
    // The Tynn tab's Issues (genie#1295 I1): reading the queue is a read; filing, editing, converting or closing writes.
    'workspaces.tynnIssues': 'read',
    'workspaces.tynnIssueAction': 'write',
    'workspaces.addRepo': 'write',
    'workspaces.removeRepo': 'write',
    'workspaces.removeRepoLock': 'write',
    // The folder picker is the host's; a remote window is told to do it there.
    'workspaces.locateRepo': 'write',
    'workspaces.commitsSince': 'read',
    'workspaces.settings': 'read',
    'workspaces.setSetting': 'write',
    'workspaces.resetSetting': 'write',
    'workspaces.setGoverns': 'write',
    'workspaces.setDefaultAgent': 'write',
    // A workspace's colour (genie#1300): written to its project.json, like the Settings beside it.
    'workspaces.setColor': 'write',
    'terminals.open': 'write',
    'terminals.write': 'write',
    'terminals.resize': 'write',
    'terminals.close': 'write',
    'features.act': 'write',
    // The whole upgrade is the OWNER acting on the host (Tynn #845): no baton, never a guest.
    'updates.check': 'upgrade',
    'updates.download': 'upgrade',
    'updates.install': 'upgrade',
    // Abandoning a drain changes nothing on the host but the wait, so a writer may; an upgrade needs ownership, a cancel does not.
    'inbox.sendFile': 'write',
    // The phone's files (genie#1346): reading a workspace's files is a read; an upload writes into it.
    'files.children': 'read',
    'files.open': 'read',
    'files.readMedia': 'read',
    'files.upload': 'write',
    addWorkspace: 'host-only',
    takeOver: 'host-only',
    // A provider's login opens a window on the host, for the person at it: like Take Over.
    providerLogin: 'host-only',
    'features.setBrowserBounds': 'host-only',
};

export function capabilityOf(method: RemoteMethod): RemoteCapability {
    return CAPABILITIES[method];
}

/** Methods whose FIRST argument is an agent id — what a guest's workspace scope is checked against. */
export const AGENT_SCOPED_METHODS: readonly RemoteMethod[] = ['agentDetail', 'openAgent', 'stopAgent', 'cancelTurn', 'resumeLimit', 'providerLogin', 'prompt', 'resolvePrompt', 'answerApproval', 'restartWithHandoff', 'takeOver', 'agents.restart', 'agents.previewDelete', 'agents.delete', 'agents.switchDriver', 'agents.setBudget', 'agents.setMode', 'agents.setAccessScope', 'agents.setAutoApprove', 'agents.setManageTabs', 'agents.setDrivePages', 'agents.setIssueWatch', 'agents.setPermissions', 'agents.setModel', 'agents.models', 'agents.diagnose'];
/** Methods whose FIRST argument is a workspace id. */
export const WORKSPACE_SCOPED_METHODS: readonly RemoteMethod[] = ['addAgent', 'activity', 'terminals.open', 'terminals.attach', 'terminals.list', 'workspaces.hibernate', 'workspaces.wake', 'workspaces.remove', 'workspaces.listRepos', 'workspaces.addRepo', 'workspaces.removeRepo', 'workspaces.removeRepoLock', 'workspaces.settings', 'workspaces.setSetting', 'workspaces.resetSetting', 'workspaces.setGoverns', 'workspaces.setDefaultAgent', 'workspaces.setColor', 'workspaces.commitsSince', 'workspaces.locateRepo', 'workspaces.tynnBoard', 'workspaces.tynnBoardAction', 'workspaces.tynnIssues', 'workspaces.tynnIssueAction', 'workspaces.tynnPage', 'files.children', 'files.open', 'files.readMedia', 'files.upload'];

export type AuthRequest =
    | { kind: 'pin'; code: string; label?: string }
    | { kind: 'token'; token: string; label?: string }
    | { kind: 'share'; id: string; secret: string; label?: string }
    /** Already authenticated by the TRANSPORT (the Tynn relay checked a grant and its key, Tynn #838): refused on any
     *  connection that carries no {@link PreAuth}, so a tailnet socket cannot claim it. */
    | { kind: 'relay'; label?: string };

/** Who a transport already proved a connection to be (the Tynn relay's grant, main/relay-grant.ts). */
export interface PreAuth {
    readonly label: string;
    readonly isOwner: boolean;
    /** The one workspace a guest may reach; `null` = the whole host. */
    readonly workspaceId: string | null;
    /** Reads only: every change is refused. */
    readonly readonly: boolean;
}

/**
 * What kind of screen says hello (genie#1346). `mobile` is a phone: it receives the snapshot and the agents it watches,
 * never terminal bytes, and is refused terminals. Absent = another Genie's window, which hears everything, as before.
 */
export type ClientProfile = 'mobile';

export type WireMessage =
    | { kind: 'hello'; auth: AuthRequest; label?: string; profile?: ClientProfile }
    | { kind: 'welcome'; connectionId: string; host: string; isOwner: boolean; workspaceId: string | null; token?: string }
    | { kind: 'refused'; reason: string }
    /** The PIN was right; the host's own screen is asking "Pair this device?" until `expiresAt` (q_8c07b142). */
    | { kind: 'pairing'; host: string; expiresAt: number }
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
                (auth.kind === 'share' && typeof auth.id === 'string' && typeof auth.secret === 'string') ||
                auth.kind === 'relay';
            if (!okAuth) return { ok: false, reason: 'hello auth must be a pin {code}, a token {token}, a share {id, secret} or relay' };
            if (raw.label !== undefined && typeof raw.label !== 'string') return { ok: false, reason: 'hello label must be a string' };
            if (raw.profile !== undefined && raw.profile !== 'mobile') return { ok: false, reason: 'hello profile must be "mobile" when given' };
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
        case 'pairing':
            if (typeof raw.host !== 'string' || typeof raw.expiresAt !== 'number') return { ok: false, reason: 'a pairing frame needs host and expiresAt' };
            return { ok: true, message: { kind: 'pairing', host: raw.host, expiresAt: raw.expiresAt } };
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
    /** Set by a transport that authenticated the connection itself (the Tynn relay); a `relay` hello takes it. */
    readonly preAuth?: PreAuth;
}

/** Where connections come from — fancy-ws on a real socket, or the in-memory pair in tests. */
export interface ServerTransport {
    onConnection(listener: (connection: ServerConnection) => void): () => void;
    /** Where this transport listens, for the device to type; absent or `null` while nothing listens. */
    address?(): string | null;
    /** Why nothing listens, in words a person can act on; `null` while something does. */
    unavailable?(): string | null;
}

/**
 * ONE TRANSPORT FROM SEVERAL (Tynn #838): RemoteHost hears the tailnet listener (the primary — its address and its
 * reason for not listening are what Settings shows) and any transport added while it lives, such as the Tynn relay.
 */
export function transportHub(primary: ServerTransport): ServerTransport & { add(transport: ServerTransport): () => void } {
    const listeners = new Set<(connection: ServerConnection) => void>();
    const fan = (connection: ServerConnection) => { for (const l of listeners) l(connection); };
    primary.onConnection(fan);
    return {
        onConnection: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
        // Only what the primary has: RemoteHost words a missing reason itself.
        ...(primary.address ? { address: () => primary.address!() } : {}),
        ...(primary.unavailable ? { unavailable: () => primary.unavailable!() } : {}),
        add: (transport) => transport.onConnection(fan),
    };
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

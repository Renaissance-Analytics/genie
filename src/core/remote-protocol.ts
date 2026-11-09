import { BLOB_METHODS } from './local-blobs.js';
import { LOCAL_TERMINAL_METHODS, type LocalTerminalMethod } from './local-terminals.js';
import { LOCAL_CONTENT_METHODS } from './local-content.js';
import { FILES_WATCH_METHODS } from './local-files-watch.js';
import { TYNN_WATCH_METHODS } from './local-tynn-watch.js';
import { LOCAL_FILES_METHODS, type LocalFilesMethod } from './local-files.js';
import { LOCAL_DRAFT_METHODS, type LocalDraftMethod } from './local-drafts.js';
import { LOCAL_ARTBOARD_METHODS, type LocalArtboardMethod } from './local-artboard.js';
import { MARKETPLACE_METHODS, type MarketplaceMethod } from './marketplace.js';

/**
 * THE REMOTE WIRE (§6.8) — the pure half of driving another machine's Genie.
 *
 * One message shape both ways: `hello` → `welcome` | `refused`, then `call` → `result`, with
 * `event` pushed host → client. Parsed defensively: a bad frame is a refusal with a reason, never a
 * throw. ONE table says what every bridge method is — a READ (never gated on the baton), a WRITE
 * (gated on the baton), an UPGRADE (gated on ownership of the host), or HOST-ONLY (a window or a
 * picker on the host, refused remotely with where to do it), or LOCAL (only the admitted window door).
 * Everything else derives from it.
 */

/**
 * The remote wire's version, said in `welcome` with the host's build (P10.1e): a client sees what it is talking to. Raised
 * only for a change an older client cannot read; a new field an old client ignores is not one.
 */
export const REMOTE_PROTOCOL = 1;

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
    'agents.setAccessAgents',
    'agents.setAutoApprove',
    'agents.setManageTabs',
    'agents.setDrivePages',
    'activity',
    'accountRetry',
    'headroom',
    'agents.setIssueWatch',
    'agents.setPermissions',
    'agents.setModel',
    'agents.models',
    'agents.diagnose',
    // A tool row's whole output, read when a person opens the row (Tynn story #386).
    'agents.toolOutput',
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
    'workspaces.tynnPageAction',
    // P4 family 12 (Tynn #561): what changed on the board or the issue queue since a cursor — the live tab's reads.
    'workspaces.tynnBoardChanges',
    'workspaces.tynnIssueChanges',
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
    // P4 family 11 (Tynn #560): a custom alert sound's data, read by this machine's own window.
    'features.soundData',
    // Tynn #560: the host's own file picker says what it picked; only this machine's window counts (CallContext).
    'features.picked',
    'features.act',
    'features.setBrowserBounds',
    'updates.state',
    'host.listDir',
    'host.mkdir',
    'host.home',
    'updates.check',
    'updates.download',
    'updates.install',
    'updates.notes',
    'appInbox.state',
    'appInbox.createKey',
    'appInbox.revokeKey',
    'appInbox.source',
    'deviceLink.hosts',
    'deviceLink.forget',
    'deviceLink.adopt',
    'tynnNetwork.workstations',
    'tynnNetwork.setRole',
    'tynnNetwork.shares.list',
    'tynnNetwork.shares.mint',
    'tynnNetwork.shares.revoke',
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
    ...LOCAL_FILES_METHODS,
    ...LOCAL_DRAFT_METHODS,
    ...LOCAL_ARTBOARD_METHODS,
    ...LOCAL_TERMINAL_METHODS,
    ...MARKETPLACE_METHODS,
] as const;
export type RemoteMethod = (typeof REMOTE_METHODS)[number];

/** Protocol-level calls that are not bridge methods: the baton and the owner's lock. */
/*
 * `agent.watch` / `agent.unwatch` (genie#1346): a phone's window on ONE agent's ledger, then patches (core/mobile-wire.ts).
 * `upload.begin` / `upload.chunk` / `upload.abort`: bytes staged on the connection under the 1 MiB frame cap, taken by
 * `files.upload` or a prompt's attachments.
 * `blob.*`, `localUpload.*`, `page.*`: connection-owned local content resources, gated before any source is opened.
 */
export const CONTROL_METHODS = ['baton.take', 'baton.release', 'baton.status', 'baton.watch', 'host.lock', 'host.unlock', 'agent.watch', 'agent.unwatch', 'activity.watch', 'activity.unwatch', 'upload.begin', 'upload.chunk', 'upload.abort', ...BLOB_METHODS, ...LOCAL_CONTENT_METHODS, ...FILES_WATCH_METHODS, ...TYNN_WATCH_METHODS] as const;
export type ControlMethod = (typeof CONTROL_METHODS)[number];

/** Moved native pushes have separate local channels; existing remote subscriptions keep their channels. */
/**
 * Who drives, pushed to a remote window that asked (`baton.watch`, Tynn #529) whenever it changes by something that window
 * did not do itself: another window took control, the driver released it or left, the owner locked the host. `by`: who
 * took it (`null` when it was released or lost). `mine`: whether this window holds it.
 */
export const BATON_EVENT = 'remote-baton';
/** A Take Over window's connection is told when its ticket stops letting it type, and why (Tynn #529 part A). */
export const COMPANION_EVENT = 'remote-companion';
export interface CompanionEvent { readonly revoked: string }
export interface BatonEvent { readonly driver: string | null; readonly mine: boolean; readonly locked: boolean; readonly by: string | null }

export const LOCAL_EVENTS = { updates: 'local-updates', activity: 'local-activity', headroom: 'local-headroom', files: 'local-files', tynn: 'local-tynn', features: 'local-features' } as const;

export type RemoteCapability = 'read' | 'write' | 'upgrade' | 'host-only' | 'local';

const CAPABILITIES: Readonly<Record<RemoteMethod, RemoteCapability>> = {
    snapshot: 'read',
    agentDetail: 'read',
    'terminals.list': 'read',
    'terminals.attach': 'read',
    'features.snapshot': 'read',
    'features.soundData': 'local',
    'features.picked': 'local',
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
    'agents.setAccessAgents': 'write',
    // Autonomy (Tynn #801): what an agent may do without asking — a write, agent-scoped like the other settings.
    'agents.setAutoApprove': 'write',
    'agents.setManageTabs': 'write',
    'agents.setDrivePages': 'write',
    // The Dashboard's lanes (beta.33 item 10): every agent's activity feed in one workspace — a read, workspace-scoped.
    activity: 'read',
    accountRetry: 'local',
    headroom: 'local',
    'agents.setIssueWatch': 'write',
    'agents.setPermissions': 'write',
    'agents.setModel': 'write',
    // The provider's own model list for an agent's picker (the owner, 2026-10-21): a read, agent-scoped.
    'agents.models': 'read',
    'agents.diagnose': 'read',
    'agents.toolOutput': 'read',
    // Tynn #835: the folder is picked IN THE WINDOW (a FileBrowser over the host's own disk); the preview reads a path.
    'workspaces.previewAdd': 'read',
    // One folder of the host, for every file and folder picker (main/host-fs.ts); a guest only inside its workspace(s).
    'host.listDir': 'read',
    // The folder picker's New folder (2026-10-22): a folder made on the host's disk — a write, and owner-only on a host.
    'host.mkdir': 'write',
    // The host's home folder, where a picker opens when nothing better is known (Tynn #527): a read; a guest is answered
    // the folder it was given (main/remote-host.ts).
    'host.home': 'read',
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
    // The Home's Details save (genie#1295 H1) writes on Tynn.
    'workspaces.tynnPageAction': 'write',
    'workspaces.tynnBoardChanges': 'local',
    'workspaces.tynnIssueChanges': 'local',
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
    'updates.notes': 'local',
    'appInbox.state': 'local',
    'appInbox.createKey': 'local',
    'appInbox.revokeKey': 'local',
    'appInbox.source': 'local',
    'deviceLink.hosts': 'local',
    'deviceLink.forget': 'local',
    'deviceLink.adopt': 'local',
    'tynnNetwork.workstations': 'local',
    'tynnNetwork.setRole': 'local',
    'tynnNetwork.shares.list': 'local',
    'tynnNetwork.shares.mint': 'local',
    'tynnNetwork.shares.revoke': 'local',
    // Abandoning a drain changes nothing on the host but the wait, so a writer may; an upgrade needs ownership, a cancel does not.
    'inbox.sendFile': 'write',
    // The phone's files (genie#1346): reading a workspace's files is a read; an upload writes into it.
    'files.children': 'read',
    'files.open': 'read',
    'files.readMedia': 'read',
    'files.upload': 'write',
    ...Object.fromEntries(LOCAL_FILES_METHODS.map(method => [method, 'local'])) as Record<LocalFilesMethod, 'local'>,
    ...Object.fromEntries(LOCAL_DRAFT_METHODS.map(method => [method, 'local'])) as Record<LocalDraftMethod, 'local'>,
    ...Object.fromEntries(LOCAL_ARTBOARD_METHODS.map(method => [method, 'local'])) as Record<LocalArtboardMethod, 'local'>,
    ...Object.fromEntries(LOCAL_TERMINAL_METHODS.map(method => [method, 'local'])) as Record<LocalTerminalMethod, 'local'>,
    ...Object.fromEntries(MARKETPLACE_METHODS.map(method => [method, 'local'])) as Record<MarketplaceMethod, 'local'>,
    addWorkspace: 'host-only',
    // Tynn #529 part A: from another machine, the TUI starts here and its window opens THERE — a write, on the baton.
    takeOver: 'write',
    // A provider's login opens a window on the host, for the person at it: like Take Over.
    providerLogin: 'host-only',
    'features.setBrowserBounds': 'host-only',
};

export function capabilityOf(method: RemoteMethod): RemoteCapability {
    return CAPABILITIES[method];
}

/** Methods whose FIRST argument is an agent id — what a guest's workspace scope is checked against. */
export const AGENT_SCOPED_METHODS: readonly RemoteMethod[] = ['agentDetail', 'openAgent', 'stopAgent', 'cancelTurn', 'resumeLimit', 'providerLogin', 'prompt', 'resolvePrompt', 'answerApproval', 'restartWithHandoff', 'takeOver', 'agents.toolOutput', 'agents.restart', 'agents.previewDelete', 'agents.delete', 'agents.switchDriver', 'agents.setBudget', 'agents.setMode', 'agents.setAccessScope', 'agents.setAccessAgents', 'agents.setAutoApprove', 'agents.setManageTabs', 'agents.setDrivePages', 'agents.setIssueWatch', 'agents.setPermissions', 'agents.setModel', 'agents.models', 'agents.diagnose'];
/** Methods whose FIRST argument is a workspace id. */
export const WORKSPACE_SCOPED_METHODS: readonly RemoteMethod[] = ['addAgent', 'activity', 'terminals.open', 'terminals.attach', 'terminals.list', 'workspaces.hibernate', 'workspaces.wake', 'workspaces.remove', 'workspaces.listRepos', 'workspaces.addRepo', 'workspaces.removeRepo', 'workspaces.removeRepoLock', 'workspaces.settings', 'workspaces.setSetting', 'workspaces.resetSetting', 'workspaces.setGoverns', 'workspaces.setDefaultAgent', 'workspaces.setColor', 'workspaces.commitsSince', 'workspaces.locateRepo', 'workspaces.tynnBoard', 'workspaces.tynnBoardAction', 'workspaces.tynnIssues', 'workspaces.tynnIssueAction', 'workspaces.tynnPage', 'workspaces.tynnPageAction', 'files.children', 'files.open', 'files.readMedia', 'files.upload'];

export type AuthRequest =
    | { kind: 'pin'; code: string; label?: string }
    | { kind: 'token'; token: string; label?: string }
    /** Only the local window door may supply the corresponding transport proof. Never a device credential. */
    | { kind: 'local'; label?: string }
    /** Already authenticated by the TRANSPORT (the Tynn relay checked a grant and its key, Tynn #838): refused on any
     *  connection that carries no {@link PreAuth}, so a tailnet socket cannot claim it. */
    | { kind: 'relay'; label?: string }
    /** Only between a desktop window and its own host, which writes the token in (main/device-link-service.ts). Never reaches another machine. */
    | { kind: 'saved'; label?: string };

/** Who the admitting transport proved a connection to be: a relay grant or this host's own window door. */
export interface PreAuth {
    /** Omitted by existing relay transports. Only the local window door issues `local`. */
    readonly kind?: 'relay' | 'local';
    readonly label: string;
    readonly isOwner: boolean;
    /** The one workspace a guest may reach; `null` = the whole host. */
    readonly workspaceId: string | null;
    /** Reads only: every change is refused. */
    readonly readonly: boolean;
    /** Only with `kind: 'local'`: which window the door admitted. Absent = not known to be this machine's own (Tynn #578). */
    readonly window?: 'main' | 'remote';
}

/**
 * WHO A HOST CALL CAME FROM (host split P4, Tynn #578). Built by RemoteHost from what it admitted, never from anything
 * the caller says, and the only thing an origin-dependent rule may read.
 */
export interface CallContext {
    readonly connectionId: string;
    /** `local-window` is this machine's own window; a window driving another machine is `remote-window`, though it holds the door. */
    readonly origin: 'local-window' | 'remote-window' | 'device' | 'relay';
    readonly profile: 'mobile' | 'desktop';
    readonly isOwner: boolean;
    /** The one workspace this caller may reach; `null` = the whole host. */
    readonly workspaceId: string | null;
    readonly readonly: boolean;
    readonly label: string;
}

/** A call nobody vouched for: no owner, reads only, and a workspace id no workspace has (`null` would be the whole host). */
export const RESTRICTED_CALL_CONTEXT: CallContext = Object.freeze({ connectionId: '', origin: 'relay', profile: 'mobile', isOwner: false, workspaceId: '', readonly: true, label: 'an unidentified caller' });

/**
 * A context that crossed from genie-host to a window. Only a remote caller is ever forwarded, so one claiming this
 * machine's window, or that is not exactly a context, is treated as nobody's.
 */
export function forwardedCallContext(value: unknown): CallContext {
    if (value === null || typeof value !== 'object') return RESTRICTED_CALL_CONTEXT;
    const v = value as Record<string, unknown>;
    const keys = ['connectionId', 'origin', 'profile', 'isOwner', 'workspaceId', 'readonly', 'label'];
    if (Object.keys(v).length !== keys.length || !keys.every((k) => k in v)) return RESTRICTED_CALL_CONTEXT;
    if (v.origin !== 'remote-window' && v.origin !== 'device' && v.origin !== 'relay') return RESTRICTED_CALL_CONTEXT;
    if (v.profile !== 'mobile' && v.profile !== 'desktop') return RESTRICTED_CALL_CONTEXT;
    if (typeof v.connectionId !== 'string' || typeof v.label !== 'string' || typeof v.isOwner !== 'boolean' || typeof v.readonly !== 'boolean') return RESTRICTED_CALL_CONTEXT;
    if (v.workspaceId !== null && typeof v.workspaceId !== 'string') return RESTRICTED_CALL_CONTEXT;
    return { connectionId: v.connectionId, origin: v.origin, profile: v.profile, isOwner: v.isOwner, workspaceId: v.workspaceId as string | null, readonly: v.readonly, label: v.label };
}

/**
 * What kind of screen says hello (genie#1346). `mobile` is a phone: it receives the snapshot and the agents it watches,
 * never terminal bytes, and is refused terminals. Absent = another Genie's window, which hears everything, as before.
 */
export type ClientProfile = 'mobile';

export type WireMessage =
    /**
     * `companion` (Tynn #529 part A): the ticket a driving window's Take over was answered with — this connection is that
     * window's Take Over window, for that one terminal. Beside `auth`, never in it: a saved hello's auth is rewritten.
     */
    | { kind: 'hello'; auth: AuthRequest; label?: string; profile?: ClientProfile; companion?: string }
    | { kind: 'welcome'; connectionId: string; host: string; isOwner: boolean; workspaceId: string | null; token?: string; protocol?: number; build?: string }
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
    return parseFrame(text, isMethod);
}

/** One frame of the envelope over a method table `M`. `WireMessage` is `Frame` over the remote bridge's table. */
export type Frame<M extends string> =
    | Exclude<WireMessage, { kind: 'call' }>
    | { kind: 'call'; id: number; method: M; args: unknown[] };

/**
 * THE FRAME PARSER, for any method table (the host split, 2026-10-31): the remote bridge's table above, and the local
 * host's `engine.*` table (core/engine-protocol.ts). One envelope — hello, welcome, call, result, event — so the window's
 * link to its own host and a remote window's link to another Genie are the same protocol, validated the same way.
 */
export function parseFrame<M extends string>(text: string, isMethodOf: (m: unknown) => m is M): { ok: true; message: Frame<M> } | { ok: false; reason: string } {
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
                auth.kind === 'relay' || auth.kind === 'local';
            if (!okAuth) return { ok: false, reason: 'hello auth must be a pin {code}, a token {token}, relay or local' };
            if (raw.label !== undefined && typeof raw.label !== 'string') return { ok: false, reason: 'hello label must be a string' };
            if (raw.profile !== undefined && raw.profile !== 'mobile') return { ok: false, reason: 'hello profile must be "mobile" when given' };
            if (raw.companion !== undefined && typeof raw.companion !== 'string') return { ok: false, reason: 'hello companion must be a string when given' };
            return { ok: true, message: raw as unknown as Frame<M> };
        }
        case 'call': {
            if (typeof raw.id !== 'number' || typeof raw.method !== 'string' || !Array.isArray(raw.args)) {
                return { ok: false, reason: 'a call needs a numeric id, a method and an args array' };
            }
            if (!isMethodOf(raw.method)) return { ok: false, reason: `"${raw.method}" is not a bridge method` };
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
            return { ok: true, message: raw as unknown as Frame<M> };
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
export function filterSnapshotForWorkspace<T extends { agents?: readonly { workspaceId: string }[]; workspaces?: readonly { id: string }[] | null; hibernatedWorkspaces?: readonly { id: string }[]; deckItems?: readonly { workspaceId: string | null }[] | null }>(snapshot: T, workspaceId: string): T {
    return {
        ...snapshot,
        ...(snapshot.agents ? { agents: snapshot.agents.filter((a) => a.workspaceId === workspaceId) } : {}),
        ...(snapshot.workspaces ? { workspaces: snapshot.workspaces.filter((w) => w.id === workspaceId) } : {}),
        ...(snapshot.hibernatedWorkspaces ? { hibernatedWorkspaces: snapshot.hibernatedWorkspaces.filter((w) => w.id === workspaceId) } : {}),
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
    /** Set by the admitting transport. A local proof accepts only `local`; a relay proof accepts only `relay`. */
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

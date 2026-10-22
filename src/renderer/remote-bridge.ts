import type { ActivityFeed } from '../core/activity-feed.js';
import type { RepoListing } from '../core/github.js';
import { parseMessage, type AuthRequest, type ClientTransport, type ControlMethod, type RemoteMethod, type WireMessage } from '../core/remote-protocol.js';
import { NO_FILES, type AgentDetail, type GenieBridge, type GenieSnapshot, type UpdateState } from './bridge.js';
import type { FeatureData } from './features.js';

/**
 * THE REMOTE BRIDGE (§6.8) — a GenieBridge over a transport to another machine's RemoteHost.
 *
 * The App does not know it is remote except through `state()`: the host's name for the loud
 * `● REMOTE — <host>` badge, who is driving, whether this screen holds the baton, the lock, and the
 * LAST REFUSAL — the bridge's void methods (openAgent, prompt…) have nowhere else to put a host's
 * "take the baton". Events from the host are the bridge's subscriptions; nothing is polled.
 */

export interface RemoteState {
    readonly connected: boolean;
    readonly host: string | null;
    readonly isOwner: boolean;
    readonly workspaceId: string | null;
    readonly driver: string | null;
    readonly driving: boolean;
    readonly locked: boolean;
    readonly lastRefusal: string | null;
    /** Minted on a PIN pairing — the client keeps it for next time. */
    readonly token: string | null;
}

export interface RemoteClient {
    readonly bridge: GenieBridge;
    readonly ready: Promise<{ ok: true } | { ok: false; reason: string }>;
    state(): RemoteState;
    onState(listener: (state: RemoteState) => void): () => void;
    takeBaton(): Promise<{ ok: true } | { ok: false; reason: string }>;
    releaseBaton(): Promise<void>;
    refreshBaton(): Promise<void>;
    lock(): Promise<{ ok: true } | { ok: false; reason: string }>;
    unlock(): Promise<{ ok: true } | { ok: false; reason: string }>;
    close(): void;
}

type Result = { ok: true; value: unknown } | { ok: false; reason: string };

/**
 * What this machine lends a remote window. `browse`: Genie's browser on THIS machine, which main points at the host's
 * sites over the window's own relay connection (browser rebuild step 4) — given only where main can (a Tynn relay
 * window); the host's site names ride along for the address bar.
 */
export interface RemoteOptions {
    readonly browse?: (address: string | undefined, hosts: readonly string[]) => Promise<{ ok: true } | { ok: false; error: string }>;
}

export function connectRemote(transport: ClientTransport, auth: AuthRequest, label: string, options: RemoteOptions = {}): RemoteClient {
    let state: RemoteState = { connected: false, host: null, isOwner: false, workspaceId: null, driver: null, driving: false, locked: false, lastRefusal: null, token: null };
    const stateListeners = new Set<(s: RemoteState) => void>();
    const setState = (patch: Partial<RemoteState>) => {
        state = { ...state, ...patch };
        for (const l of stateListeners) l(state);
    };

    const pending = new Map<number, (r: Result) => void>();
    let nextId = 0;
    const events = new Map<string, Set<(payload: unknown) => void>>();
    const on = (channel: string, listener: (payload: unknown) => void): (() => void) => {
        const set = events.get(channel) ?? new Set();
        set.add(listener);
        events.set(channel, set);
        return () => { set.delete(listener); };
    };

    let resolveReady: (r: { ok: true } | { ok: false; reason: string }) => void = () => {};
    const ready = new Promise<{ ok: true } | { ok: false; reason: string }>((r) => { resolveReady = r; });

    transport.onMessage((text) => {
        const parsed = parseMessage(text);
        if (!parsed.ok) return;
        const m: WireMessage = parsed.message;
        switch (m.kind) {
            case 'welcome':
                setState({ connected: true, host: m.host, isOwner: m.isOwner, workspaceId: m.workspaceId, token: m.token ?? null });
                resolveReady({ ok: true });
                return;
            case 'refused':
                if (!state.connected) resolveReady({ ok: false, reason: m.reason });
                else setState({ lastRefusal: m.reason });
                return;
            case 'result': {
                const waiter = pending.get(m.id);
                pending.delete(m.id);
                waiter?.(m.ok ? { ok: true, value: m.value } : { ok: false, reason: m.reason });
                return;
            }
            case 'event':
                for (const l of events.get(m.channel) ?? []) l(m.payload);
                return;
            default:
                return;
        }
    });
    transport.onClose(() => {
        // A refused handshake arrives as a close with no welcome and no refused frame: say so, once.
        if (!state.connected) resolveReady({ ok: false, reason: 'the connection closed before the host answered — wrong address, or the host is not listening' });
        setState({ connected: false, driving: false });
        for (const waiter of pending.values()) waiter({ ok: false, reason: 'the connection closed' });
        pending.clear();
    });

    transport.send(JSON.stringify({ kind: 'hello', auth, label }));

    const call = (method: RemoteMethod | ControlMethod, ...args: unknown[]): Promise<Result> =>
        new Promise((resolve) => {
            const id = ++nextId;
            pending.set(id, resolve);
            transport.send(JSON.stringify({ kind: 'call', id, method, args }));
        });

    /** A read: the host's value, or a rejection with its reason. */
    const read = async <T>(method: RemoteMethod, ...args: unknown[]): Promise<T> => {
        const r = await call(method, ...args);
        if (!r.ok) throw new Error(r.reason);
        return r.value as T;
    };
    /** A void write: a refusal has nowhere to go but the state. */
    const fire = (method: RemoteMethod, ...args: unknown[]): void => {
        void call(method, ...args).then((r) => { if (!r.ok) setState({ lastRefusal: r.reason }); });
    };
    /** A write whose answer is itself an ok/reason shape: the host's refusal takes that shape. */
    const answer = async <T extends { ok: boolean }>(method: RemoteMethod, ...args: unknown[]): Promise<T | { ok: false; reason: string }> => {
        const r = await call(method, ...args);
        return r.ok ? (r.value as T) : { ok: false, reason: r.reason };
    };

    const refreshBaton = async (): Promise<void> => {
        const r = await call('baton.status');
        if (r.ok) {
            const s = r.value as { driver: string | null; mine: boolean; locked: boolean };
            setState({ driver: s.driver, driving: s.mine, locked: s.locked });
        }
    };

    const bridge: GenieBridge = {
        snapshot: () => read<GenieSnapshot>('snapshot'),
        subscribe: (onChange) => on('snapshot', (p) => onChange(p as GenieSnapshot)),
        // The Dashboard's lanes (beta.33 item 10): the host's feeds, read once and pushed after (a guest: its workspace's).
        activity: {
            feeds: (workspaceId) => read<Record<string, ActivityFeed>>('activity', workspaceId),
            subscribe: (onFeed) => on('activity', (p) => onFeed(p as ActivityFeed)),
        },
        agentDetail: (agentId) => read<AgentDetail | null>('agentDetail', agentId),
        subscribeAgent: (agentId, onChange) => on(`agent:${agentId}`, (p) => onChange(p as AgentDetail | null)),
        openAgent: (agentId) => fire('openAgent', agentId),
        stopAgent: (agentId) => fire('stopAgent', agentId),
        cancelTurn: (agentId) => answer<{ ok: true } | { ok: false; reason: string }>('cancelTurn', agentId),
        resumeLimit: (agentId) => answer<{ ok: true } | { ok: false; reason: string }>('resumeLimit', agentId),
        providerLogin: (agentId) => answer<{ ok: true } | { ok: false; reason: string }>('providerLogin', agentId),
        // The answer comes back to the caller (an undelivered draft is kept, §4.4) AND a host refusal (the lock, a
        // scope) still lands in `lastRefusal` as it did when this was fire-and-forget.
        // Files do not cross to a remote workstation yet: said, never dropped.
        prompt: (agentId, text, attachments) => attachments && attachments.length > 0
            ? Promise.resolve({ ok: false, reason: 'Files cannot be sent to an agent on another workstation yet' })
            : call('prompt', agentId, text).then((r) => {
            if (!r.ok) { setState({ lastRefusal: r.reason }); return { ok: false }; }
            return { ok: (r.value as { ok?: boolean } | null)?.ok === true };
        }),
        // The host's reply ends the answer's flight and a refusal is said on the card (core/approval-answering.ts).
        answerApproval: (agentId, optionId, note) => answer<{ ok: true }>('answerApproval', agentId, optionId, note ?? ''),
        restartWithHandoff: (agentId, finishedId) => answer<{ ok: true }>('restartWithHandoff', agentId, finishedId),
        addAgent: (workspaceId) => fire('addAgent', workspaceId),
        addWorkspace: () => fire('addWorkspace'),
        takeOver: (agentId) => answer<{ ok: true; terminalId: string }>('takeOver', agentId),
        workspaces: {
            previewAdd: (path) => answer('workspaces.previewAdd', path),
            confirmAdd: (path) => answer('workspaces.confirmAdd', path),
            create: (name, parent, remote, tynnProjectId) => answer('workspaces.create', name, parent, remote, tynnProjectId ?? ''),
            previewAddFromGit: (url, parent) => answer('workspaces.previewAddFromGit', url, parent),
            confirmAddFromGit: (url, parent) => answer('workspaces.confirmAddFromGit', url, parent),
            readSource: (path) => answer('workspaces.readSource', path),
            stageFromGit: (url) => answer('workspaces.stageFromGit', url),
            registerExisting: (path) => answer('workspaces.registerExisting', path),
            buildEnvelope: (plan, remote) => answer('workspaces.buildEnvelope', plan, remote),
            discardStaged: (path) => answer<{ ok: true }>('workspaces.discardStaged', path),
            // A refusal (an older host, or not the owner) reads as a failure in the host's words; the URL box still works.
            githubRepos: async (): Promise<RepoListing> => { const r = await call('workspaces.githubRepos'); return r.ok ? (r.value as RepoListing) : { status: 'failed', message: r.reason }; },
            tynnProjects: () => answer('workspaces.tynnProjects'),
            tynnOwnerOptions: () => answer('workspaces.tynnOwnerOptions'),
            createTynnProject: (input) => answer('workspaces.createTynnProject', input),
            importedAgents: (workspaceId) => answer('workspaces.importedAgents', workspaceId),
            adoptAgent: (workspaceId, name) => answer('workspaces.adoptAgent', workspaceId, name),
            previewAddFromTynn: (projectId, parent) => answer('workspaces.previewAddFromTynn', projectId, parent),
            confirmAddFromTynn: (parent, projectId) => answer('workspaces.confirmAddFromTynn', parent, projectId),
            hibernate: (workspaceId) => answer('workspaces.hibernate', workspaceId),
            wake: (workspaceId) => answer('workspaces.wake', workspaceId),
            remove: (workspaceId) => answer('workspaces.remove', workspaceId),
            listRepos: (workspaceId) => answer('workspaces.listRepos', workspaceId),
            addRepo: (workspaceId, input) => answer('workspaces.addRepo', workspaceId, input),
            removeRepo: (workspaceId, slug) => answer('workspaces.removeRepo', workspaceId, slug),
            removeRepoLock: (workspaceId, slug) => answer('workspaces.removeRepoLock', workspaceId, slug),
            locateRepo: (workspaceId, slug, path) => answer('workspaces.locateRepo', workspaceId, slug, path),
            commitsSince: (workspaceId, since) => answer('workspaces.commitsSince', workspaceId, since),
            settings: (workspaceId) => answer('workspaces.settings', workspaceId),
            setSetting: (workspaceId, key, value) => answer('workspaces.setSetting', workspaceId, key, value),
            resetSetting: (workspaceId, key) => answer('workspaces.resetSetting', workspaceId, key),
            setGoverns: (workspaceId, childIds) => answer('workspaces.setGoverns', workspaceId, [...childIds]),
            setDefaultAgent: (workspaceId, agentId) => answer('workspaces.setDefaultAgent', workspaceId, agentId),
        },
        agents: {
            restart: (agentId, kind) => answer('agents.restart', agentId, kind),
            previewDelete: (agentId, outcome, also) => answer('agents.previewDelete', agentId, outcome, [...also]),
            delete: (agentId, outcome, also) => answer('agents.delete', agentId, outcome, [...also]),
            switchDriver: (agentId, to) => answer('agents.switchDriver', agentId, to),
            setBudget: (agentId, usd) => answer('agents.setBudget', agentId, usd),
            setMode: (agentId, mode) => answer('agents.setMode', agentId, mode),
            setAccessScope: (agentId, scope) => answer('agents.setAccessScope', agentId, scope),
            setAutoApprove: (agentId, on) => answer('agents.setAutoApprove', agentId, on),
            setManageTabs: (agentId, on) => answer('agents.setManageTabs', agentId, on),
            setDrivePages: (agentId, on) => answer('agents.setDrivePages', agentId, on),
            setIssueWatch: (agentId, setting) => answer('agents.setIssueWatch', agentId, setting),
            setPermissions: (agentId, permissions) => answer('agents.setPermissions', agentId, permissions),
            setModel: (agentId, model) => answer('agents.setModel', agentId, model),
            models: (agentId, refresh) => answer('agents.models', agentId, refresh === true),
            diagnose: (agentId) => answer('agents.diagnose', agentId),
        },
        // The file panel is host-local today: a remote window gets the honest "no files host" rather than another machine's tree.
        files: NO_FILES,
        // A phone's upload (§6.8): the bytes ride the socket; the host copies them into the inbox and drops the temp file.
        uploads: { sendFile: (to, text, name, base64) => answer<{ ok: true; messageId: string }>('inbox.sendFile', to, text, name, base64) },
        terminals: {
            // Another machine's previous session is not this window's to seed.
            previousSession: async () => null,
            open: (workspaceId, options) => read('terminals.open', workspaceId, options),
            write: (id, data) => fire('terminals.write', id, data),
            resize: (id, cols, rows) => fire('terminals.resize', id, cols, rows),
            close: (id) => fire('terminals.close', id),
            list: (workspaceId) => read('terminals.list', workspaceId),
            // A remote connection names the workspace it is scoped to; a null here cannot join anything, by design.
            attach: (workspaceId, id) => read('terminals.attach', workspaceId ?? '', id),
            onData: (listener) => on('terminal-data', (p) => { const e = p as { id: string; data: string }; listener(e.id, e.data); }),
            onExit: (listener) => on('terminal-exit', (p) => { const e = p as { id: string; exitCode: number }; listener(e.id, e.exitCode); }),
        },
        features: {
            snapshot: () => read<FeatureData>('features.snapshot'),
            subscribe: (onChange) => on('features', (p) => onChange(p as FeatureData)),
            act: (action) => read<FeatureData>('features.act', action),
            // Nothing to place on a screen that is not the host's.
            setBrowserBounds: async () => {},
            // A remote window cannot reach the host's files to attach; it answers nothing picked.
            // Nor the host's sound files: the alert plays its own sound here.
            soundData: async () => null,
        },
        // The REMOTE host's disk, for every picker in this window (Tynn #835).
        host: { listDir: (path: string) => answer('host.listDir', path) as never, mkdir: (parent: string, name: string) => answer('host.mkdir', parent, name) as never },
        // The HOST's sites in Genie's browser: its site names read from the host, the window opened by main for this connection.
        ...(options.browse ? {
            browserWindow: {
                open: async (address?: string) => {
                    const browse = options.browse!;
                    let hosts: string[] = [];
                    try {
                        hosts = ((await read<FeatureData>('features.snapshot')).browser?.routes ?? []).map((route) => route.host);
                    } catch { /* the host would not say; the address bar just has no list */ }
                    return browse(address, hosts);
                },
            },
        } : {}),
        updates: {
            state: () => read<UpdateState>('updates.state'),
            subscribe: (onChange) => on('updates', (p) => onChange(p as UpdateState)),
            check: () => read<UpdateState>('updates.check'),
            download: () => read<boolean>('updates.download'),
            install: () => read<{ report: string } | null>('updates.install'),
        },
    };

    const control = async (method: ControlMethod): Promise<{ ok: true } | { ok: false; reason: string }> => {
        const r = await call(method);
        await refreshBaton();
        return r.ok ? { ok: true } : { ok: false, reason: r.reason };
    };

    return {
        bridge,
        ready,
        state: () => state,
        onState: (l) => { stateListeners.add(l); return () => { stateListeners.delete(l); }; },
        takeBaton: () => control('baton.take'),
        releaseBaton: async () => { await control('baton.release'); },
        refreshBaton,
        lock: () => control('host.lock'),
        unlock: () => control('host.unlock'),
        close: () => transport.close(),
    };
}

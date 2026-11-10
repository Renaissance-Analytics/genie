import type { ActivityFeed } from '../core/activity-feed.js';
import { localTerminalClient } from './local-terminal-client.js';
import type { Headroom } from '../core/headroom.js';
import type { RepoListing } from '../core/github.js';
import type { TynnWatchEvent, TynnWatchKind } from '../core/local-tynn-watch.js';
import { LOCAL_FRAME_LIMIT_BYTES } from '../core/local-frame.js';
import type { AgentPushPayload } from '../core/agent-push-wire.js';
import { BATON_EVENT, COMPANION_EVENT, LOCAL_EVENTS, parseMessage, type BatonEvent, type CompanionEvent, type AuthRequest, type ClientTransport, type ControlMethod, type RemoteMethod, type WireMessage } from '../core/remote-protocol.js';
import { NO_FILES, type AgentDetail, type GenieBridge, type GenieSnapshot, type UpdateState } from './bridge.js';
import type { FeatureAction, FeatureData } from './features.js';
import { bytesToBase64 } from '../core/mobile.js';
import { BATON_REFUSAL } from '../core/remote.js';
import { UPLOAD_CHUNK_BYTES, WindowReceiver, type WindowCursor, type WindowRows } from '../core/mobile-wire.js';
import type { TimedEvent } from '../core/stream-view.js';
import type { BlobClient, BlobInfo, BlobChunk } from '../core/local-blobs.js';
import { verifiedBlobClient } from './blob-reader.js';
import type { LocalUploadClient, LocalUploadInfo, PageClient, MetadataPage } from '../core/local-content.js';
import { heldLimiter, localPageClient, localUploadClient } from './local-content-client.js';
import { filesContentReader, localFilesClient } from './local-files-client.js';
import { localFilesWatchClient } from './local-files-watch-client.js';
import { localDraftsClient } from './local-drafts-client.js';
import { localArtboardClient } from './local-artboard-client.js';

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
    /** The last refusal was for lack of the baton: the window offers Take control beside it (Tynn #529). */
    readonly needsBaton?: boolean;
    /** Who took control from this window, until it drives again (Tynn #529); `null` otherwise. */
    readonly batonLostTo?: string | null;
    /** Minted on a PIN pairing — the client keeps it for next time. */
    readonly token: string | null;
    /** The PIN was right and the host's screen asks "Pair this device?" until `expiresAt` (q_8c07b142); `null` otherwise. */
    readonly pairing?: { readonly expiresAt: number } | null;
}

export interface RemoteClient {
    /** Local connection resources, not yet consumed by a family bridge. */
    readonly blobs?: BlobClient;
    readonly uploads?: LocalUploadClient;
    readonly pages?: PageClient;
    /** Only a local-auth client offers these partial groups, composed with native window ports by pageBridge. */
    readonly localOwner?: import('./bridge.js').LocalOwnerBridge;
    /** Only a local-auth client: an agent's patches, for the agents this window's views show (Tynn #564). */
    readonly agentWire?: (agentId: string, onPayload: (payload: AgentPushPayload<Omit<AgentDetail, 'rows'>, TimedEvent>) => void) => () => void;
    /** Share links on the host this client is connected to (Tynn #587): that host makes them, for itself. */
    readonly shares: NonNullable<import('./relay-transport.js').TynnNetworkBridge['shares']>;
    readonly bridge: GenieBridge;
    readonly ready: Promise<{ ok: true } | { ok: false; reason: string }>;
    state(): RemoteState;
    onState(listener: (state: RemoteState) => void): () => void;
    /** `force`: Take control from whoever drives (Tynn #529); without it, a take never takes control from someone driving. */
    takeBaton(options?: { force?: boolean }): Promise<{ ok: true } | { ok: false; reason: string }>;
    releaseBaton(): Promise<void>;
    /** The person has read the last refusal. */
    clearRefusal(): void;
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
    /**
     * A PHONE (genie#1346): hello as `mobile`, so the host sends the snapshot and the agents this screen watches — as a
     * window of the ledger, then patches — and never terminal bytes. Files read through the host and upload in chunks; a
     * prompt's photos cross as chunks too.
     */
    readonly profile?: 'mobile';
    /** The phone's agent windows, kept ACROSS connections so the next one resumes from a cursor (`AgentWindows`). */
    readonly windows?: AgentWindows;
    /**
     * A WINDOW THAT DRIVES (Tynn #529): take the baton the moment the host welcomes it, so a Pilot connecting to its drone
     * has full control with no extra step. Someone else driving is never taken from silently: the window is told who.
     */
    readonly drive?: boolean;
    /**
     * A TAKE OVER WINDOW (Tynn #529 part A): the ticket the driving window's Take over was answered with. This connection
     * types into that one terminal while that window drives, and is told why when it may not any more. Never `drive`.
     */
    readonly companion?: string;
}

/**
 * WHAT THE PHONE HOLDS OF EACH AGENT IT HAS WATCHED (genie#1346): its ledger window, outliving any one connection — a
 * socket that dropped (the phone slept, it changed networks) is replaced by a new one that asks the host only for what
 * came after the cursor.
 */
export class AgentWindows {
    readonly #receivers = new Map<string, WindowReceiver<TimedEvent>>();

    receiver(agentId: string): WindowReceiver<TimedEvent> {
        let r = this.#receivers.get(agentId);
        if (!r) { r = new WindowReceiver<TimedEvent>(); this.#receivers.set(agentId, r); }
        return r;
    }

    cursor(agentId: string): WindowCursor | null {
        return this.#receivers.get(agentId)?.cursor() ?? null;
    }

    /** How the last push for an agent was based (`null` whole, a number a patch, `'resume'` a cursor). */
    lastBase(agentId: string): WindowRows<TimedEvent>['base'] | undefined {
        return this.#receivers.get(agentId)?.lastBase();
    }
}

/** One push to a phone for one agent: its detail without rows, and the rows as a window patch. */
interface PhonePush {
    readonly seq: number;
    readonly detail: Omit<AgentDetail, 'rows'> | null;
    readonly rows: WindowRows<TimedEvent>;
}

export function connectRemote(transport: ClientTransport, auth: AuthRequest, label: string, options: RemoteOptions = {}): RemoteClient {
    let terminalClient: ReturnType<typeof localTerminalClient> | undefined;
    let filesWatches: ReturnType<typeof localFilesWatchClient> | undefined;
    let state: RemoteState = { connected: false, host: null, isOwner: false, workspaceId: null, driver: null, driving: false, locked: false, lastRefusal: null, needsBaton: false, batonLostTo: null, token: null, pairing: null };
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
                setState({ connected: true, host: m.host, isOwner: m.isOwner, workspaceId: m.workspaceId, token: m.token ?? null, pairing: null });
                resolveReady({ ok: true });
                // A window that drives hears who drives, and drives at once (Tynn #529). Others ask nothing more than before.
                if (options.drive === true && options.companion === undefined && auth.kind !== 'local') {
                    void call('baton.watch');
                    void control('baton.take');
                }
                return;
            case 'pairing':
                setState({ pairing: { expiresAt: m.expiresAt } });
                return;
            case 'refused':
                if (state.pairing) setState({ pairing: null });
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
        filesWatches?.dispose();
        terminalClient?.dispose();
        // A refused handshake arrives as a close with no welcome and no refused frame: say so, once.
        if (!state.connected) resolveReady({ ok: false, reason: 'the connection closed before the host answered — wrong address, or the host is not listening' });
        setState({ connected: false, driving: false });
        for (const waiter of pending.values()) waiter({ ok: false, reason: 'the connection closed' });
        pending.clear();
    });

    transport.send(JSON.stringify({ kind: 'hello', auth, label, ...(options.profile ? { profile: options.profile } : {}), ...(options.companion ? { companion: options.companion } : {}) }));

    /** A refusal for the person to see; one for lack of the baton says Take control is what it needs. */
    const refused = (reason: string): void => setState({ lastRefusal: reason, needsBaton: reason.endsWith(BATON_REFUSAL) });
    const call = (method: RemoteMethod | ControlMethod, ...args: unknown[]): Promise<Result> =>
        new Promise<Result>((resolve) => {
            const id = ++nextId;
            pending.set(id, resolve);
            transport.send(JSON.stringify({ kind: 'call', id, method, args }));
        }).then((r) => {
            // Every write refused for lack of the baton is kept, whatever path asked: no dead click (Tynn #529).
            if (!r.ok && r.reason.endsWith(BATON_REFUSAL)) refused(r.reason);
            return r;
        });

    /** A read: the host's value, or a rejection with its reason. */
    const read = async <T>(method: RemoteMethod | ControlMethod, ...args: unknown[]): Promise<T> => {
        const r = await call(method, ...args);
        if (!r.ok) throw new Error(r.reason);
        return r.value as T;
    };
    /** A void write: a refusal has nowhere to go but the state. */
    const fire = (method: RemoteMethod, ...args: unknown[]): void => {
        void call(method, ...args).then((r) => { if (!r.ok) refused(r.reason); });
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
            setState({ driver: s.driver, driving: s.mine, locked: s.locked, ...(s.mine ? { batonLostTo: null } : {}) });
        }
    };

    const phone = options.profile === 'mobile';
    const local = auth.kind === 'local';
    let activityView = 0;
    const windows = options.windows ?? new AgentWindows();

    /** Bytes staged on the host in chunks under the socket's frame cap; the id a call then names (`{ staged: id }`). */
    const stage = async (name: string, bytes: Uint8Array, onProgress?: (sent: number, total: number) => void): Promise<{ ok: true; id: string } | { ok: false; reason: string }> => {
        const begun = await call('upload.begin', { name, size: bytes.byteLength });
        if (!begun.ok) return begun;
        const id = (begun.value as { id: string }).id;
        for (let i = 0, at = 0; at < bytes.byteLength; i++, at += UPLOAD_CHUNK_BYTES) {
            const r = await call('upload.chunk', id, i, bytesToBase64(bytes.subarray(at, at + UPLOAD_CHUNK_BYTES)));
            if (!r.ok) { void call('upload.abort', id); return r; }
            onProgress?.(Math.min(bytes.byteLength, at + UPLOAD_CHUNK_BYTES), bytes.byteLength);
        }
        return { ok: true, id };
    };

    /** A phone's push applied to its window: the whole detail, `null` for no such agent, or `undefined` = ask again. */
    const applyPush = (agentId: string, push: PhonePush): AgentDetail | null | undefined => {
        const receiver = windows.receiver(agentId);
        if (push.detail === null) { receiver.reset(); return null; }
        const rows = receiver.apply(push.seq, push.rows);
        return rows === undefined ? undefined : ({ ...push.detail, rows } as AgentDetail);
    };
    /** Open (or re-open) this connection's window on an agent, resuming from what the phone already holds. */
    const watch = async (agentId: string): Promise<AgentDetail | null> => {
        const cursor = windows.cursor(agentId);
        const r = await call('agent.watch', agentId, cursor ? { resume: cursor } : {});
        if (!r.ok) throw new Error(r.reason);
        const detail = applyPush(agentId, r.value as PhonePush);
        if (detail !== undefined) return detail;
        // The cursor did not fit what is held here: start this agent over from a fresh tail.
        windows.receiver(agentId).reset();
        const fresh = await call('agent.watch', agentId, {});
        if (!fresh.ok) throw new Error(fresh.reason);
        return applyPush(agentId, fresh.value as PhonePush) ?? null;
    };
    const watchers = new Map<string, number>();

    // Native type guards can see bigint or cyclic objects. Keep their refusal order on the host,
    // and send only string slots (or null), without serializing an invalid object's contents.
    const ownerText = (value: unknown): string | null => typeof value === 'string' ? value : null;
    const localOwner: import('./bridge.js').LocalOwnerBridge | undefined = local ? {
        appInbox: {
            state: (id) => read('appInbox.state', ownerText(id)),
            createKey: (id, name) => read('appInbox.createKey', ownerText(id), ownerText(name)),
            revokeKey: (id, key) => read('appInbox.revokeKey', ownerText(id), ownerText(key)),
            source: (id, op, kind, source) => read('appInbox.source', ownerText(id), ownerText(op), ownerText(kind), ownerText(source)),
        },
        deviceLink: {
            hosts: () => read('deviceLink.hosts'),
            forget: (url) => read('deviceLink.forget', ownerText(url)),
            adopt: (url, token) => read('deviceLink.adopt', ownerText(url), ownerText(token)),
        },
        tynnNetwork: {
            workstations: () => read('tynnNetwork.workstations'),
            setRole: (id, role, code) => read('tynnNetwork.setRole', ownerText(id), ownerText(role), ownerText(code)),
            shares: {
                list: (id) => read('tynnNetwork.shares.list', ownerText(id)),
                mint: (input) => {
                    // The native handler read exactly these fields; unrelated object contents never reached mintShareLink.
                    const i = (input ?? {}) as { workspaceId?: unknown; capability?: unknown; expiresInDays?: unknown };
                    return read('tynnNetwork.shares.mint', { workspaceId: ownerText(i.workspaceId),
                        capability: i.capability === 'readonly' ? 'readonly' : 'control', expiresInDays: typeof i.expiresInDays === 'number' ? i.expiresInDays : 7 });
                },
                revoke: (id) => read('tynnNetwork.shares.revoke', ownerText(id)),
            },
        },
    } : undefined;
    const bridge: GenieBridge = {
        snapshot: () => read<GenieSnapshot>('snapshot'),
        subscribe: (onChange) => on('snapshot', (p) => onChange(p as GenieSnapshot)),
        // The Dashboard's lanes (beta.33 item 10): the host's feeds, read once and pushed after (a guest: its workspace's).
        activity: {
            feeds: (workspaceId) => read<Record<string, ActivityFeed>>('activity', workspaceId),
            subscribe: (onFeed) => {
                if (!local) return on('activity', (p) => onFeed(p as ActivityFeed));
                const viewId = `activity-${++activityView}`;
                const off = on(LOCAL_EVENTS.activity, (p) => onFeed(p as ActivityFeed));
                void call('activity.watch', viewId).then((r) => { if (!r.ok) setState({ lastRefusal: r.reason }); });
                let live = true;
                return () => {
                    if (!live) return;
                    live = false; off();
                    void call('activity.unwatch', viewId).then((r) => { if (!r.ok) setState({ lastRefusal: r.reason }); });
                };
            },
        },
        ...(local ? {
            accountRetry: (agentId: string) => answer<{ ok: true } | { ok: false; reason: string }>('accountRetry', agentId),
            onHeadroom: (listener: (room: Readonly<Record<string, Headroom>>) => void) => {
                let live = true;
                const off = on(LOCAL_EVENTS.headroom, (p) => listener(p as Readonly<Record<string, Headroom>>));
                // Native subscriptions also read once, and ignore an unavailable initial read.
                void read<Readonly<Record<string, Headroom>>>('headroom').then((room) => { if (live) listener(room); }, () => {});
                return () => { live = false; off(); };
            },
        } : {}),
        agentDetail: (agentId) => (phone ? watch(agentId) : read<AgentDetail | null>('agentDetail', agentId)),
        subscribeAgent: (agentId, onChange) => {
            if (!phone) return on(`agent:${agentId}`, (p) => onChange(p as AgentDetail | null));
            // The phone's window: patches applied to what it holds; one it cannot place re-opens the window.
            const off = on(`agent:${agentId}`, (p) => {
                const detail = applyPush(agentId, p as PhonePush);
                if (detail === undefined) { void watch(agentId).then(onChange, () => {}); return; }
                onChange(detail);
            });
            const count = (watchers.get(agentId) ?? 0) + 1;
            watchers.set(agentId, count);
            // Watched already (agentDetail opened it) — or opened now, for a subscriber that came first.
            if (count === 1 && windows.receiver(agentId).rows() === null) void watch(agentId).then(onChange, () => {});
            return () => {
                off();
                const left = (watchers.get(agentId) ?? 1) - 1;
                if (left > 0) { watchers.set(agentId, left); return; }
                watchers.delete(agentId);
                if (state.connected) void call('agent.unwatch', agentId);
            };
        },
        openAgent: (agentId) => fire('openAgent', agentId),
        stopAgent: (agentId) => fire('stopAgent', agentId),
        cancelTurn: (agentId, intent) => answer<{ ok: true } | { ok: false; reason: string }>('cancelTurn', agentId, intent),
        resumeLimit: (agentId) => answer<{ ok: true } | { ok: false; reason: string }>('resumeLimit', agentId),
        providerLogin: (agentId) => answer<{ ok: true } | { ok: false; reason: string }>('providerLogin', agentId),
        // The answer comes back to the caller (an undelivered draft is kept, §4.4) AND a host refusal (the lock, a
        // scope) still lands in `lastRefusal` as it did when this was fire-and-forget.
        // Files do not cross to a remote workstation yet: said, never dropped.
        prompt: (agentId, text, attachments) => attachments && attachments.length > 0
            // Files cross as staged BYTES from any remote window — a phone's camera or a desktop's picked file — never a path
            // on the host (genie#1356 refuses those): the host hands them to the composer's own attach path.
            ? promptWithFiles(agentId, text, attachments)
            : call('prompt', agentId, text).then((r) => {
            if (!r.ok) { setState({ lastRefusal: r.reason }); return { ok: false }; }
            return { ok: (r.value as { ok?: boolean } | null)?.ok === true };
        }),
        resolvePrompt: (agentId, promptId, action) => answer<{ ok: true }>('resolvePrompt', agentId, promptId, action),
        // The host's reply ends the answer's flight and a refusal is said on the card (core/approval-answering.ts).
        answerApproval: (agentId, optionId, note) => answer<{ ok: true }>('answerApproval', agentId, optionId, note ?? ''),
        restartWithHandoff: (agentId, finishedId) => answer<{ ok: true }>('restartWithHandoff', agentId, finishedId),
        addAgent: (workspaceId, input) => answer<{ ok: true; id: string }>('addAgent', workspaceId, input),
        addWorkspace: () => fire('addWorkspace'),
        // A Take over the host refused is said to the person, never dropped (Tynn #529).
        takeOver: async (agentId) => {
            const r = await answer<{ ok: true; terminalId: string }>('takeOver', agentId);
            if (!r.ok) refused(r.reason);
            return r;
        },
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
            ...(auth.kind === 'local' ? { onSettingsChanged: (listener: (id: string) => void) => on('workspace-settings-changed', (id) => listener(id as string)) } : {}),
            setGoverns: (workspaceId, childIds) => answer('workspaces.setGoverns', workspaceId, [...childIds]),
            setDefaultAgent: (workspaceId, agentId) => answer('workspaces.setDefaultAgent', workspaceId, agentId),
            setColor: (workspaceId, color) => answer('workspaces.setColor', workspaceId, color),
        },
        agents: {
            restart: (agentId, kind) => answer('agents.restart', agentId, kind),
            previewDelete: (agentId, outcome, also) => answer('agents.previewDelete', agentId, outcome, [...also]),
            delete: (agentId, outcome, also, handoff) => answer('agents.delete', agentId, outcome, [...also], handoff === true),
            switchDriver: (agentId, to) => answer('agents.switchDriver', agentId, to),
            setBudget: (agentId, usd) => {
                // JSON arrays would turn these into null, which means an explicit clear.
                if (usd === undefined || (typeof usd === 'number' && !Number.isFinite(usd))) return Promise.resolve({ ok: false, reason: 'a budget is a finite non-negative number of dollars, or null to clear it' });
                return answer('agents.setBudget', agentId, usd);
            },
            setMode: (agentId, mode) => answer('agents.setMode', agentId, mode),
            setAccessScope: (agentId, scope) => answer('agents.setAccessScope', agentId, scope),
            setAccessAgents: (agentId, ids) => answer('agents.setAccessAgents', agentId, ids),
            setAutoApprove: (agentId, on) => answer('agents.setAutoApprove', agentId, on),
            setManageTabs: (agentId, on) => answer('agents.setManageTabs', agentId, on),
            setDrivePages: (agentId, on) => answer('agents.setDrivePages', agentId, on),
            setIssueWatch: (agentId, setting) => answer('agents.setIssueWatch', agentId, setting),
            setPermissions: (agentId, permissions) => answer('agents.setPermissions', agentId, permissions),
            setModel: (agentId, model) => model === undefined
                ? Promise.resolve({ ok: false, reason: 'a model is a name, or null for the provider default' })
                : answer('agents.setModel', agentId, model),
            models: (agentId, refresh) => answer('agents.models', agentId, refresh === true),
            diagnose: (agentId) => answer('agents.diagnose', agentId),
            toolOutput: (agentId, toolCallId) => answer('agents.toolOutput', agentId, toolCallId),
        },
        // The file panel is host-local today: a remote window gets the honest "no files host" rather than another machine's tree.
        files: phone ? {
            ...NO_FILES,
            children: (workspaceId, dir) => read('files.children', workspaceId, dir),
            open: (workspaceId, path) => answer('files.open', workspaceId, path).then((r) => ('reason' in r && !('path' in r) ? { ok: false as const, path, error: (r as { reason: string }).reason } : r)) as never,
            readMedia: (workspaceId, path) => answer('files.readMedia', workspaceId, path).then((r) => ('reason' in r && !('path' in r) ? { ok: false as const, path, error: (r as { reason: string }).reason } : r)) as never,
            upload: async (workspaceId, dir, name, bytes, onProgress) => {
                const staged = await stage(name, bytes, onProgress);
                if (!staged.ok) return staged;
                return answer('files.upload', workspaceId, dir, { staged: staged.id }) as never;
            },
        } : { ...NO_FILES },
        // A phone's upload (§6.8): the bytes ride the socket; the host copies them into the inbox and drops the temp file.
        uploads: { sendFile: (to, text, name, base64) => answer<{ ok: true; messageId: string }>('inbox.sendFile', to, text, name, base64) },
        terminals: {
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
        // Its home too (Tynn #527): a picker that opened at THIS machine's home asked the remote for a path it does not have.
        host: { listDir: (path: string) => answer('host.listDir', path) as never, mkdir: (parent: string, name: string) => answer('host.mkdir', parent, name) as never, home: () => read<string>('host.home') },
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
            subscribe: (onChange) => on(local ? LOCAL_EVENTS.updates : 'updates', (p) => onChange(p as UpdateState)),
            check: () => read<UpdateState>('updates.check'),
            download: () => read<boolean>('updates.download'),
            install: () => read<{ report: string } | null>('updates.install'),
            ...(local ? { notes: () => read<UpdateState | null>('updates.notes') } : {}),
        },
    };

    /** A phone's message with photos/files: each staged in chunks, then the prompt names them (genie#1346). */
    async function promptWithFiles(agentId: string, text: string, attachments: readonly { name: string; type: string; bytes: Uint8Array }[]): Promise<{ ok: boolean; reason?: string }> {
        const refs: Array<{ staged: string; type: string }> = [];
        for (const a of attachments) {
            const staged = await stage(a.name, a.bytes);
            if (!staged.ok) return { ok: false, reason: `${a.name}: ${staged.reason}` };
            refs.push({ staged: staged.id, type: a.type });
        }
        const r = await call('prompt', agentId, text, refs);
        if (!r.ok) { setState({ lastRefusal: r.reason }); return { ok: false, reason: r.reason }; }
        const v = r.value as { ok?: boolean; reason?: string } | null;
        return v?.ok === true ? { ok: true } : { ok: false, ...(v?.reason ? { reason: v.reason } : {}) };
    }

    const control = async (method: ControlMethod, ...args: unknown[]): Promise<{ ok: true } | { ok: false; reason: string }> => {
        const r = await call(method, ...args);
        await refreshBaton();
        // Driving now: the refusal that asked for the baton is answered.
        if (r.ok && method === 'baton.take' && state.needsBaton) setState({ lastRefusal: null, needsBaton: false });
        return r.ok ? { ok: true } : { ok: false, reason: r.reason };
    };
    // A Take Over window's ticket stopped letting it type: why, for the person to see (Tynn #529 part A).
    on(COMPANION_EVENT, (payload) => { refused((payload as CompanionEvent).revoked); });
    // Who drives, pushed by the host when something this window did not do changed it (Tynn #529).
    on(BATON_EVENT, (payload) => {
        const e = payload as BatonEvent;
        const lostTo = state.driving && !e.mine && e.by !== null ? e.by : e.mine ? null : (state.batonLostTo ?? null);
        setState({ driver: e.driver, driving: e.mine, locked: e.locked, batonLostTo: lostTo });
    });

    const blobRead = async <T>(method: ControlMethod | RemoteMethod, ...args: unknown[]): Promise<T> => {
        const started = await ready;
        if (!started.ok) throw new Error(started.reason);
        if (!state.connected) throw new Error('the blob connection closed');
        return read<T>(method, ...args);
    };
    const blobs = local ? verifiedBlobClient({
        open: (kind, ref) => blobRead<BlobInfo>('blob.open', kind, ref),
        read: (id, offset, length) => blobRead<BlobChunk>('blob.read', id, offset, length),
        // Disconnect already releases the server's resources; never wait on a closed frame stream.
        close: id => state.connected ? blobRead<{ closed: boolean }>('blob.close', id) : Promise.resolve({ closed: false }),
    }) : undefined;
    const uploads = local ? localUploadClient({
        begin: input => blobRead<LocalUploadInfo>('localUpload.begin', input),
        chunk: (id, index, base64) => blobRead<{ received: number }>('localUpload.chunk', id, index, base64),
        abort: id => state.connected ? blobRead<{ aborted: boolean }>('localUpload.abort', id) : Promise.resolve({ aborted: false }),
    }) : undefined;
    const pages = local ? localPageClient({
        open: (kind, ref) => blobRead<MetadataPage>('page.open', kind, ref),
        next: cursor => blobRead<MetadataPage>('page.next', cursor),
        close: cursor => state.connected ? blobRead<{ closed: boolean }>('page.close', cursor) : Promise.resolve({ closed: false }),
    }) : undefined;
    let agentWire: RemoteClient['agentWire'];
    if (local) {
        bridge.gapps = {
            list: () => read('gapps.list'),
            review: (folder) => read('gapps.review', folder),
            install: (folder, options) => read('gapps.install', folder, options),
            setOn: async (id, on) => { await read('gapps.setOn', id, on); },
            uninstall: async (id) => { await read('gapps.uninstall', id); },
            open: async (id) => { await read('gapps.open', id); },
        };
        bridge.marketplace = {
            search: (query, cursor) => cursor === undefined ? read('marketplace.search', query) : read('marketplace.search', query, cursor),
            prepare: (id, version) => read('marketplace.prepare', id, version),
            install: (token, consent) => read('marketplace.install', token, consent),
            discard: async token => { await read('marketplace.discard', token); },
        };
        // ONE limiter for every family on this connection: together they never ask the host to hold more than it can (Tynn #547).
        const limit = heldLimiter();
        /*
         * THE FEATURE SNAPSHOT (P4 family 11, Tynn #560): it has no bound of its own, so it crosses inline when small and
         * as one blob when not; a change is pushed as a revision, and the window re-reads: one read at a time, the latest last.
         */
        const decodeJson = <T>(read0: () => Promise<unknown>): Promise<T> => limit(async () => {
            const result = await read0();
            if (!result || typeof result !== 'object' || !('jsonContent' in result)) return result as T;
            const content = (result as { jsonContent: { ref: string; blob: string } }).jsonContent;
            try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await blobs!.readAll('features-json', content.blob))) as T; }
            finally { await blobRead('content.release', content.ref); }
        });
        const snapshotNow = (): Promise<FeatureData> => decodeJson<FeatureData>(() => read('features.snapshot'));
        // A frame over the door's cap would end this window's connection, so a call that large is refused here, with a reason.
        const tooLargeForFrame = (args: readonly unknown[]): boolean => new TextEncoder().encode(JSON.stringify(args)).length > LOCAL_FRAME_LIMIT_BYTES - 4 * 1024;
        /*
         * P4 FAMILY 9A (Tynn #564): the snapshot and an agent's detail cross inline when small and as one blob when not. The
         * snapshot's push is inline when it fits a frame, else a revision the window re-reads; a subscribe reads at once.
         */
        const snapshotNow2 = (): Promise<GenieSnapshot> => decodeJson<GenieSnapshot>(() => read('snapshot'));
        const snapshotListeners = new Set<(snapshot: GenieSnapshot) => void>();
        let snapshotInline = 0, snapshotBusy = false, snapshotAgain = false;
        const rereadSnapshot = async (): Promise<void> => {
            if (snapshotBusy) { snapshotAgain = true; return; }
            snapshotBusy = true;
            try {
                do {
                    snapshotAgain = false;
                    const started = snapshotInline;
                    const snapshot = await snapshotNow2();
                    // A newer one came inline while this was read: that one stands.
                    if (started === snapshotInline) for (const listener of [...snapshotListeners]) listener(snapshot);
                } while (snapshotAgain);
            } catch (error) {
                console.warn(`[genie] the snapshot could not be read: ${error instanceof Error ? error.message : String(error)}`);
            } finally { snapshotBusy = false; }
        };
        on(LOCAL_EVENTS.snapshot, (raw) => {
            const event = raw as { snapshot?: GenieSnapshot };
            if (event.snapshot === undefined) { if (snapshotListeners.size > 0) void rereadSnapshot(); return; }
            snapshotInline += 1;
            for (const listener of [...snapshotListeners]) listener(event.snapshot);
        });
        Object.assign(bridge, {
            snapshot: snapshotNow2,
            subscribe: (listener: (snapshot: GenieSnapshot) => void) => { snapshotListeners.add(listener); void rereadSnapshot(); return () => { snapshotListeners.delete(listener); }; },
            agentDetail: (agentId: string) => decodeJson<AgentDetail | null>(() => read('agentDetail', agentId)),
        });
        // One order per agent: a blob read at the front never lets a later patch overtake it.
        type LocalAgentPayload = AgentPushPayload<Omit<AgentDetail, 'rows'>, TimedEvent>;
        const wires = new Map<string, Set<(payload: LocalAgentPayload) => void>>();
        const orders = new Map<string, Promise<void>>();
        on(LOCAL_EVENTS.agent, (raw) => {
            const { agentId, payload } = raw as { agentId: string; payload: unknown };
            orders.set(agentId, (orders.get(agentId) ?? Promise.resolve()).then(async () => {
                const value = await decodeJson<LocalAgentPayload>(async () => payload);
                for (const listener of [...(wires.get(agentId) ?? [])]) listener(value);
            }).catch((error: unknown) => { console.warn(`[genie] an agent's detail could not be read: ${error instanceof Error ? error.message : String(error)}`); }));
        });
        agentWire = (agentId, onPayload) => {
            let set = wires.get(agentId);
            if (set === undefined) { set = new Set(); wires.set(agentId, set); }
            set.add(onPayload);
            // Watching (again) starts with the whole ledger, to every subscriber: one joining late holds no rows to patch.
            void call('agent.watch', agentId);
            return () => {
                const held = wires.get(agentId);
                if (!held) return;
                held.delete(onPayload);
                if (held.size > 0) return;
                wires.delete(agentId);
                orders.delete(agentId);
                if (state.connected) void call('agent.unwatch', agentId);
            };
        };
        // P4 family 9b (Tynn #563): the composer keeps a host's reason (a slash command the agent does not offer, Tynn #440).
        Object.assign(bridge, {
            prompt: (agentId: string, text: string, attachments?: readonly { name: string; type: string; bytes: Uint8Array }[]) => (attachments && attachments.length > 0
                ? promptWithFiles(agentId, text, attachments)
                : answer<{ ok: boolean; reason?: string }>('prompt', agentId, text)),
        });
        const featureListeners = new Set<(data: FeatureData) => void>();
        let rereading = false, again = false;
        const reread = async (): Promise<void> => {
            if (rereading) { again = true; return; }
            rereading = true;
            try {
                do {
                    again = false;
                    const data = await snapshotNow();
                    for (const listener of [...featureListeners]) listener(data);
                } while (again);
            } catch (error) {
                // The next change reads again; a connection that went is said by the session.
                console.warn(`[genie] the feature snapshot could not be read: ${error instanceof Error ? error.message : String(error)}`);
            } finally { rereading = false; }
        };
        on(LOCAL_EVENTS.features, () => { if (featureListeners.size > 0) void reread(); });
        Object.assign(bridge.features, {
            snapshot: snapshotNow,
            // Reads at once: a subscribe is also a window coming back, and a revision sent while it was away is not sent again.
            subscribe: (listener: (data: FeatureData) => void) => { featureListeners.add(listener); void reread(); return () => { featureListeners.delete(listener); }; },
            soundData: (key: string) => decodeJson<string | null>(() => read('features.soundData', key)),
            // P4 (Tynn #560): an action and its result. The limiter holds only a result that came as a blob: an action can take long.
            act: async (action: FeatureAction) => {
                if (tooLargeForFrame([action])) throw new Error('this is too large to send to Genie in one piece');
                const result = await read<unknown>('features.act', action);
                if (!result || typeof result !== 'object' || !('jsonContent' in result)) return result as FeatureData;
                return decodeJson<FeatureData>(async () => result);
            },
            picked: async (paths: readonly string[]) => {
                if (tooLargeForFrame([paths])) throw new Error('too many files were picked to report in one piece');
                await read('features.picked', paths);
            },
        });
        terminalClient = localTerminalClient({ read: blobRead, release: ref => blobRead('content.release', ref), blobs: blobs!, on, limit });
        bridge.terminals = terminalClient.terminals;
        bridge.artboard = localArtboardClient({ read: blobRead, release: ref => blobRead('content.release', ref), blobs: blobs!, uploads: uploads!, pages: pages!, limit });
        bridge.chatDrafts = localDraftsClient({ read: blobRead, release: ref => blobRead('content.release', ref), blobs: blobs!, uploads: uploads!, pages: pages!, limit });
        const files = localFilesClient({ read: blobRead, release: ref => blobRead('content.release', ref), blobs: blobs!, uploads: uploads!, pages: pages!, limit });
        Object.assign(bridge.files, files.files); bridge.repo = files.repo;
        filesWatches = localFilesWatchClient({ read: blobRead, decode: filesContentReader({ release: ref => blobRead('content.release', ref), blobs: blobs!, pages: pages! }), on: listener => on(LOCAL_EVENTS.files, listener), refusal: reason => setState({ lastRefusal: reason }), limit });
        Object.assign(bridge.files, filesWatches.files);
        /*
         * THE TYNN TAB (P4 family 12, Tynn #561): this machine's window only, as it had over IPC; a remote window's
         * bridge is unchanged. Following a board, the issues or the Features page is BY SUBSCRIPTION: the watch is this
         * connection's, its signals come on `local-tynn` for the kind and workspace it watches, and stopping releases it.
         */
        const tynnFollow = (kind: TynnWatchKind) => (workspaceId: string, listener: (signal: never) => void): (() => void) => {
            let watchId: number | null = null;
            let stopped = false;
            const off = on(LOCAL_EVENTS.tynn, (payload) => {
                const e = payload as TynnWatchEvent;
                if (e.kind === kind && e.workspaceId === workspaceId) listener(e.signal as never);
            });
            void call('tynn.watch', kind, workspaceId).then((r) => {
                const id = r.ok && typeof r.value === 'number' ? r.value : null;
                if (id === null) return;
                if (stopped) void call('tynn.unwatch', id);
                else watchId = id;
            });
            return () => {
                stopped = true;
                off();
                if (watchId !== null) void call('tynn.unwatch', watchId);
                watchId = null;
            };
        };
        Object.assign(bridge.workspaces, {
            tynnBoard: (id: string, scope: unknown) => read('workspaces.tynnBoard', id, scope),
            tynnBoardAction: (id: string, input: unknown) => read('workspaces.tynnBoardAction', id, input),
            tynnPage: (id: string, page: unknown, query: unknown) => read('workspaces.tynnPage', id, page, query),
            tynnPageAction: (id: string, input: unknown) => read('workspaces.tynnPageAction', id, input),
            tynnBoardChanges: (id: string, scope: unknown, cursor: string, ids: readonly string[]) => read('workspaces.tynnBoardChanges', id, scope, cursor, Array.isArray(ids) ? [...ids] : ids),
            tynnIssues: (id: string, filters: unknown) => read('workspaces.tynnIssues', id, filters),
            tynnIssueAction: (id: string, input: unknown) => read('workspaces.tynnIssueAction', id, input),
            tynnIssueChanges: (id: string, filters: unknown, cursor: string, ids: readonly string[]) => read('workspaces.tynnIssueChanges', id, filters, cursor, Array.isArray(ids) ? [...ids] : ids),
            tynnBoardWatch: tynnFollow('board'),
            tynnIssuesWatch: tynnFollow('issues'),
            tynnFeaturesWatch: tynnFollow('features'),
        });
    }

    return {
        bridge,
        ...(blobs ? { blobs } : {}),
        ...(uploads ? { uploads } : {}),
        ...(pages ? { pages } : {}),
        ...(localOwner ? { localOwner } : {}),
        ...(agentWire ? { agentWire } : {}),
        shares: {
            list: (workspaceId) => answer('tynnNetwork.shares.list', workspaceId),
            mint: (input) => answer('tynnNetwork.shares.mint', input),
            revoke: (linkId) => answer('tynnNetwork.shares.revoke', linkId),
        },
        ready,
        state: () => state,
        onState: (l) => { stateListeners.add(l); return () => { stateListeners.delete(l); }; },
        takeBaton: (opts) => (opts?.force === true ? control('baton.take', { force: true }) : control('baton.take')),
        releaseBaton: async () => { await control('baton.release'); },
        refreshBaton,
        clearRefusal: () => setState({ lastRefusal: null, needsBaton: false }),
        lock: () => control('host.lock'),
        unlock: () => control('host.unlock'),
        close: () => transport.close(),
    };
}

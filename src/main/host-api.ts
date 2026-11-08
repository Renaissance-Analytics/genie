import type { ActivityFeed } from '../core/activity-feed.js';
import type { Headroom } from '../core/headroom.js';
import { homedir } from 'node:os';
import { listHostDir, makeHostDir } from './host-fs.js';
import { Coalescer, realSchedule } from '../core/coalesce.js';
import { AGENT_PUSH_INTERVAL_MS } from './agent-push.js';
import type { BudgetDecision, DeletePlan, SwitchDecision } from '../core/agent-ops.js';
import type { AgentPermissions, AgentRecord } from '../core/identity.js';
import type { CancelOutcome } from '../core/session.js';
import type { Diagnosis, FolderKind } from '../core/workspace-model.js';
import { LOCAL_EVENTS, type RemoteMethod } from '../core/remote-protocol.js';
import type { AgentDetail, GenieSnapshot, UpdateState } from '../renderer/bridge.js';
import type { FeatureAction, FeatureData } from '../renderer/features.js';
import type { Finished } from './attention-store.js';
import type { HostApi } from './remote-host.js';
import { restartWithHandoff, type RestartPorts } from './restart-with-handoff.js';
import type { PtyOpened, TerminalOptions } from './terminal-host.js';
import type { StartForWork as StartForWorkAnswer } from './start-on-demand.js';
import type { Attachment } from '../core/prompt-content.js';
import type { BytesResult, FileOpResult, OpenResult } from './files-host.js';
import type { TreeNode } from '../core/files-panel.js';
import { droneRefusal, type WorkstationRole } from '../core/workstation-role.js';
import type { AppSourceKind } from '../core/app-inbox.js';
import type { AppInboxCardState } from '../renderer/components/AppInboxCard.js';
import type { RoleChange, TynnWorkstationList, TynnNetworkBridge } from '../renderer/relay-transport.js';
import { isLocalFilesMethod } from '../core/local-files.js';
import { invokeLocalFiles, type LocalFilesDeps } from './local-files-api.js';
import type { FilesWatchPort } from './local-files-watches.js';
import { isLocalDraftMethod } from '../core/local-drafts.js';
import { invokeLocalDrafts, type LocalDraftsStore } from './local-drafts-api.js';
import { isLocalArtboardMethod } from '../core/local-artboard.js';
import type { ToolOutputReply } from '../core/tool-row-bound.js';
import { invokeLocalArtboard, type LocalArtboardPort } from './local-artboard-api.js';

/** Business ports for the own window's keys, device memory and Tynn session. No outgoing channel or window port. */
export interface LocalOwnerDeps {
    appInbox: {
        state(workspaceId: string): AppInboxCardState;
        workspaceExists(workspaceId: string): boolean;
        createKey(workspaceId: string, name: string): Promise<{ id: string; token: string }>;
        scriptKeys(workspaceId: string): readonly { id: string }[];
        revokeKey(keyId: string): Promise<unknown>;
        rotate(kind: AppSourceKind, id: string): void;
        revokeSource(source: { kind: AppSourceKind; id: string; workspaceId: string }): Promise<unknown>;
        allowSource(kind: AppSourceKind, id: string): Promise<unknown>;
        restartSource(workspaceId: string, kind: AppSourceKind, id: string): Promise<string>;
    };
    deviceLink?: {
        hosts(): Promise<string[]>;
        forget(url: string): Promise<boolean>;
        adopt(url: string, token: string): Promise<boolean>;
    };
    tynnNetwork: {
        hasAccount(): boolean;
        signedIn(): boolean;
        role(): WorkstationRole | null;
        workstations(): Promise<TynnWorkstationList>;
        setRole(workstationId: string, role: WorkstationRole, code: string): Promise<RoleChange>;
        rereadRole(): void;
        shares: NonNullable<TynnNetworkBridge['shares']>;
    };
}

/**
 * THE HOST API (§6.8) — what a remote connection may perform on THIS Genie: one `invoke` over the
 * 22 bridge methods and one event stream, built from the same parts the IPC handlers in main.ts use.
 * The parts are PORTS so this is a table under test; main.ts hands in the real registry, session
 * host, terminal host, feature IPC and updater. Host-only methods throw with where to do them — the
 * RemoteHost refuses them before they get here; this is the backstop.
 */

export interface HostApiDeps {
    artboard?: LocalArtboardPort;
    chatDrafts?: LocalDraftsStore;
    filesWatch?: FilesWatchPort;
    localFiles?: LocalFilesDeps;
    localOwner?: LocalOwnerDeps;
    /** The timer and clock the agent events are coalesced on (core/coalesce.ts). Default: the real ones. */
    schedule?: (ms: number, fn: () => void) => () => void;
    now?: () => number;
    snapshot(): GenieSnapshot;
    subscribeSnapshot(listener: (snapshot: GenieSnapshot) => void): () => void;
    /** Which agent's RECORD changed (a saved setting) — its detail is pushed, as for a session event. */
    subscribeAgentRecords(listener: (agentId: string) => void): () => void;
    find(agentId: string): AgentRecord | null;
    detailFor(agentId: string): AgentDetail | null;
    cwdFor(record: AgentRecord): string;
    /**
     * START ON FIRST MESSAGE (q_04ce323c; main/start-on-demand.ts): a message to an agent that is not running starts it
     * first, under the same refusals as Start. Absent = a message to a stopped agent is refused, as before.
     */
    /** May answer later: the agent engine in genie-host answers its start asynchronously (main/start-on-demand.ts). */
    startForWork?(record: AgentRecord): StartForWorkAnswer | Promise<StartForWorkAnswer>;
    /**
     * THE PERSON'S MESSAGE (main/start-on-demand.ts `startForYourMessage`): `startForWork`, and a new driver on the same
     * conversation when the run's own stopped itself (prism-acp 0.37.0). Absent = `startForWork`.
     */
    startForYourMessage?(record: AgentRecord): Promise<StartForWorkAnswer>;
    host: Pick<RestartPorts, 'prompt'> & {
        start(record: AgentRecord, cwd: string): ({ ok: true } | { ok: false; reason: string }) | Promise<{ ok: true } | { ok: false; reason: string }>;
        stop(agentId: AgentRecord['id']): boolean | Promise<boolean>;
        resolvePrompt?(agentId: AgentRecord['id'], id: string, action: 'send' | 'discard'): Promise<{ ok: true } | { ok: false; reason: string }>;
        answerApproval(agentId: AgentRecord['id'], optionId: string, note?: string): ({ ok: true } | { ok: false; reason: string }) | Promise<{ ok: true } | { ok: false; reason: string }>;
        /** `Stop this turn`: the current turn ends, the agent keeps running (`SessionHost.cancel`). Never `stop`. */
        cancel(agentId: AgentRecord['id']): CancelOutcome | Promise<CancelOutcome>;
        /** `Resume now`: the provider login held for its rate limit opens (Tynn #794). */
        resumeLimit(provider: string): void;
        /** Your message WITH files — the chat composer's attach (`SessionHost.promptWith`); absent = files are refused. */
        promptWith?(agentId: AgentRecord['id'], text: string, attachments: readonly Attachment[], by: string | null): ({ ok: true } | { ok: false; reason: string | null }) | Promise<{ ok: true } | { ok: false; reason: string | null }>;
        subscribe(listener: (agentId: string) => void): () => void;
    };
    /** The New agent form, created on this host (main/agent-create-host.ts): its AGENT.md written, then registered. */
    registerAgent(workspaceId: string, input: { name: string; purpose: string; provider: string }): Promise<{ ok: true; id: string; name: string } | { ok: false; reason: string }>;
    attention: { finished(): readonly Finished[]; markSeen(id: string): void };
    /**
     * TAKE OVER FROM ANOTHER MACHINE (Tynn #529 part A): the TUI started here with NO window here (main/take-over-host.ts
     * `window: false`); the person's machine opens its own window on it. `ended`: that window closed. Absent = Take over
     * is refused with where to do it, as before.
     */
    takeOver?: {
        start(agentId: string): { ok: true; terminalId: string; started?: boolean } | { ok: false; reason: string };
        ended(terminalId: string): void;
    };
    terminals: {
        open(options: TerminalOptions): PtyOpened;
        /** `open`, answered once the pid and shell are known (a pty made under genie-host). Absent = `open`'s answer is it. */
        openReady?(options: TerminalOptions): Promise<PtyOpened>;
        write(id: string, data: string): boolean;
        resize(id: string, cols: number, rows: number): boolean;
        close(id: string): boolean;
        list(): readonly { id: string; pid: number; shell: string; workspaceId: string }[];
        attach(id: string): { id: string; pid: number; shell: string; workspaceId: string; scrollback: string } | null;
        onData(listener: (id: string, data: string) => void): () => void;
        onExit(listener: (id: string, exitCode: number) => void): () => void;
    };
    /** A phone's upload (§6.8): the bytes land in a temp file for exactly as long as the inbox copies them. */
    uploads: {
        sendFile(to: string, text: string, name: string, bytes: Uint8Array): Promise<{ ok: true; messageId: string } | { ok: false; reason: string }>;
    };
    /**
     * THE PHONE'S FILES (genie#1346): the files host the panel uses (main/files-host.ts) — confined to the workspace, under
     * its size cap — and an upload into a folder of it. Absent = the phone's file browser is told this host has none.
     */
    files?: {
        children(workspaceId: string, dir: string): Promise<readonly TreeNode[] | null>;
        open(workspaceId: string, path: string): Promise<OpenResult>;
        readBytes(workspaceId: string, path: string): Promise<BytesResult>;
        upload(workspaceId: string, dir: string, name: string, bytes: Uint8Array): Promise<FileOpResult>;
    };
    serviceEnvFor(workspaceId: string): Record<string, string>;
    workspaceOps: {
        /** The plan for adding the folder picked in the window (Tynn #835) — nothing is written. */
        previewAdd?(path: string): Promise<unknown>;
        /** The parent folder is picked in the window too (Tynn #835). */
        previewAddFromGit?(url: string, parent: string): Promise<unknown>;
        tynnProjects?(): Promise<unknown>;
        /** Creating a Tynn project from the optional link (Add workspace parity item 5); optional, refused where absent. */
        tynnOwnerOptions?(): Promise<unknown>;
        createTynnProject?(input: unknown): Promise<unknown>;
        /** "It came with agents" (Add workspace parity item 6); optional, refused where absent. */
        importedAgents?(workspaceId: string): Promise<unknown>;
        adoptAgent?(workspaceId: string, name: string): Promise<unknown>;
        previewAddFromTynn?(projectId: string, parent: string): Promise<unknown>;
        locateRepo?(workspaceId: string, slug: string, path: string): Promise<unknown>;
        confirmAdd(path: string): Promise<unknown>;
        /**
         * `remote`: the window's None / GitHub / Paste URL choice, unparsed (main parses it; Add workspace parity 11).
         * `tynnProjectId`: the optional Tynn link (parity 5), looked up in Tynn's own list on the host.
         */
        create(name: string, parent: string, remote?: unknown, tynnProjectId?: string): Promise<unknown>;
        confirmAddFromGit(url: string, parent: string): Promise<unknown>;
        /** The Open existing / Import from Git wizard (Add workspace parity item 7); optional, refused where absent. */
        readSource?(path: string): Promise<unknown>;
        stageFromGit?(url: string): Promise<unknown>;
        registerExisting?(path: string): Promise<unknown>;
        buildEnvelope?(plan: unknown, remote?: unknown): Promise<unknown>;
        discardStaged?(path: string): Promise<unknown>;
        /** Import from Git's browser: the repositories this host's GitHub sign-in reaches (Add workspace parity item 8). */
        githubRepos?(): Promise<unknown>;
        confirmAddFromTynn(parent: string, projectId: string): Promise<unknown>;
        hibernate(workspaceId: string): Promise<unknown>;
        wake(workspaceId: string): Promise<unknown>;
        remove(workspaceId: string): Promise<unknown>;
        listRepos(workspaceId: string): Promise<unknown>;
        /** The Tynn tab (genie#1295): the workspace's Tynn board at a scope, and one action on it. Optional: refused where absent. */
        tynnBoard?(workspaceId: string, scope: unknown): Promise<unknown>;
        tynnBoardAction?(workspaceId: string, input: unknown): Promise<unknown>;
        addRepo(workspaceId: string, input: { name: string; path: string }): Promise<unknown>;
        removeRepo(workspaceId: string, slug: string): Promise<unknown>;
        /** Optional: a host without it answers the call with a refusal rather than failing to build its deps. */
        removeRepoLock?(workspaceId: string, slug: string): Promise<unknown>;
        /** Optional for the same reason: a host without it answers with a refusal. */
        commitsSince?(workspaceId: string, sinceMs: number): Promise<unknown>;
        settings(workspaceId: string): Promise<unknown> | unknown;
        setSetting(workspaceId: string, key: string, value: unknown): Promise<unknown>;
        resetSetting(workspaceId: string, key: string): Promise<unknown>;
        onSettingsChanged?(listener: (workspaceId: string) => void): () => void;
        setGoverns(workspaceId: string, childIds: readonly string[]): Promise<unknown>;
        setDefaultAgent(workspaceId: string, agentId: string | null): Promise<unknown>;
        /** A workspace's colour (genie#1300). Optional: a host without it refuses. */
        setColor?(workspaceId: string, color: string): Promise<unknown>;
    };
    agentOps: {
        /** THE ONE RESTART (genie#1238): `restartAgent` — 'graceful' from every state, delivering what is owed. */
        restart(agentId: string, kind: 'graceful' | 'fresh'): Promise<{ ok: true; kind: 'graceful' | 'fresh'; discarded?: string | null } | { ok: false; reason: string }>;
        previewDelete(agentId: string, outcome: 'unmount' | 'delete', alsoRemoveFrom: readonly string[]): Promise<{ ok: true; plan: DeletePlan } | { ok: false; reason: string }>;
        /** `handoff`: ask a running agent for a handoff first (bounded wait); see agent-ops-host `deleteAgent`. */
        delete(agentId: string, outcome: 'unmount' | 'delete', alsoRemoveFrom: readonly string[], handoff: boolean): Promise<{ ok: true; plan: DeletePlan } | { ok: false; reason: string }>;
        switchDriver(agentId: string, to: string): Promise<SwitchDecision>;
        setBudget(agentId: string, dailyLimitUsd: number | null): Promise<{ ok: true; decision: BudgetDecision } | { ok: false; reason: string }>;
        setMode(agentId: string, mode: 'automated' | 'manual'): Promise<unknown>;
        setAccessScope(agentId: string, scope: 'none' | 'self' | 'all'): Promise<unknown>;
        setAutoApprove(agentId: string, on: boolean): Promise<unknown>;
        setManageTabs(agentId: string, on: boolean): Promise<unknown>;
        setDrivePages(agentId: string, on: boolean): Promise<unknown>;
        setIssueWatch(agentId: string, setting: unknown): Promise<unknown>;
        setPermissions(agentId: string, permissions: AgentPermissions): Promise<unknown>;
        setModel(agentId: string, model: string | null): Promise<unknown>;
        /** The provider's models for the agent's picker; `refresh` asks the provider again. */
        models(agentId: string, refresh: boolean): Promise<unknown>;
        diagnose(agentId: string): Promise<{ ok: true; diagnosis: Diagnosis } | { ok: false; reason: string }>;
        /** A tool row's whole output, from the host's store, bounded (Tynn story #386). Absent = previews only. */
        toolOutput?(agentId: string, toolCallId: string): Promise<ToolOutputReply>;
    };
    /** Every agent's activity feed (the Dashboard's lanes, beta.33 item 10): one workspace's, and each as it changes. */
    activity?: {
        feeds(workspaceId: string): Readonly<Record<string, ActivityFeed>>;
        subscribe(listener: (feed: ActivityFeed) => void): () => void;
    };
    /** Buffered provider readings, with the native initial read and subsequent changes. */
    headroom?: {
        view(): Readonly<Record<string, Headroom>>;
        subscribe(listener: (room: Readonly<Record<string, Headroom>>) => void): () => void;
    };
    retryPausedAccount?(provider: string): void;
    features: {
        snapshot(): Promise<FeatureData>;
        act(action: FeatureAction): Promise<FeatureData>;
        onChange(listener: (data: FeatureData) => void): () => void;
    };
    updates: {
        state(): UpdateState;
        check(): Promise<UpdateState>;
        download(): Promise<boolean>;
        install(): Promise<{ report: string }> | null;
        notes?(): Promise<UpdateState | null>;
        /** Abandon a drain in progress (§7.5); `false` when there is none. */
        onChange(listener: (state: UpdateState) => void): () => void;
    } | null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : String(v ?? ''));
const num = (v: unknown): number | undefined => (typeof v === 'number' && v > 0 ? Math.floor(v) : undefined);
const named = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

export function buildHostApi(deps: HostApiDeps): HostApi {
    const agent = (id: unknown): AgentRecord | null => deps.find(str(id));
    const owner = (): LocalOwnerDeps => {
        if (!deps.localOwner) throw new Error('this host has no local owner operations');
        return deps.localOwner;
    };

    const invoke = async (method: RemoteMethod, args: unknown[]): Promise<unknown> => {
        if (isLocalFilesMethod(method)) return invokeLocalFiles(deps.localFiles, method, args);
        if (isLocalDraftMethod(method)) return invokeLocalDrafts(deps.chatDrafts, deps.find, method, args);
        if (isLocalArtboardMethod(method)) return invokeLocalArtboard(deps.artboard, method, args);
        switch (method) {
            case 'appInbox.state':
                return named(args[0]) ? { ok: true, state: owner().appInbox.state(args[0]) } : { ok: false, reason: 'name a workspace' };
            case 'appInbox.createKey': {
                const [workspaceId, name] = args;
                if (!named(workspaceId) || typeof name !== 'string') return { ok: false, reason: 'name a workspace and the key' };
                const inbox = owner().appInbox;
                if (!inbox.workspaceExists(workspaceId)) return { ok: false, reason: `no workspace ${workspaceId}` };
                try {
                    const made = await inbox.createKey(workspaceId, name);
                    return { ok: true, id: made.id, name: name.trim(), token: made.token, state: inbox.state(workspaceId) };
                } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
            }
            case 'appInbox.revokeKey': {
                const [workspaceId, keyId] = args;
                if (!named(workspaceId) || !named(keyId)) return { ok: false, reason: 'name a workspace and the key' };
                const inbox = owner().appInbox;
                if (!inbox.scriptKeys(workspaceId).some(k => k.id === keyId)) return { ok: false, reason: 'that key is not one of this workspace’s' };
                await inbox.revokeKey(keyId);
                return { ok: true, state: inbox.state(workspaceId) };
            }
            case 'appInbox.source': {
                const [workspaceId, op, kind, id] = args;
                if (!named(workspaceId) || (op !== 'rotate' && op !== 'revoke' && op !== 'allow') || (kind !== 'site' && kind !== 'process') || !named(id)) return { ok: false, reason: 'rotate, revoke or allow a site or a process' };
                const inbox = owner().appInbox;
                try {
                    if (op === 'rotate') inbox.rotate(kind, id);
                    else if (op === 'revoke') await inbox.revokeSource({ kind, id, workspaceId });
                    else await inbox.allowSource(kind, id);
                    const after = await inbox.restartSource(workspaceId, kind, id);
                    return { ok: true, text: `${op === 'rotate' ? 'Rotated' : op === 'revoke' ? 'Revoked' : 'Allowed'}: ${after}`, state: inbox.state(workspaceId) };
                } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
            }
            case 'deviceLink.hosts': return (await owner().deviceLink?.hosts()) ?? [];
            case 'deviceLink.forget': return typeof args[0] === 'string' ? (await owner().deviceLink?.forget(args[0])) ?? false : false;
            case 'deviceLink.adopt': return typeof args[0] === 'string' && typeof args[1] === 'string' ? (await owner().deviceLink?.adopt(args[0], args[1])) ?? false : false;
            case 'tynnNetwork.workstations': {
                const network = owner().tynnNetwork;
                if (!network.hasAccount()) return { ok: false, reason: 'this Genie has no Tynn account' };
                const refused = droneRefusal(network.role());
                if (refused) return { ok: false, reason: refused };
                return network.workstations();
            }
            case 'tynnNetwork.setRole': {
                const network = owner().tynnNetwork, [workstationId, role, code] = args;
                const refused = droneRefusal(network.role());
                if (refused) return { ok: false, reason: refused };
                if (typeof workstationId !== 'string' || (role !== 'pilot' && role !== 'drone') || typeof code !== 'string') return { ok: false, reason: 'not a role change' };
                if (!network.signedIn()) return { ok: false, reason: 'Sign in to Tynn to change a workstation’s role' };
                const result = await network.setRole(workstationId, role, code);
                if (result.ok) network.rereadRole();
                return result;
            }
            case 'tynnNetwork.shares.list': return owner().tynnNetwork.shares.list(typeof args[0] === 'string' ? args[0] : null);
            case 'tynnNetwork.shares.mint': {
                const input = (args[0] ?? {}) as { workspaceId?: unknown; capability?: unknown; expiresInDays?: unknown };
                return owner().tynnNetwork.shares.mint({ workspaceId: typeof input.workspaceId === 'string' ? input.workspaceId : null,
                    capability: input.capability === 'readonly' ? 'readonly' : 'control', expiresInDays: typeof input.expiresInDays === 'number' ? input.expiresInDays : 7 });
            }
            case 'tynnNetwork.shares.revoke': return typeof args[0] === 'string' ? owner().tynnNetwork.shares.revoke(args[0]) : { ok: false, reason: 'not a link' };
            case 'snapshot':
                return deps.snapshot();
            case 'agentDetail':
                return deps.detailFor(str(args[0]));
            case 'openAgent': {
                // Opening SHOWS the agent (q_04ce323c): nothing starts. Its first message, or Start, starts it.
                const r = agent(args[0]);
                return r ? { ok: true } : { ok: false, reason: 'unknown agent' };
            }
            case 'stopAgent': {
                const r = agent(args[0]);
                return { ok: r ? await deps.host.stop(r.id) : false };
            }
            case 'resumeLimit': {
                const r = agent(args[0]);
                if (!r) return { ok: false, reason: 'unknown agent' };
                deps.host.resumeLimit(r.provider);
                return { ok: true };
            }
            case 'cancelTurn': {
                const r = agent(args[0]);
                return r ? deps.host.cancel(r.id) : { ok: false, reason: 'unknown agent' };
            }
            case 'prompt': {
                const r = agent(args[0]);
                const text = str(args[1]);
                // THE FIRST MESSAGE STARTS IT (q_04ce323c), as the composer's does; a refused start is said, nothing sent.
                if (r && (deps.startForYourMessage || deps.startForWork) && (text.length > 0 || Array.isArray(args[2]))) {
                    const started = deps.startForYourMessage ? await deps.startForYourMessage(r) : await deps.startForWork!(r);
                    if (!started.ok) return { ok: false, reason: started.reason };
                }
                // With files (a phone's photo, genie#1346): the chat's own attach path, by YOU — never sent without them.
                if (Array.isArray(args[2])) {
                    const attachments = attachmentsOf(args[2]);
                    if (!r) return { ok: false, reason: 'unknown agent' };
                    if (attachments === null || attachments.length === 0) return { ok: false, reason: 'an attachment is not a file' };
                    if (!deps.host.promptWith) return { ok: false, reason: 'this host does not take files in a message' };
                    const sent = await deps.host.promptWith(r.id, text, attachments, 'you');
                    return sent.ok ? { ok: true } : { ok: false, ...(sent.reason ? { reason: sent.reason } : {}) };
                }
                return { ok: r !== null && text.length > 0 && (await deps.host.prompt(r.id, text, 'you')) };
            }
            case 'resolvePrompt': {
                const r = agent(args[0]);
                const action = args[2];
                if (!r || typeof args[1] !== 'string' || (action !== 'send' && action !== 'discard')) return { ok: false, reason: 'Invalid draft action.' };
                return deps.host.resolvePrompt?.(r.id, args[1], action) ?? { ok: false, reason: 'This host does not support queued drafts.' };
            }
            case 'answerApproval': {
                const r = agent(args[0]);
                // The host's refusal, with its reason, goes back to the card that pressed (core/approval-answering.ts).
                return r ? deps.host.answerApproval(r.id, str(args[1]), typeof args[2] === 'string' ? args[2] : '') : { ok: false, reason: 'unknown agent' };
            }
            case 'addAgent': {
                const raw = (typeof args[1] === 'object' && args[1] !== null ? args[1] : {}) as Record<string, unknown>;
                const created = await deps.registerAgent(str(args[0]), { name: str(raw['name']), purpose: str(raw['purpose']), provider: str(raw['provider']) });
                return created.ok ? { ok: true, id: created.id } : created;
            }
            case 'restartWithHandoff': {
                const r = agent(args[0]);
                if (!r) return { ok: false, reason: 'unknown agent' };
                // The one restart (genie#1238), then the note.
                return restartWithHandoff({ restart: (id) => deps.agentOps.restart(id, 'graceful'), prompt: (id, text, by) => deps.host.prompt(id, text, by) }, deps.attention, r, str(args[1]));
            }
            case 'agents.restart':
                if (typeof args[0] !== 'string' || (args[1] !== 'graceful' && args[1] !== 'fresh')) return { ok: false, reason: 'a restart names an agent and a kind: graceful or fresh' };
                return deps.agentOps.restart(args[0], args[1]);
            case 'agents.previewDelete':
                if (typeof args[0] !== 'string' || (args[1] !== 'unmount' && args[1] !== 'delete')) return { ok: false, reason: 'a delete names an agent and an outcome: unmount or delete' };
                return deps.agentOps.previewDelete(args[0], args[1], Array.isArray(args[2]) ? args[2].map(String) : []);
            case 'agents.delete':
                if (typeof args[0] !== 'string' || (args[1] !== 'unmount' && args[1] !== 'delete')) return { ok: false, reason: 'a delete names an agent and an outcome: unmount or delete' };
                return deps.agentOps.delete(args[0], args[1], Array.isArray(args[2]) ? args[2].map(String) : [], args[3] === true);
            case 'agents.switchDriver':
                if (typeof args[0] !== 'string' || typeof args[1] !== 'string') return { ok: false, reason: 'a switch names an agent and a provider' };
                return deps.agentOps.switchDriver(args[0], args[1]);
            case 'agents.setBudget':
                if (typeof args[0] !== 'string' || (args[1] !== null && !(typeof args[1] === 'number' && args[1] >= 0))) return { ok: false, reason: 'a budget is a non-negative number of dollars, or null to clear it' };
                return deps.agentOps.setBudget(args[0], args[1] as number | null);
            case 'agents.setMode':
                if (typeof args[0] !== 'string' || (args[1] !== 'automated' && args[1] !== 'manual')) return { ok: false, reason: 'mode is automated or manual' };
                return deps.agentOps.setMode(args[0], args[1]);
            case 'agents.setAutoApprove':
                if (typeof args[0] !== 'string' || typeof args[1] !== 'boolean') return { ok: false, reason: 'autonomy is on or off' };
                return deps.agentOps.setAutoApprove(args[0], args[1]);
            case 'agents.setManageTabs':
                if (typeof args[0] !== 'string' || typeof args[1] !== 'boolean') return { ok: false, reason: 'managing tabs is on or off' };
                return deps.agentOps.setManageTabs(args[0], args[1]);
            case 'agents.setDrivePages':
                if (typeof args[0] !== 'string' || typeof args[1] !== 'boolean') return { ok: false, reason: 'driving pages is on or off' };
                return deps.agentOps.setDrivePages(args[0], args[1]);
            case 'agents.setIssueWatch':
                if (typeof args[0] !== 'string') return { ok: false, reason: 'unknown agent' };
                return deps.agentOps.setIssueWatch(args[0], args[1]);
            case 'agents.setAccessScope':
                if (typeof args[0] !== 'string' || (args[1] !== 'none' && args[1] !== 'self' && args[1] !== 'all')) return { ok: false, reason: 'scope is none, self or all' };
                return deps.agentOps.setAccessScope(args[0], args[1]);
            case 'agents.setPermissions':
                if (typeof args[0] !== 'string' || (args[1] !== 'all' && args[1] !== 'edits' && args[1] !== 'ask')) return { ok: false, reason: 'permissions are all, ask or edits' };
                return deps.agentOps.setPermissions(args[0], args[1]);
            case 'agents.setModel':
                if (typeof args[0] !== 'string' || (args[1] !== null && typeof args[1] !== 'string')) return { ok: false, reason: 'a model is a name, or null for the provider default' };
                // Only explicit null clears it. The operation keeps its existing empty-name refusal.
                return deps.agentOps.setModel(args[0], args[1]);
            case 'agents.models':
                if (typeof args[0] !== 'string') return { ok: false, reason: 'unknown agent' };
                // Only an explicit `true` asks the provider again: a refresh starts its CLI.
                return deps.agentOps.models(args[0], args[1] === true);
            case 'agents.diagnose':
                if (typeof args[0] !== 'string') return { ok: false, reason: 'diagnose names an agent' };
                return deps.agentOps.diagnose(args[0]);
            case 'agents.toolOutput':
                if (typeof args[0] !== 'string' || typeof args[1] !== 'string' || args[1] === '') return { ok: false, reason: 'toolOutput names an agent and a tool call' };
                return deps.agentOps.toolOutput ? deps.agentOps.toolOutput(args[0], args[1]) : { ok: false, reason: 'this host keeps no tool outputs' };
            case 'workspaces.previewAdd':
                // Preserve the retired native wizard's early refusals before any coercion or disk operation.
                if (typeof args[0] !== 'string' || args[0] === '') return { ok: false, reason: 'no folder picked' };
                if (!deps.workspaceOps.previewAdd) throw new Error('this host cannot preview adding a folder');
                return deps.workspaceOps.previewAdd(args[0]);
            case 'workspaces.previewAddFromGit':
                if (typeof args[0] !== 'string' || typeof args[1] !== 'string' || args[1] === '') return { ok: false, reason: 'give a git URL and a parent folder' };
                if (!deps.workspaceOps.previewAddFromGit) throw new Error('this host cannot preview a clone');
                return deps.workspaceOps.previewAddFromGit(args[0], args[1]);
            case 'workspaces.confirmAddFromGit':
                if (typeof args[0] !== 'string' || typeof args[1] !== 'string') return { ok: false, reason: 'give a git URL and a parent folder' };
                return deps.workspaceOps.confirmAddFromGit(args[0], args[1]);
            case 'workspaces.readSource':
                if (typeof args[0] !== 'string' || args[0] === '') return { ok: false, reason: 'no folder picked' };
                if (!deps.workspaceOps.readSource) throw new Error('this host cannot read a folder to set it up');
                return deps.workspaceOps.readSource(args[0]);
            case 'workspaces.stageFromGit':
                if (typeof args[0] !== 'string' || args[0].trim() === '') return { ok: false, reason: 'give a git URL' };
                if (!deps.workspaceOps.stageFromGit) throw new Error('this host cannot import from git');
                return deps.workspaceOps.stageFromGit(args[0]);
            case 'workspaces.registerExisting':
                if (typeof args[0] !== 'string' || args[0] === '') return { ok: false, reason: 'no folder picked' };
                if (!deps.workspaceOps.registerExisting) throw new Error('this host cannot add an existing workspace');
                return deps.workspaceOps.registerExisting(args[0]);
            case 'workspaces.buildEnvelope':
                if (!deps.workspaceOps.buildEnvelope) throw new Error('this host cannot build a workspace');
                return deps.workspaceOps.buildEnvelope(args[0], args[1]);
            case 'workspaces.discardStaged':
                if (typeof args[0] !== 'string') return { ok: true };
                if (!deps.workspaceOps.discardStaged) throw new Error('this host cannot discard an import');
                return deps.workspaceOps.discardStaged(args[0]);
            case 'workspaces.githubRepos':
                if (!deps.workspaceOps.githubRepos) throw new Error('this host cannot list GitHub repositories');
                return deps.workspaceOps.githubRepos();
            case 'workspaces.locateRepo':
                if (!deps.workspaceOps.locateRepo) throw new Error('this host cannot locate a repo');
                return deps.workspaceOps.locateRepo(str(args[0]), str(args[1]), str(args[2]));
            case 'workspaces.tynnOwnerOptions':
                if (!deps.workspaceOps.tynnOwnerOptions) throw new Error('this host cannot create Tynn projects');
                return deps.workspaceOps.tynnOwnerOptions();
            case 'workspaces.createTynnProject':
                if (!deps.workspaceOps.createTynnProject) throw new Error('this host cannot create Tynn projects');
                return deps.workspaceOps.createTynnProject(args[0]);
            case 'workspaces.importedAgents':
                if (typeof args[0] !== 'string') return { ok: false, reason: 'name a workspace' };
                if (!deps.workspaceOps.importedAgents) throw new Error('this host cannot read a workspace’s agent files');
                return deps.workspaceOps.importedAgents(args[0]);
            case 'workspaces.adoptAgent':
                if (typeof args[0] !== 'string' || typeof args[1] !== 'string' || args[1] === '') return { ok: false, reason: 'name a workspace and an agent' };
                if (!deps.workspaceOps.adoptAgent) throw new Error('this host cannot adopt agents');
                return deps.workspaceOps.adoptAgent(args[0], args[1]);
            case 'workspaces.tynnProjects':
                if (!deps.workspaceOps.tynnProjects) throw new Error('this host cannot list Tynn projects');
                return deps.workspaceOps.tynnProjects();
            case 'workspaces.previewAddFromTynn':
                if (typeof args[0] !== 'string' || args[0] === '' || typeof args[1] !== 'string' || args[1] === '') return { ok: false, reason: 'choose a Tynn project and a parent folder' };
                if (!deps.workspaceOps.previewAddFromTynn) throw new Error('this host cannot preview a Tynn envelope');
                return deps.workspaceOps.previewAddFromTynn(args[0], args[1]);
            case 'workspaces.confirmAddFromTynn':
                if (typeof args[0] !== 'string' || typeof args[1] !== 'string') return { ok: false, reason: 'give a parent folder and a Tynn project' };
                return deps.workspaceOps.confirmAddFromTynn(args[0], args[1]);
            case 'workspaces.create':
                if (typeof args[0] !== 'string' || typeof args[1] !== 'string') return { ok: false, reason: 'give the workspace a name and a folder' };
                return deps.workspaceOps.create(args[0], args[1], args[2], typeof args[3] === 'string' && args[3] !== '' ? args[3] : undefined);
            case 'workspaces.confirmAdd':
                if (typeof args[0] !== 'string') return { ok: false, reason: 'confirmAdd names a folder' };
                return deps.workspaceOps.confirmAdd(args[0]);
            case 'workspaces.hibernate':
                return deps.workspaceOps.hibernate(str(args[0]));
            case 'workspaces.wake':
                return deps.workspaceOps.wake(str(args[0]));
            case 'workspaces.remove':
                return deps.workspaceOps.remove(str(args[0]));
            case 'workspaces.tynnBoard':
                if (!deps.workspaceOps.tynnBoard) throw new Error('this host has no Tynn tab');
                return deps.workspaceOps.tynnBoard(str(args[0]), args[1]);
            case 'workspaces.tynnBoardAction':
                if (!deps.workspaceOps.tynnBoardAction) throw new Error('this host has no Tynn tab');
                return deps.workspaceOps.tynnBoardAction(str(args[0]), args[1]);
            case 'workspaces.listRepos':
                return deps.workspaceOps.listRepos(str(args[0]));
            case 'workspaces.addRepo': {
                const input = (typeof args[1] === 'object' && args[1] !== null ? args[1] : {}) as { name?: unknown; path?: unknown };
                return deps.workspaceOps.addRepo(str(args[0]), { name: str(input.name), path: str(input.path) });
            }
            case 'workspaces.removeRepo':
                return deps.workspaceOps.removeRepo(str(args[0]), str(args[1]));
            case 'workspaces.removeRepoLock':
                return deps.workspaceOps.removeRepoLock ? deps.workspaceOps.removeRepoLock(str(args[0]), str(args[1])) : { ok: false, reason: 'this host cannot touch the repo' };
            case 'workspaces.commitsSince':
                return deps.workspaceOps.commitsSince ? deps.workspaceOps.commitsSince(str(args[0]), Number(args[1])) : { ok: false, reason: 'this host cannot read commits' };
            case 'workspaces.settings':
                return deps.workspaceOps.settings(str(args[0]));
            case 'workspaces.setSetting':
                return deps.workspaceOps.setSetting(str(args[0]), str(args[1]), args[2]);
            case 'workspaces.resetSetting':
                return deps.workspaceOps.resetSetting(str(args[0]), str(args[1]));
            case 'workspaces.setGoverns':
                return deps.workspaceOps.setGoverns(str(args[0]), Array.isArray(args[1]) ? args[1].map(str) : []);
            case 'workspaces.setDefaultAgent':
                return deps.workspaceOps.setDefaultAgent(str(args[0]), typeof args[1] === 'string' && args[1] !== '' ? args[1] : null);
            case 'workspaces.setColor':
                return deps.workspaceOps.setColor ? deps.workspaceOps.setColor(str(args[0]), str(args[1])) : { ok: false, reason: 'this host cannot set a workspace colour' };
            case 'addWorkspace':
                throw new Error('addWorkspace opens a folder picker on the host; do it there');
            case 'takeOver':
                if (!deps.takeOver) throw new Error('takeOver opens a window on the host; do it there');
                return deps.takeOver.start(str(args[0]));
            case 'providerLogin':
                throw new Error('providerLogin opens the provider login in a window on the host; do it there');
            case 'features.setBrowserBounds':
                throw new Error("features.setBrowserBounds places a view on the host's own window; nothing to do remotely");
            case 'terminals.open': {
                const workspaceId = str(args[0]);
                const workspace = deps.snapshot().workspaces?.find((w) => w.id === workspaceId) ?? null;
                if (!workspace) throw new Error(`no workspace ${workspaceId}`);
                const options = (args[1] ?? {}) as { cols?: unknown; rows?: unknown; command?: unknown };
                const env = deps.serviceEnvFor(workspace.id);
                const command = typeof options.command === 'string' && options.command.trim() ? options.command : undefined;
                const wanted: TerminalOptions = { workspaceId: workspace.id, cwd: workspace.path, cols: num(options.cols), rows: num(options.rows), command, personal: true, ...(Object.keys(env).length > 0 ? { env } : {}) };
                return deps.terminals.openReady ? await deps.terminals.openReady(wanted) : deps.terminals.open(wanted);
            }
            case 'terminals.write':
                return deps.terminals.write(str(args[0]), str(args[1]));
            case 'terminals.resize':
                return deps.terminals.resize(str(args[0]), Math.floor(Number(args[1])), Math.floor(Number(args[2])));
            case 'terminals.close':
                return deps.terminals.close(str(args[0]));
            case 'terminals.attach': {
                // Scoped like list: a connection scoped to one workspace cannot join another's terminal.
                const workspaceId = str(args[0]);
                const joined = deps.terminals.attach(str(args[1]));
                if (!joined || joined.workspaceId !== workspaceId) return null;
                const { id, pid, shell, scrollback } = joined;
                return { id, pid, shell, scrollback };
            }
            case 'terminals.list': {
                const workspaceId = str(args[0]);
                return deps.terminals.list().filter((t) => t.workspaceId === workspaceId).map(({ id, pid, shell }) => ({ id, pid, shell }));
            }
            case 'features.snapshot':
                return deps.features.snapshot();
            case 'features.act':
                return deps.features.act(args[0] as FeatureAction);
            case 'host.listDir':
                return listHostDir(str(args[0]));
            case 'host.mkdir':
                return makeHostDir(str(args[0]), str(args[1]));
            case 'host.home':
                return homedir();
            case 'updates.state':
                return deps.updates?.state() ?? null;
            case 'updates.check':
                return deps.updates ? deps.updates.check() : null;
            case 'updates.download':
                return deps.updates ? deps.updates.download() : false;
            case 'updates.install':
                return deps.updates?.install() ?? null;
            case 'updates.notes':
                return deps.updates?.notes?.() ?? null;
            case 'headroom':
                return deps.headroom ? deps.headroom.view() : null;
            case 'accountRetry': {
                const record = typeof args[0] === 'string' ? deps.find(args[0]) : null;
                if (!record) return { ok: false, reason: 'No agent named.' };
                deps.retryPausedAccount?.(record.provider);
                return { ok: true };
            }
            case 'activity':
                if (typeof args[0] !== 'string') return {};
                return deps.activity ? deps.activity.feeds(args[0]) : {};
            case 'inbox.sendFile':
                return deps.uploads.sendFile(str(args[0]), str(args[1]), str(args[2]), Buffer.from(str(args[3]), 'base64'));
            case 'files.children':
                return deps.files ? deps.files.children(str(args[0]), str(args[1])) : null;
            case 'files.open':
                return deps.files ? deps.files.open(str(args[0]), str(args[1])) : { ok: false, path: str(args[1]), error: NO_FILES_HERE };
            case 'files.readMedia':
                return deps.files ? deps.files.readBytes(str(args[0]), str(args[1])) : { ok: false, path: str(args[1]), error: NO_FILES_HERE };
            case 'files.upload': {
                const file = args[2] as { name?: unknown; bytes?: unknown } | null;
                if (!file || typeof file.name !== 'string' || !(file.bytes instanceof Uint8Array)) return { ok: false, reason: 'an upload is a name with bytes' };
                return deps.files ? deps.files.upload(str(args[0]), str(args[1]), file.name, file.bytes) : { ok: false, reason: NO_FILES_HERE };
            }
        }
    };

    const terminalWorkspaces = new Map<string, string>();
    return {
        invoke,
        ...(deps.filesWatch ? { filesWatch: deps.filesWatch } : {}),
        ...(deps.takeOver ? { takeOverEnded: (terminalId: string) => deps.takeOver!.ended(terminalId) } : {}),
        workspaceOfAgent: (agentId) => deps.find(agentId)?.workspaceId ?? null,
        // A terminal's workspace, remembered once seen: its exit is pushed after it has left the list.
        workspaceOfTerminal: (terminalId) => {
            const live = deps.terminals.list().find((t) => t.id === terminalId)?.workspaceId;
            if (live) terminalWorkspaces.set(terminalId, live);
            return live ?? terminalWorkspaces.get(terminalId) ?? null;
        },
        workspacePaths: () => Object.fromEntries((deps.snapshot().workspaces ?? []).map((w) => [w.id, w.path])),
        onEvent: (listener, options) => {
            /*
             * An agent's detail AT MOST every AGENT_PUSH_INTERVAL_MS, the latest state last (the owner, 2026-10-20: "severe
             * UI lag"): a busy agent changes many times a second and its detail carries its ledger; built and sent per
             * event, it cost main a core. The first change goes at once.
             */
            // An agent NOBODY listening wants is not built at all (genie#1346): a phone watches one agent, not every one.
            const wants = options?.wantsAgent ?? (() => true);
            const agents = new Coalescer<string>({ intervalMs: AGENT_PUSH_INTERVAL_MS, flush: (agentId) => { if (wants(agentId)) listener(`agent:${agentId}`, deps.detailFor(agentId)); }, schedule: deps.schedule ?? realSchedule, now: deps.now ?? (() => Date.now()) });
            const offs = [
                deps.subscribeSnapshot((s) => listener('snapshot', s)),
                deps.host.subscribe((agentId) => agents.request(agentId)),
                deps.subscribeAgentRecords((agentId) => agents.request(agentId)),
                () => agents.stop(),
                deps.terminals.onData((id, data) => listener('terminal-data', { id, data })),
                deps.terminals.onExit((id, exitCode) => listener('terminal-exit', { id, exitCode })),
                deps.features.onChange((data) => listener('features', data)),
                deps.updates?.onChange((state) => { listener('updates', state); listener(LOCAL_EVENTS.updates, state); }) ?? (() => {}),
                deps.activity?.subscribe((feed) => { listener('activity', feed); listener(LOCAL_EVENTS.activity, feed); }) ?? (() => {}),
                deps.headroom?.subscribe((room) => listener(LOCAL_EVENTS.headroom, room)) ?? (() => {}),
                deps.filesWatch?.subscribe(event => listener(LOCAL_EVENTS.files, event)) ?? (() => {}),
                deps.workspaceOps.onSettingsChanged?.((id) => listener('workspace-settings-changed', id)) ?? (() => {}),
            ];
            return () => { for (const off of offs) off(); };
        },
    };
}

const NO_FILES_HERE = 'this host does not offer its files remotely';

/** A prompt's files as the host hands them over (staged bytes, remote-host.ts): name, type, bytes — or `null`. */
function attachmentsOf(list: readonly unknown[]): Attachment[] | null {
    const out: Attachment[] = [];
    for (const a of list) {
        const f = a as { name?: unknown; type?: unknown; bytes?: unknown } | null;
        if (!f || typeof f.name !== 'string' || !(f.bytes instanceof Uint8Array)) return null;
        out.push({ name: f.name, type: typeof f.type === 'string' ? f.type : '', bytes: f.bytes });
    }
    return out;
}

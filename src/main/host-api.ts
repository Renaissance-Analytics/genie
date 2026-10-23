import type { ActivityFeed } from '../core/activity-feed.js';
import { listHostDir, makeHostDir } from './host-fs.js';
import { Coalescer, realSchedule } from '../core/coalesce.js';
import { AGENT_PUSH_INTERVAL_MS } from './agent-push.js';
import type { BudgetDecision, DeletePlan, SwitchDecision } from '../core/agent-ops.js';
import type { AgentPermissions, AgentRecord } from '../core/identity.js';
import type { CancelOutcome } from '../core/session.js';
import type { Diagnosis, FolderKind } from '../core/workspace-model.js';
import type { RemoteMethod } from '../core/remote-protocol.js';
import type { AgentDetail, GenieSnapshot, UpdateState } from '../renderer/bridge.js';
import type { FeatureAction, FeatureData } from '../renderer/features.js';
import type { Finished } from './attention-store.js';
import type { HostApi } from './remote-host.js';
import { restartWithHandoff, type RestartPorts } from './restart-with-handoff.js';
import type { PtyOpened, TerminalOptions } from './terminal-host.js';

/**
 * THE HOST API (§6.8) — what a remote connection may perform on THIS Genie: one `invoke` over the
 * 22 bridge methods and one event stream, built from the same parts the IPC handlers in main.ts use.
 * The parts are PORTS so this is a table under test; main.ts hands in the real registry, session
 * host, terminal host, feature IPC and updater. Host-only methods throw with where to do them — the
 * RemoteHost refuses them before they get here; this is the backstop.
 */

export interface HostApiDeps {
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
    host: RestartPorts & {
        answerApproval(agentId: AgentRecord['id'], optionId: string, note?: string): { ok: true } | { ok: false; reason: string };
        /** `Stop this turn`: the current turn ends, the agent keeps running (`SessionHost.cancel`). Never `stop`. */
        cancel(agentId: AgentRecord['id']): CancelOutcome;
        /** `Resume now`: the provider login held for its rate limit opens (Tynn #794). */
        resumeLimit(provider: string): void;
        subscribe(listener: (agentId: string) => void): () => void;
    };
    registerAgent(workspaceId: string): Promise<{ id: string }>;
    attention: { finished(): readonly Finished[]; markSeen(id: string): void };
    terminals: {
        open(options: TerminalOptions): PtyOpened;
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
        addRepo(workspaceId: string, input: { name: string; path: string }): Promise<unknown>;
        removeRepo(workspaceId: string, slug: string): Promise<unknown>;
        /** Optional: a host without it answers the call with a refusal rather than failing to build its deps. */
        removeRepoLock?(workspaceId: string, slug: string): Promise<unknown>;
        /** Optional for the same reason: a host without it answers with a refusal. */
        commitsSince?(workspaceId: string, sinceMs: number): Promise<unknown>;
        settings(workspaceId: string): Promise<unknown> | unknown;
        setSetting(workspaceId: string, key: string, value: boolean | string): Promise<unknown>;
        resetSetting(workspaceId: string, key: string): Promise<unknown>;
        setGoverns(workspaceId: string, childIds: readonly string[]): Promise<unknown>;
        setDefaultAgent(workspaceId: string, agentId: string | null): Promise<unknown>;
    };
    agentOps: {
        restart(agentId: string, kind: 'graceful' | 'fresh'): Promise<unknown>;
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
    };
    /** Every agent's activity feed (the Dashboard's lanes, beta.33 item 10): one workspace's, and each as it changes. */
    activity?: {
        feeds(workspaceId: string): Readonly<Record<string, ActivityFeed>>;
        subscribe(listener: (feed: ActivityFeed) => void): () => void;
    };
    features: {
        snapshot(): Promise<FeatureData>;
        act(action: FeatureAction): Promise<FeatureData>;
        onChange(listener: (data: FeatureData) => void): () => void;
    };
    updates: {
        state(): UpdateState;
        check(): Promise<UpdateState>;
        download(): Promise<boolean>;
        install(): { report: string } | null;
        /** Abandon a drain in progress (§7.5); `false` when there is none. */
        onChange(listener: (state: UpdateState) => void): () => void;
    } | null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : String(v ?? ''));
const num = (v: unknown): number | undefined => (typeof v === 'number' && v > 0 ? Math.floor(v) : undefined);

export function buildHostApi(deps: HostApiDeps): HostApi {
    const agent = (id: unknown): AgentRecord | null => deps.find(str(id));

    const invoke = async (method: RemoteMethod, args: unknown[]): Promise<unknown> => {
        switch (method) {
            case 'snapshot':
                return deps.snapshot();
            case 'agentDetail':
                return deps.detailFor(str(args[0]));
            case 'openAgent': {
                const r = agent(args[0]);
                return r ? deps.host.start(r, deps.cwdFor(r)) : { ok: false, reason: 'unknown agent' };
            }
            case 'stopAgent': {
                const r = agent(args[0]);
                return { ok: r ? deps.host.stop(r.id) : false };
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
                return { ok: r !== null && text.length > 0 && deps.host.prompt(r.id, text) };
            }
            case 'answerApproval': {
                const r = agent(args[0]);
                // The host's refusal, with its reason, goes back to the card that pressed (core/approval-answering.ts).
                return r ? deps.host.answerApproval(r.id, str(args[1]), typeof args[2] === 'string' ? args[2] : '') : { ok: false, reason: 'unknown agent' };
            }
            case 'addAgent': {
                const created = await deps.registerAgent(str(args[0]));
                return { ok: true, id: created.id };
            }
            case 'restartWithHandoff': {
                const r = agent(args[0]);
                if (!r) return { ok: false, reason: 'unknown agent' };
                return restartWithHandoff(deps.host, deps.attention, r, deps.cwdFor(r), str(args[1]));
            }
            case 'agents.restart':
                return deps.agentOps.restart(str(args[0]), args[1] === 'fresh' ? 'fresh' : 'graceful');
            case 'agents.previewDelete':
                return deps.agentOps.previewDelete(str(args[0]), args[1] === 'delete' ? 'delete' : 'unmount', Array.isArray(args[2]) ? args[2].map(String) : []);
            case 'agents.delete':
                return deps.agentOps.delete(str(args[0]), args[1] === 'delete' ? 'delete' : 'unmount', Array.isArray(args[2]) ? args[2].map(String) : [], args[3] === true);
            case 'agents.switchDriver':
                return deps.agentOps.switchDriver(str(args[0]), str(args[1]));
            case 'agents.setBudget':
                return deps.agentOps.setBudget(str(args[0]), args[1] === null ? null : Number(args[1]));
            case 'agents.setMode':
                return deps.agentOps.setMode(str(args[0]), args[1] === 'automated' ? 'automated' : 'manual');
            case 'agents.setAutoApprove':
                return deps.agentOps.setAutoApprove(str(args[0]), args[1] === true);
            case 'agents.setManageTabs':
                return deps.agentOps.setManageTabs(str(args[0]), args[1] === true);
            case 'agents.setDrivePages':
                return deps.agentOps.setDrivePages(str(args[0]), args[1] === true);
            case 'agents.setIssueWatch':
                return deps.agentOps.setIssueWatch(str(args[0]), args[1]);
            case 'agents.setAccessScope':
                return deps.agentOps.setAccessScope(str(args[0]), args[1] === 'none' || args[1] === 'all' ? args[1] : 'self');
            case 'agents.setPermissions':
                return deps.agentOps.setPermissions(str(args[0]), args[1] === 'edits' || args[1] === 'ask' ? args[1] : 'all');
            case 'agents.setModel':
                // `null` (or nothing, or empty) = back to the provider's default.
                return deps.agentOps.setModel(str(args[0]), args[1] === null || args[1] === undefined || args[1] === '' ? null : str(args[1]));
            case 'agents.models':
                // Only an explicit `true` asks the provider again: a refresh starts its CLI.
                return deps.agentOps.models(str(args[0]), args[1] === true);
            case 'agents.diagnose':
                return deps.agentOps.diagnose(str(args[0]));
            case 'workspaces.previewAdd':
                if (!deps.workspaceOps.previewAdd) throw new Error('this host cannot preview adding a folder');
                return deps.workspaceOps.previewAdd(str(args[0]));
            case 'workspaces.previewAddFromGit':
                if (!deps.workspaceOps.previewAddFromGit) throw new Error('this host cannot preview a clone');
                return deps.workspaceOps.previewAddFromGit(str(args[0]), str(args[1]));
            case 'workspaces.confirmAddFromGit':
                return deps.workspaceOps.confirmAddFromGit(str(args[0]), str(args[1]));
            case 'workspaces.readSource':
                if (!deps.workspaceOps.readSource) throw new Error('this host cannot read a folder to set it up');
                return deps.workspaceOps.readSource(str(args[0]));
            case 'workspaces.stageFromGit':
                if (!deps.workspaceOps.stageFromGit) throw new Error('this host cannot import from git');
                return deps.workspaceOps.stageFromGit(str(args[0]));
            case 'workspaces.registerExisting':
                if (!deps.workspaceOps.registerExisting) throw new Error('this host cannot add an existing workspace');
                return deps.workspaceOps.registerExisting(str(args[0]));
            case 'workspaces.buildEnvelope':
                if (!deps.workspaceOps.buildEnvelope) throw new Error('this host cannot build a workspace');
                return deps.workspaceOps.buildEnvelope(args[0], args[1]);
            case 'workspaces.discardStaged':
                if (!deps.workspaceOps.discardStaged) throw new Error('this host cannot discard an import');
                return deps.workspaceOps.discardStaged(str(args[0]));
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
                if (!deps.workspaceOps.importedAgents) throw new Error('this host cannot read a workspace’s agent files');
                return deps.workspaceOps.importedAgents(str(args[0]));
            case 'workspaces.adoptAgent':
                if (!deps.workspaceOps.adoptAgent) throw new Error('this host cannot adopt agents');
                return deps.workspaceOps.adoptAgent(str(args[0]), str(args[1]));
            case 'workspaces.tynnProjects':
                if (!deps.workspaceOps.tynnProjects) throw new Error('this host cannot list Tynn projects');
                return deps.workspaceOps.tynnProjects();
            case 'workspaces.previewAddFromTynn':
                if (!deps.workspaceOps.previewAddFromTynn) throw new Error('this host cannot preview a Tynn envelope');
                return deps.workspaceOps.previewAddFromTynn(str(args[0]), str(args[1]));
            case 'workspaces.confirmAddFromTynn':
                return deps.workspaceOps.confirmAddFromTynn(str(args[0]), str(args[1]));
            case 'workspaces.create':
                return deps.workspaceOps.create(str(args[0]), str(args[1]), args[2], typeof args[3] === 'string' && args[3] !== '' ? args[3] : undefined);
            case 'workspaces.confirmAdd':
                return deps.workspaceOps.confirmAdd(str(args[0]));
            case 'workspaces.hibernate':
                return deps.workspaceOps.hibernate(str(args[0]));
            case 'workspaces.wake':
                return deps.workspaceOps.wake(str(args[0]));
            case 'workspaces.remove':
                return deps.workspaceOps.remove(str(args[0]));
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
                return deps.workspaceOps.setSetting(str(args[0]), str(args[1]), typeof args[2] === 'boolean' ? args[2] : str(args[2]));
            case 'workspaces.resetSetting':
                return deps.workspaceOps.resetSetting(str(args[0]), str(args[1]));
            case 'workspaces.setGoverns':
                return deps.workspaceOps.setGoverns(str(args[0]), Array.isArray(args[1]) ? args[1].map(str) : []);
            case 'workspaces.setDefaultAgent':
                return deps.workspaceOps.setDefaultAgent(str(args[0]), typeof args[1] === 'string' && args[1] !== '' ? args[1] : null);
            case 'addWorkspace':
                throw new Error('addWorkspace opens a folder picker on the host; do it there');
            case 'takeOver':
                throw new Error('takeOver opens a window on the host; do it there');
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
                return deps.terminals.open({ workspaceId: workspace.id, cwd: workspace.path, cols: num(options.cols), rows: num(options.rows), command, ...(Object.keys(env).length > 0 ? { env } : {}) });
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
            case 'updates.state':
                return deps.updates?.state() ?? null;
            case 'updates.check':
                return deps.updates ? deps.updates.check() : null;
            case 'updates.download':
                return deps.updates ? deps.updates.download() : false;
            case 'updates.install':
                return deps.updates?.install() ?? null;
            case 'activity':
                return deps.activity?.feeds(str(args[0])) ?? {};
            case 'inbox.sendFile':
                return deps.uploads.sendFile(str(args[0]), str(args[1]), str(args[2]), Buffer.from(str(args[3]), 'base64'));
        }
    };

    const terminalWorkspaces = new Map<string, string>();
    return {
        invoke,
        workspaceOfAgent: (agentId) => deps.find(agentId)?.workspaceId ?? null,
        // A terminal's workspace, remembered once seen: its exit is pushed after it has left the list.
        workspaceOfTerminal: (terminalId) => {
            const live = deps.terminals.list().find((t) => t.id === terminalId)?.workspaceId;
            if (live) terminalWorkspaces.set(terminalId, live);
            return live ?? terminalWorkspaces.get(terminalId) ?? null;
        },
        workspacePaths: () => Object.fromEntries((deps.snapshot().workspaces ?? []).map((w) => [w.id, w.path])),
        onEvent: (listener) => {
            /*
             * An agent's detail AT MOST every AGENT_PUSH_INTERVAL_MS, the latest state last (the owner, 2026-10-20: "severe
             * UI lag"): a busy agent changes many times a second and its detail carries its ledger; built and sent per
             * event, it cost main a core. The first change goes at once.
             */
            const agents = new Coalescer<string>({ intervalMs: AGENT_PUSH_INTERVAL_MS, flush: (agentId) => listener(`agent:${agentId}`, deps.detailFor(agentId)), schedule: deps.schedule ?? realSchedule, now: deps.now ?? (() => Date.now()) });
            const offs = [
                deps.subscribeSnapshot((s) => listener('snapshot', s)),
                deps.host.subscribe((agentId) => agents.request(agentId)),
                deps.subscribeAgentRecords((agentId) => agents.request(agentId)),
                () => agents.stop(),
                deps.terminals.onData((id, data) => listener('terminal-data', { id, data })),
                deps.terminals.onExit((id, exitCode) => listener('terminal-exit', { id, exitCode })),
                deps.features.onChange((data) => listener('features', data)),
                deps.updates?.onChange((state) => listener('updates', state)) ?? (() => {}),
                deps.activity?.subscribe((feed) => listener('activity', feed)) ?? (() => {}),
            ];
            return () => { for (const off of offs) off(); };
        },
    };
}

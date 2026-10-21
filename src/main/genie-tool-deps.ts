import type { IssueWatchSummary } from '../core/issue-watch.js';
import type { Liveness } from '../core/liveness.js';
import { addressOf, inboxSettingFrom } from '../core/inbox.js';
import { CREATE_AGENT_ACTION, type AgentToolsDeps } from './mcp-tools-agents.js';
import { WORKSPACE_TABS_ACTION } from './mcp-tools-workspace-tabs.js';
import type { AgentRecord } from '../core/identity.js';
import type { AttentionStore } from './attention-store.js';
import type { HostingServices, OpenInBrowser } from './hosting-actions.js';
import type { HostingApproval, ServiceExec } from './mcp-tools-hosting.js';
import type { ProcessApproval, ProcessesPort } from './mcp-tools-processes.js';
import type { InboxStore } from './inbox-store.js';
import type { IssueWatchRefreshAnswer } from './issue-watch-client.js';
import type { KnowledgeStore } from './knowledge-store.js';
import type { TerminalsPort } from './mcp-tools-more.js';
import type { PluginToolsDeps } from './mcp-tools-plugins.js';
import type { AllToolsDeps } from './mcp-registrations.js';
import type { Caller } from './mcp-tools.js';
import type { SettingsStore } from './settings-store.js';

/**
 * EVERY GENIE TOOL'S DEPENDENCIES, BUILT ONCE (the owner, 2026-10-13: doctor mode drives an agent with Genie's real
 * tools). Normal Genie and doctor mode both call `allGenieTools(genieToolDeps(parts))`: the parts differ — doctor has no
 * window or terminals, and says so — and the wiring between them and the tools does not. Two copies of this
 * mapping would drift, and drift between copies is exactly what refused every Genie session's tool calls that day
 * (five copies of the caller check, mcp-callers `callerFrom`).
 */
export interface GenieToolParts {
    readonly inbox: InboxStore;
    readonly attention: AttentionStore;
    readonly knowledge: KnowledgeStore;
    readonly settings: Pick<SettingsStore, 'snapshot' | 'snapshotFor'>;
    /** The person's approval of a gated action (a terminal created or written, a gated plugin tool, a service added or removed, a site removed, a background process added or removed). */
    readonly approve: (caller: Caller, action: 'create' | 'write' | 'plugin' | HostingApproval | ProcessApproval | typeof CREATE_AGENT_ACTION | typeof WORKSPACE_TABS_ACTION, detail: string) => Promise<'allowed' | 'denied'>;
    /** Every agent Genie knows, now. */
    readonly roster: () => readonly AgentRecord[];
    /** Each agent's liveness for `agentinbox list` (core/liveness.ts). Absent = not reported. */
    readonly liveness?: (agentId: string) => Liveness;
    /** A Take Over terminal's id or a session's key → who is calling; anything else is nobody. */
    readonly resolveCaller: (id: string) => Caller | null;
    readonly userActive: () => boolean;
    /** Pulse a terminal's row. Whether anything received the signal. */
    readonly glow: (terminalId: string) => boolean;
    readonly thumbsUp: (caller: Caller, reason: string) => void;
    /** IssueWatch (Tynn #806): what is open on GitHub for a workspace, as last heard from Tynn. Absent = none (doctor mode). */
    readonly issueWatch?: { forWorkspace(workspaceId: string): IssueWatchSummary; refresh?(workspaceId: string): Promise<IssueWatchRefreshAnswer>; recheckSignIn?(): void };
    /** openFileForUser (genie#922): the caller's workspace and the path relative to it — main opens Genie's file panel there. */
    readonly openFile: (target: { workspaceId: string; path: string; absolutePath: string; line: number | null }) => Promise<{ ok: true } | { ok: false; reason: string }>;
    /** The `plan` tool: the caller's plan into its own session (`SessionHost.reportPlan`); `false` = no running session. */
    readonly reportPlan?: (agentId: string, steps: readonly { content: string; status: string }[]) => boolean;
    readonly terminals: TerminalsPort;
    /** The env a terminal in a workspace gets — the Terminals tab's own (hosting-actions.ts `terminalEnvFor`). Absent = none. */
    readonly terminalEnv?: (workspaceId: string) => Readonly<Record<string, string>>;
    /** The services and sites the agents' `services` / `sites` tools act on. Absent = this Genie has none (doctor mode), and the tools say so. */
    readonly hosting?: HostingServices;
    /** Genie's browser, for the agents' `sites open` — the pane the Hosting tab's Open uses. Absent = none (doctor mode), and the tool says so. */
    readonly openInBrowser?: OpenInBrowser;
    /** The background processes the agents' `processes` tool acts on — the Processes tab's book and the supervisor's logs. Absent = none (doctor mode), and the tool says so. */
    readonly processes?: ProcessesPort;
    /** Runs `services exec` commands (main/service-exec.ts). Absent = none (doctor mode), and the tool says so. */
    readonly serviceExec?: ServiceExec;
    readonly plugins: PluginToolsDeps['plugins'] & { readonly run: PluginToolsDeps['run'] };
    /** A workspace's default agent and registering a new agent (`createAgent`, the default agent's only). Absent = no such tool (doctor mode). */
    readonly agents?: { defaultAgentOf(workspaceId: string): string | null; register: AgentToolsDeps['register'] };
    /** `workspaceTabs` (beta.35 item 36): writing a workspace's tabs, and the sites a site panel may show. Absent = no such tool (doctor mode). */
    readonly workspaceTabs?: { write(workspaceId: string, raw: string): void; sites(workspaceId: string): readonly string[] };
}

export function genieToolDeps(p: GenieToolParts): AllToolsDeps {
    const values = () => p.settings.snapshot();
    return {
        genie: {
            inbox: p.inbox,
            attention: p.attention,
            roster: p.roster,
            ...(p.liveness ? { liveness: p.liveness } : {}),
            resolveCaller: p.resolveCaller,
            workspaceSetting: (workspaceId) => inboxSettingFrom(p.settings.snapshotFor(workspaceId)),
            userActive: p.userActive,
            glow: p.glow,
            thumbsUp: p.thumbsUp,
            dnd: () => ({ on: values().do_not_disturb === true, reply: String(values().dnd_reply ?? '') }),
            ...(p.issueWatch ? { issueWatch: p.issueWatch } : {}),
        },
        more: {
            knowledge: p.knowledge,
            terminals: p.terminals,
            approve: (caller, action, detail) => p.approve(caller, action, detail),
            resolveCaller: p.resolveCaller,
            ...(p.terminalEnv ? { envFor: p.terminalEnv } : {}),
        },
        hosting: {
            resolveCaller: p.resolveCaller,
            approve: (caller, action, detail) => p.approve(caller, action, detail),
            services: p.hosting ?? null,
            ...(p.openInBrowser ? { openInBrowser: p.openInBrowser } : {}),
            ...(p.serviceExec ? { exec: p.serviceExec } : {}),
        },
        processes: {
            resolveCaller: p.resolveCaller,
            approve: (caller, action, detail) => p.approve(caller, action, detail),
            processes: p.processes ?? null,
        },
        attention: { resolveCaller: p.resolveCaller, openFile: p.openFile, ...(p.reportPlan ? { reportPlan: p.reportPlan } : {}) },
        plugins: {
            plugins: { tools: () => p.plugins.tools(), guard: (id) => p.plugins.guard(id) },
            run: p.plugins.run,
            approve: (caller, action, detail) => p.approve(caller, action, detail),
            resolveCaller: p.resolveCaller,
        },
        ...(p.agents ? {
            agents: {
                resolveCaller: p.resolveCaller,
                defaultAgentOf: (ws: string) => p.agents!.defaultAgentOf(ws),
                roster: p.roster,
                approve: (caller: Caller, action: typeof CREATE_AGENT_ACTION, detail: string) => p.approve(caller, action, detail),
                register: p.agents.register,
                addressOf: (record: AgentRecord) => addressOf(record, 'full'),
            },
        } : {}),
        ...(p.agents && p.workspaceTabs ? {
            workspaceTabs: {
                resolveCaller: p.resolveCaller,
                defaultAgentOf: (ws: string) => p.agents!.defaultAgentOf(ws),
                roster: p.roster,
                readTabs: (ws: string) => { const raw = p.settings.snapshotFor(ws)['workspace_tabs']; return typeof raw === 'string' ? raw : '{"tabs":[]}'; },
                writeTabs: (ws: string, raw: string) => p.workspaceTabs!.write(ws, raw),
                sites: (ws: string) => p.workspaceTabs!.sites(ws),
                approve: (caller: Caller, action: typeof WORKSPACE_TABS_ACTION, detail: string) => p.approve(caller, action, detail),
            },
        } : {}),
    };
}

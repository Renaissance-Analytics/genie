import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import {
    workspaceIdOfTerminal,
    SYSTEM_WORKSPACE_ID,
} from '../terminal/workspace-of-terminal';
import {
    listWorkspaces,
    listTerminalSpecs,
    getAllSettings,
    getTerminalSpec,
    getWorkspace,
    isWorkstationOperator,
    createTerminalSpec,
    updateTerminalSpec,
    workspaceProcessApproval,
    workspaceTerminalApproval,
    workspaceScheduleApproval,
    deleteTerminalSpec,
    getWorkspaceIssuewatchPolicyBuckets,
    removeWorkspace,
    getAppGrant,
    type TerminalSpecMeta,
    type TerminalSpecRow,
} from '../db';
import { agentInboxBroker } from '../agentinbox/broker';
import { devLifecycle } from '../dev-server/lifecycle';
import { getKnowledgeStore } from '../knowledge/store';
import { workspaceSlug } from '../agentinbox/slug';
import { appendLaunchFlags } from '../agentinbox/session-capture';
import { registerAgentInboxSession } from '../agentinbox/session-registration';
import {
    normalizePurpose,
    type AgentInboxAgentType,
    type AgentInboxAttachment,
    type AgentInboxScope,
} from '../agentinbox/types';
import {
    attachmentStoreRoot,
    collectAttachmentsForSend,
    saveAttachmentToWorkspace,
} from '../agentinbox/attachments';
import {
    broadcastTerminalSpecsChanged,
    killTerminalById,
    createAgentTerminal,
    writeToTerminal,
    readTerminalOutput,
    agentSessionTranscriptExists,
} from '../terminal/ipc';
import {
    PASTE_SUBMIT_DELAY_MS,
    resolveTerminalInput,
    stripAnsi,
} from '../terminal/keystrokes';
import {
    startProcess,
    stopProcess,
    restartProcess,
    forgetProcess,
    getProcessStatuses,
} from '../terminal/process-supervisor';
import {
    armSchedule,
    disarmSchedule,
    forgetSchedule,
    nextRunAt,
    runScheduleNow,
} from '../terminal/process-scheduler';
import { describeCron, isValidCron } from '../terminal/cron';
import { resolveRestartCommand } from '../agentinbox/session-capture';
import { detectFolder } from '../workspace/detect';
import { workspaceDocHealth } from '../workspace/create-agi';
import { openWorkspace } from '../workspace/open';
import { resolveWorkspaceRepos, getWorkspaceFeed, getOpenCounts, getWorkspaceStatus } from '../issue-watch';
import { forceQuestion } from '../ask/force-question';
import { resolveTargetWorkspace, type TargetDecision } from './target-workspace';
import { resolveCaller, type Caller } from './caller-identity';
import { decideAppTarget } from '../apps/scope';

/**
 * WHO is calling, using the live stores (Tynn #250).
 *
 * The decision itself is pure (`caller-identity.ts`); this is the thin wrapper
 * that hands it the two lookups. Every tool that used to read
 * `getTerminalSpec(id)?.workspace_id` goes through here instead, so an installed
 * GApp resolves to ITS workspace on exactly the same path a terminal does — one
 * implementation of caller authority, not two.
 */
function resolveCallerFor(callerId: string): Caller {
    return resolveCaller(callerId, {
        terminalWorkspaceId: (id) => getTerminalSpec(id)?.workspace_id ?? null,
        appGrant: (appId) => {
            const row = getAppGrant(appId);
            return row
                ? {
                      appId: row.appId,
                      appName: row.name,
                      workspaceId: row.workspaceId,
                      scope: row.scope,
                      workspaces: row.workspaces,
                      capabilities: row.capabilities,
                      revoked: row.revoked,
                  }
                : null;
        },
    });
}

/** The workspace a caller (terminal or GApp) acts from, or null for none. */
export function callerWorkspaceIdFor(callerId: string): string | null {
    return callerId ? resolveCallerFor(callerId).workspaceId : null;
}
import { readTynnLink } from '../tynn/provision';
import {
    readTynnMcpUrl,
    withCodexMcpLaunch,
} from './agent-config';
import { TynnBackend } from '../backend/tynn';
import {
    computeOpsProvisionPlan,
    applyOpsProvision,
    applyOpsScaffold,
    provisionTargets,
    scaffoldTargets,
    parseEnvelopeUrl,
    opsAutoProvisionEnabled,
    type OpsScaffoldTarget,
} from '../tynn/ops-provision';
import { createRepo, getViewer } from '../github/api';
import { broadcastWorkspacesChanged } from '../ipc';
import type {
    WorkspaceMap,
    WorkspaceRepoInfo,
    IssueWatchSnapshot,
    IssueWatchItem,
    ManageProcessRequest,
    ManageProcessResult,
    ManagedProcessInfo,
    ProvisionWorkspacesRequest,
    ProvisionWorkspacesResult,
    OpsChildInfo,
    ManageTerminalsRequest,
    ManageTerminalsResult,
    ManagedTerminalInfo,
    RunAgentRequest,
    RunAgentResult,
    AgentType,
    ManageWorkspacesRequest,
    ManageWorkspacesResult,
    ManagedWorkspaceInfo,
    AgentInboxRequest,
    AgentInboxResult,
    KnowledgeToolRequest,
    KnowledgeToolResult,
} from './protocol';

/**
 * The MCP tool implementations (the `*ForMcp` ServerDeps builders) + their
 * approval gates + helpers — extracted GUI-FREE from background.ts so BOTH the
 * desktop shell AND the headless genie-cloud build assemble `ServerDeps` from
 * them. The approval gates funnel through `forceQuestion`, which routes through
 * the injected QuestionTransport (desktop modal / headless fail-closed), so
 * nothing here touches a BrowserWindow. The only two desktop-GUI side effects —
 * the tray-menu rebuild and surfacing the master window — are injected ports
 * (desktop wires the real ones; headless gets no-ops).
 */
export interface HostToolsDeps {
    /** Rebuild the desktop tray menu (no-op headless). */
    rebuildMenu: () => void;
    /** Surface the master Floor window (no-op headless). */
    showMasterWindow: () => void;
}

let deps: HostToolsDeps = { rebuildMenu: () => {}, showMasterWindow: () => {} };

/** Inject the GUI side-effect hooks (desktop boot wires the Electron impls). */
export function registerHostTools(d: HostToolsDeps): void {
    deps = d;
}

/**
 * Resolve a terminal → its workspace ROOT directory for the env tools
 * (setEnv/checkEnv): a real workspace's path, or the home directory for the
 * synthetic System workspace (mirroring openFileForUser). Null when unresolved.
 */
export function workspaceRootForTerminal(terminalId: string): string | null {
    const wsId = workspaceIdOfTerminal(terminalId);
    if (!wsId) return null;
    if (wsId === SYSTEM_WORKSPACE_ID) return os.homedir();
    return getWorkspace(wsId)?.path ?? null;
}

const MANIFEST_FILES = [
    'package.json',
    'composer.json',
    'Cargo.toml',
    'go.mod',
    'pyproject.toml',
];

/**
 * Build the workspace map for the `initializeWorkspace` MCP tool: resolve the
 * caller's terminal → its workspace, enumerate the repos (reusing the issue-
 * watch repo+remote resolver) and the envelope's orientation files, so a fresh
 * agent gets a map + learning plan. Returns null when the terminal can't be
 * mapped to a workspace.
 */
export async function describeWorkspaceForMcp(
    terminalId: string,
): Promise<WorkspaceMap | null> {
    const workspaceId = callerWorkspaceIdFor(terminalId);
    if (!workspaceId) return null;
    // Agent metadata is a TERMINAL fact; a GApp caller simply has none.
    const terminalSpec = terminalId ? getTerminalSpec(terminalId) : null;
    const ws = listWorkspaces().find((w) => w.id === workspaceId);
    if (!ws) return null;

    const root = ws.path;
    const exists = (...segs: string[]) => fs.existsSync(path.join(root, ...segs));
    const detect = (() => {
        try {
            return detectFolder(root);
        } catch {
            return null;
        }
    })();
    const isAgiEnvelope =
        ws.shape === 'agi' ||
        detect?.state === 'FULL_ENVELOPE' ||
        exists('project.json') ||
        exists('.gitmodules');

    const resolved = await resolveWorkspaceRepos(workspaceId).catch(() => []);
    const repos: WorkspaceRepoInfo[] = resolved.map((r) => {
        const at = (f: string) => fs.existsSync(path.join(r.path, f));
        return {
            name: path.basename(r.path),
            path: r.path,
            owner: r.owner ?? null,
            repo: r.repo ?? null,
            orientation: {
                readme: at('README.md'),
                agents: at('AGENTS.md'),
                claude: at('CLAUDE.md'),
                manifests: MANIFEST_FILES.filter((m) => at(m)),
            },
        };
    });
    const agentType = (terminalSpec?.meta?.agent as string | undefined) ?? null;
    const agentId = (terminalSpec?.meta?.agent_id as string | undefined) ?? null;
    const liveAgent = agentId ? agentInboxBroker.getInfo(agentId) : null;
    const chatSessionId =
        liveAgent?.chatSessionId ??
        (terminalSpec?.meta?.chat_session_id as string | undefined) ??
        null;
    const skillRoot =
        agentType === 'claude'
            ? path.join(root, '.claude', 'skills')
            : path.join(root, '.agents', 'skills');
    const coreSkillNames = [
        'genie',
        'genie-orientation',
        'genie-attention',
        'genie-agentinbox',
        'genie-terminals',
        'genie-workspaces',
        'genie-knowledge',
        'genie-issuewatch',
    ];
    const installedSkills = coreSkillNames.filter((name) =>
        fs.existsSync(path.join(skillRoot, name, 'SKILL.md')),
    );
    const codexConfig = path.join(root, '.codex', 'config.toml');
    const codexHookConfigured =
        agentType === 'codex' &&
        fs.existsSync(codexConfig) &&
        fs.readFileSync(codexConfig, 'utf8').includes('register-session.cjs');

    return {
        root,
        isAgiEnvelope,
        hasProjectJson: exists('project.json'),
        hasGitmodules: exists('.gitmodules'),
        knowledgeDir: exists('.ai', 'knowledge')
            ? path.join(root, '.ai', 'knowledge')
            : null,
        envelopeAgents: exists('AGENTS.md') ? path.join(root, 'AGENTS.md') : null,
        envelopeClaude: exists('CLAUDE.md') ? path.join(root, 'CLAUDE.md') : null,
        repos,
        agentIntegration: {
            agentType,
            agentId,
            chatSessionId,
            sessionBound: Boolean(agentId && chatSessionId),
            codexSessionHook:
                agentType === 'codex'
                    ? {
                          configured: codexHookConfigured,
                          scriptPresent: fs.existsSync(
                              path.join(
                                  root,
                                  '.agents',
                                  'skills',
                                  'genie',
                                  'scripts',
                                  'register-session.cjs',
                              ),
                          ),
                          trust: 'unknown',
                      }
                    : null,
            installedSkills,
        },
        docHealth: (() => {
            const dh = workspaceDocHealth(root);
            return {
                hasAgents: dh.hasAgents,
                hasGenieSection: dh.hasGenieSection,
                claude: dh.claude,
                claudeDivergent: dh.claudeDivergent,
                healthy: dh.healthy,
            };
        })(),
    };
}

/**
 * Back the checkIssues MCP tool AND the IssueWatch counts folded into imDone.
 * Resolves the workspace from the (already terminal-resolved) caller, then
 * returns its open Issues / PRs / security alerts from the IssueWatch feed cache
 * plus the per-bucket counts. Reports `connected: false` when the Tynn
 * IssueWatch stream is unavailable and `workspaceResolved: false` when the terminal
 * maps to no workspace — so the formatter can explain an empty result honestly
 * instead of implying "nothing open".
 */
export async function checkIssuesForMcp(terminalId: string): Promise<IssueWatchSnapshot> {
    const empty = { issue: 0, pr: 0, security: 0 };
    const wsId = callerWorkspaceIdFor(terminalId);
    if (!wsId || !getWorkspace(wsId)) {
        return { connected: false, workspaceResolved: false, counts: empty, items: [] };
    }
    const status = await getWorkspaceStatus(wsId);
    if (!status.connected) {
        return {
            connected: false,
            workspaceResolved: true,
            serviceState: status.serviceState,
            knownToServer: status.knownToServer,
            counts: empty,
            items: [],
        };
    }
    const feed = await getWorkspaceFeed(wsId).catch(() => []);
    const allCounts = await getOpenCounts().catch(
        () => ({}) as Awaited<ReturnType<typeof getOpenCounts>>,
    );
    const counts = allCounts[wsId] ?? empty;
    const items: IssueWatchItem[] = feed.map((it) => ({
        kind: it.kind,
        owner: it.owner,
        repo: it.repo,
        number: it.number,
        title: it.title,
        url: it.url,
        severity: it.severity,
        unread: it.unread,
    }));
    return {
        connected: true,
        workspaceResolved: true,
        knownToServer: status.knownToServer,
        counts,
        items,
        // The user's PER-BUCKET remediation preference rides along so the imDone
        // count line (formatIssueCountsLine) can tell the agent how to act on each
        // bucket. This is a PER-WORKSPACE choice (set in the workspace settings
        // window); a legacy single value resolves to the same policy for all three.
        policy: getWorkspaceIssuewatchPolicyBuckets(wsId),
    };
}

/** A process spec's human command (meta.command), for the manageProcess result. */
function processInfo(workspaceRoot: string, statuses: Record<string, string>) {
    return (spec: ReturnType<typeof listTerminalSpecs>[number]): ManagedProcessInfo => {
        const abs = spec.cwd ?? workspaceRoot;
        let rel = '';
        try {
            rel = path.relative(workspaceRoot, abs).replace(/\\/g, '/');
        } catch {
            rel = '';
        }
        const info: ManagedProcessInfo = {
            id: spec.id,
            label: spec.label,
            command: spec.meta?.command ?? '',
            status: statuses[spec.id] ?? 'stopped',
            autostart: spec.meta?.autostart === true,
            cwd: rel,
            enabled: spec.enabled !== false,
        };
        // Scheduled tasks carry their recurrence + run history. Ordinary
        // processes leave every one of these fields ABSENT, so an agent reading
        // a list can tell the two shapes apart by presence alone.
        const schedule = spec.meta?.schedule;
        if (typeof schedule === 'string' && schedule.trim()) {
            info.schedule = schedule;
            info.scheduleDescription = describeCron(schedule);
            info.scheduleKind = spec.meta?.schedule_kind ?? 'command';
            const next = nextRunAt(spec.id);
            if (next !== null) info.nextRunAt = new Date(next).toISOString();
            if (typeof spec.meta?.last_run_at === 'number') {
                info.lastRunAt = new Date(spec.meta.last_run_at).toISOString();
            }
            if (spec.meta?.last_run_status) info.lastRunStatus = spec.meta.last_run_status;
            if (spec.meta?.schedule_pending_approval === true) info.pendingApproval = true;
        }
        return info;
    };
}

/**
 * When a workspace requires approval (Settings → Agent MCP → "Background
 * process approval"), raise the OS-level ForceTheQuestion modal showing exactly
 * what's about to run (label / command / cwd) and BLOCK until the user decides.
 * Reuses forceQuestion(), so it inherits the wait-indefinitely SSE heartbeat at
 * the MCP layer (it never times out). Returns true to proceed, false on deny or
 * a dismissed modal (treated as deny — never auto-run on dismissal). When the
 * setting is OFF this isn't called and the process runs immediately.
 */
async function approveProcessRun(
    ws: { id: string; project_name: string },
    what: { verb: 'start' | 'run'; label: string; command: string; cwd: string },
): Promise<boolean> {
    const result = await forceQuestion(
        [
            {
                header: 'Run process?',
                question:
                    `An agent wants to ${what.verb} a background process in this workspace:\n\n` +
                    `• ${what.label}\n` +
                    `• command: ${what.command}\n` +
                    `• in: ${what.cwd}\n\n` +
                    `Approve to ${what.verb} it, or deny to block it.`,
                options: [
                    { label: 'Approve', description: `Let the agent ${what.verb} this process.` },
                    { label: 'Deny', description: 'Block it — nothing runs.' },
                ],
            },
        ],
        ws.project_name,
    );
    if (result.cancelled) return false; // dismissed = deny
    const selected = result.answers[0]?.selected ?? [];
    return selected.includes('Approve');
}

/**
 * The scheduled-task sibling of {@link approveProcessRun}, gated by the
 * workspace's `schedule_approval` (Settings → Agent MCP). Same shape, same
 * fail-closed rules — dismissed is a deny — but the question leads with the
 * RECURRENCE, because that's the part a user is actually consenting to: this
 * will run again, unattended, on the Host, until they stop it.
 */
async function approveScheduledTask(
    ws: { id: string; project_name: string },
    what: { label: string; schedule: string; what: string; cwd: string },
): Promise<boolean> {
    const result = await forceQuestion(
        [
            {
                header: 'Arm scheduled task?',
                question:
                    `An agent wants to schedule a recurring task in this workspace:\n\n` +
                    `• ${what.label}\n` +
                    `• when: ${describeCron(what.schedule)}  (${what.schedule})\n` +
                    `• runs: ${what.what}\n` +
                    `• in: ${what.cwd}\n\n` +
                    `It will keep running on this schedule, without asking again, until you disable it.`,
                options: [
                    { label: 'Approve', description: 'Arm the task on this schedule.' },
                    { label: 'Deny', description: 'Block it — nothing is scheduled.' },
                ],
            },
        ],
        ws.project_name,
    );
    if (result.cancelled) return false; // dismissed = deny
    const selected = result.answers[0]?.selected ?? [];
    return selected.includes('Approve');
}

/**
 * Deliver resolved terminal input to a pty: the body now, then — for a MULTI-LINE
 * bracketed paste — the submit Enter as a SEPARATE write after a short delay, so
 * the Enter can't race the TUI exiting paste mode and leave the prompt parked
 * (issue #8). Single-line submits carry the CR inline and skip the second write.
 */
async function deliverTerminalInput(
    id: string,
    built: { bytes: string; submitAfter?: string },
): Promise<void> {
    writeToTerminal(id, built.bytes);
    if (built.submitAfter) {
        await new Promise((resolve) => setTimeout(resolve, PASTE_SUBMIT_DELAY_MS));
        writeToTerminal(id, built.submitAfter);
    }
}

/**
 * Back the manageProcess MCP tool. Resolves the workspace from the (already
 * terminal-resolved) caller, then lists / creates / starts / stops / restarts
 * its background process specs via the existing supervisor + spec store.
 */
export async function manageProcessForMcp(
    terminalId: string,
    req: ManageProcessRequest,
): Promise<ManageProcessResult> {
    const wsId = callerWorkspaceIdFor(terminalId);
    const ws = wsId ? getWorkspace(wsId) : null;
    if (!ws) {
        return { ok: false, error: 'No Genie workspace resolved for this terminal.', processes: [] };
    }
    const listFor = (): ManagedProcessInfo[] => {
        const statuses = getProcessStatuses();
        return listTerminalSpecs()
            .filter((s) => s.workspace_id === ws.id && s.type === 'process')
            .map(processInfo(ws.path, statuses));
    };

    let affectedId: string | undefined;
    try {
        switch (req.action) {
            case 'list':
                break;
            case 'create': {
                const label = req.label?.trim();
                const command = req.command?.trim();
                const schedule = req.schedule?.trim();
                const scheduleKind = schedule ? req.scheduleKind ?? 'command' : undefined;
                const prompt = req.prompt?.trim();
                if (!label) {
                    return { ok: false, error: 'create requires `label`.', processes: listFor() };
                }
                // Validate the recurrence BEFORE anything else: a broken
                // expression must never reach the user's approval modal, and
                // must never leave a spec behind that can't be armed.
                if (schedule && !isValidCron(schedule)) {
                    return {
                        ok: false,
                        error:
                            `Invalid \`schedule\` "${schedule}". Expected 5 cron fields — minute hour day-of-month month day-of-week — e.g. "0 3 * * *".`,
                        processes: listFor(),
                    };
                }
                if (scheduleKind === 'agent-nudge') {
                    if (!prompt) {
                        return {
                            ok: false,
                            error: 'An `agent-nudge` task requires `prompt` — the text delivered to the agent on each fire.',
                            processes: listFor(),
                        };
                    }
                    if (!req.nudgeTerminalId && !req.nudgeAgentId) {
                        return {
                            ok: false,
                            error: 'An `agent-nudge` task requires `nudgeTerminalId` or `nudgeAgentId` — who to nudge.',
                            processes: listFor(),
                        };
                    }
                } else if (!command) {
                    // Every other shape runs a command line.
                    return { ok: false, error: 'create requires `command`.', processes: listFor() };
                }
                // Optional repo subfolder → cwd; else the workspace root. Validate
                // the repo name against the envelope's detected repos.
                let cwd = ws.path;
                if (req.repo) {
                    let repos: string[] = [];
                    try {
                        repos = detectFolder(ws.path).repos ?? [];
                    } catch {
                        repos = [];
                    }
                    if (!repos.includes(req.repo)) {
                        return {
                            ok: false,
                            error: `Unknown repo "${req.repo}". Available: ${repos.join(', ') || '(none)'}.`,
                            processes: listFor(),
                        };
                    }
                    cwd = path.join(ws.path, 'repos', req.repo);
                }
                // The scheduled-task meta, built once and reused by both the
                // pending-approval write and the final one. A scheduled task is
                // one-shot per fire, so `autostart` / `restart_on_exit` are
                // deliberately NOT carried over — they would fight the schedule.
                const scheduleMeta = (): TerminalSpecMeta => ({
                    ...(command ? { command } : {}),
                    schedule,
                    schedule_kind: scheduleKind,
                    ...(scheduleKind === 'agent-nudge'
                        ? {
                              nudge_prompt: prompt,
                              ...(req.nudgeTerminalId
                                  ? { nudge_target_terminal_id: req.nudgeTerminalId }
                                  : {}),
                              ...(req.nudgeAgentId ? { nudge_agent_id: req.nudgeAgentId } : {}),
                          }
                        : {}),
                });
                // Approval gate. A SCHEDULED task answers to `schedule_approval`,
                // a plain process to `process_approval` — separate settings, so a
                // workspace that has loosened one-off process runs still gets asked
                // before an agent arms something recurring. Both fail closed: deny
                // (or a dismissed modal) → nothing is created, started or armed.
                //
                // A scheduled task is created BEFORE the question, DISABLED and
                // flagged `schedule_pending_approval`: the row is visible in the
                // Processes panel while the modal is up (so the user can see
                // exactly what they're approving) and, crucially, a deferred or
                // headless approval leaves a record instead of the request simply
                // vanishing. Disabled + flagged means nothing can arm it —
                // isArmable() and startSchedules() both refuse — so the visible
                // row is inert until approved. Denied → deleted, which is the same
                // end state as the plain-process gate.
                if (schedule && workspaceScheduleApproval(ws.id)) {
                    const pendingId = crypto.randomUUID();
                    createTerminalSpec({
                        id: pendingId,
                        workspace_id: ws.id,
                        label,
                        cwd,
                        type: 'process',
                        meta: { ...scheduleMeta(), schedule_pending_approval: true },
                    });
                    // `enabled` isn't part of the create shape (the column
                    // defaults on), so suspend it immediately — a pending task
                    // must be inert, not merely flagged.
                    updateTerminalSpec(pendingId, { enabled: false });
                    broadcastTerminalSpecsChanged();
                    const approved = await approveScheduledTask(ws, {
                        label,
                        schedule,
                        what:
                            scheduleKind === 'agent-nudge'
                                ? `nudge ${req.nudgeTerminalId ?? req.nudgeAgentId} — "${prompt}"`
                                : (command ?? ''),
                        cwd,
                    });
                    if (!approved) {
                        deleteTerminalSpec(pendingId);
                        broadcastTerminalSpecsChanged();
                        return {
                            ok: false,
                            error: 'Denied by user — the scheduled task was not created.',
                            processes: listFor(),
                        };
                    }
                    // Approved → clear the flag, enable, and arm. This is the only
                    // place an agent-created schedule starts ticking.
                    updateTerminalSpec(pendingId, {
                        enabled: true,
                        meta: { ...scheduleMeta(), schedule_pending_approval: undefined },
                    });
                    affectedId = pendingId;
                    broadcastTerminalSpecsChanged();
                    armSchedule(pendingId);
                    break;
                }
                if (!schedule && workspaceProcessApproval(ws.id)) {
                    const approved = await approveProcessRun(ws, {
                        verb: 'run',
                        label,
                        command: command ?? '',
                        cwd,
                    });
                    if (!approved) {
                        return {
                            ok: false,
                            error: 'Denied by user — the process was not created.',
                            processes: listFor(),
                        };
                    }
                }
                const id = crypto.randomUUID();
                const meta: TerminalSpecMeta = schedule
                    ? scheduleMeta()
                    : { command, autostart: req.autostart === true };
                createTerminalSpec({
                    id,
                    workspace_id: ws.id,
                    label,
                    cwd,
                    type: 'process',
                    meta,
                });
                affectedId = id;
                // The renderer mirrors its OWN spec edits locally but can't see
                // this MCP-side create — tell it the spec set changed so the
                // Processes list shows the new process live (no restart). Must
                // fire whether or not we autostart below (a non-autostart process
                // emits no process:status, so this is its only signal).
                broadcastTerminalSpecsChanged();
                if (schedule) {
                    // Approved (or ungated) → arm it now. This is the ONLY place a
                    // freshly-created schedule starts ticking.
                    armSchedule(id);
                } else if (req.autostart === true) {
                    // autostart → start it now too (matches the "starts on launch" intent).
                    startProcess(id);
                }
                break;
            }
            case 'start':
            case 'stop':
            case 'restart':
            case 'enable':
            case 'disable':
            case 'delete':
            case 'run-now': {
                // `id` is the field `list` reports and the schema's primary name;
                // `processId` is the back-compat alias (issue #7). The MCP layer
                // folds one into the other, but a DIRECT caller may set either, so
                // accept both here rather than silently resolving nothing.
                const id = req.id ?? req.processId;
                const target = id
                    ? listTerminalSpecs().find(
                          (s) => s.id === id && s.workspace_id === ws.id && s.type === 'process',
                      )
                    : undefined;
                if (!target) {
                    return {
                        ok: false,
                        error: `No process "${id ?? ''}" in this workspace. Use action "list" to see ids.`,
                        processes: listFor(),
                    };
                }
                if (req.action === 'enable' || req.action === 'disable') {
                    const enable = req.action === 'enable';
                    updateTerminalSpec(target.id, { enabled: enable });
                    // A disabled task must not fire; an enabled one re-arms from
                    // its CURRENT expression. Enabling also clears a leftover
                    // pending-approval flag — the user just approved it by hand.
                    if (enable) {
                        if (target.meta?.schedule_pending_approval) {
                            updateTerminalSpec(target.id, {
                                meta: { ...target.meta, schedule_pending_approval: undefined },
                            });
                        }
                        armSchedule(target.id);
                    } else {
                        disarmSchedule(target.id);
                        // A disabled LONG-RUNNING process should also stop; a
                        // scheduled task has nothing running between fires.
                        if (!target.meta?.schedule) stopProcess(target.id);
                    }
                    broadcastTerminalSpecsChanged();
                    affectedId = target.id;
                    break;
                }
                if (req.action === 'delete') {
                    stopProcess(target.id);
                    forgetProcess(target.id);
                    forgetSchedule(target.id);
                    deleteTerminalSpec(target.id);
                    broadcastTerminalSpecsChanged();
                    affectedId = target.id;
                    break;
                }
                if (req.action === 'run-now') {
                    if (!target.meta?.schedule) {
                        return {
                            ok: false,
                            error: `"${target.label}" has no \`schedule\` — use action "start" to run an ordinary process.`,
                            processes: listFor(),
                        };
                    }
                    // Already approved when it was armed, and the user can fire it
                    // from the Processes panel, so this isn't separately gated.
                    runScheduleNow(target.id);
                    affectedId = target.id;
                    break;
                }
                if (req.action === 'start') {
                    // Starting is an agent spawning a process — gate it too.
                    // stop (teardown) and restart (an already-approved process)
                    // are not gated.
                    if (workspaceProcessApproval(ws.id)) {
                        const approved = await approveProcessRun(ws, {
                            verb: 'start',
                            label: target.label,
                            command: target.meta?.command ?? '(unknown)',
                            cwd: target.cwd,
                        });
                        if (!approved) {
                            return {
                                ok: false,
                                error: 'Denied by user — the process was not started.',
                                processes: listFor(),
                            };
                        }
                    }
                    startProcess(target.id);
                } else if (req.action === 'stop') stopProcess(target.id);
                else restartProcess(target.id);
                affectedId = target.id;
                break;
            }
        }
    } catch (e) {
        return {
            ok: false,
            error: e instanceof Error ? e.message : String(e),
            processes: listFor(),
        };
    }
    return { ok: true, processes: listFor(), affectedId };
}

/**
 * When the ops-auto-provision toggle is OFF, raise the OS-level ForceTheQuestion
 * modal showing exactly which child workspaces would be cloned (name + repo URL)
 * and BLOCK until the user decides. Reuses forceQuestion(), so it inherits the
 * wait-indefinitely SSE heartbeat at the MCP layer. Returns true to proceed,
 * false on deny or a dismissed modal (treated as deny — never auto-provision on
 * dismissal). When the toggle is ON this isn't called and provisioning runs.
 */
async function approveOpsProvision(
    ws: { project_name: string },
    targets: Array<{ name: string; cloneUrl: string }>,
): Promise<boolean> {
    const list = targets
        .map((t) => `• ${t.name}\n  ${t.cloneUrl}`)
        .join('\n');
    const result = await forceQuestion(
        [
            {
                header: 'Provision?',
                question:
                    `An Ops agent wants to provision Genie workspaces for ${targets.length} governed ` +
                    `child project${targets.length === 1 ? '' : 's'} (clone each one's *.agi repo):\n\n` +
                    `${list}\n\n` +
                    `Approve to clone + open them, or deny to skip.`,
                options: [
                    { label: 'Approve', description: 'Clone + register these child workspaces.' },
                    { label: 'Deny', description: 'Skip — nothing is cloned.' },
                ],
            },
        ],
        ws.project_name,
    );
    if (result.cancelled) return false; // dismissed = deny
    return (result.answers[0]?.selected ?? []).includes('Approve');
}

/**
 * The scaffold gate — ALWAYS raised (the auto-provision toggle never bypasses
 * it): scaffolding CREATES GitHub repos and pushes, a bigger footprint than
 * cloning. Shows exactly which envelopes would be created and from which
 * source repos.
 */
async function approveOpsScaffold(
    ws: { project_name: string },
    targets: OpsScaffoldTarget[],
): Promise<boolean> {
    const list = targets
        .map((t) => `- **${t.name}** — creates \`${t.envelopeUrl}\` around \`${t.sourceRepoUrl}\``)
        .join('\n');
    const result = await forceQuestion(
        [
            {
                header: 'Scaffold?',
                question:
                    `An Ops agent wants to SCAFFOLD ${targets.length} missing \`*.agi\` envelope${targets.length === 1 ? '' : 's'} — for each child below the agent builds the envelope locally around the child's source repo, **creates the GitHub repo**, pushes it, and registers the workspace:\n\n${list}`,
                options: [
                    {
                        label: 'Approve',
                        description: 'Agent: creates + publishes these envelope repos and registers the workspaces.',
                    },
                    {
                        label: 'Deny',
                        description: 'You: nothing is created — handle the envelopes yourself.',
                    },
                ],
            },
        ],
        ws.project_name,
    );
    if (result.cancelled) return false; // dismissed = deny
    return (result.answers[0]?.selected ?? []).includes('Approve');
}

/**
 * The GitHub half of scaffold, kept out of ops-provision.ts: create the
 * envelope repo under the URL's owner — as a PERSONAL repo when that owner is
 * the authenticated user, else under the org (createRepo handles both + reuses
 * an existing empty repo from a previously failed run).
 */
async function createEnvelopeRepo(opts: {
    owner: string;
    name: string;
    description: string;
}): Promise<{ clone_url: string }> {
    let viewerLogin = '';
    try {
        viewerLogin = (await getViewer()).login;
    } catch {
        /* not signed in to GitHub — createRepo will surface the real error */
    }
    const personal = viewerLogin.toLowerCase() === opts.owner.toLowerCase();
    return createRepo({
        name: opts.name,
        owner: personal ? undefined : opts.owner,
        description: opts.description,
        private: true,
    });
}

/**
 * Back the provisionWorkspaces MCP tool. Resolves the Ops workspace from the
 * (already terminal-resolved) caller, computes the governed-children plan, and
 * for `provision` clones + registers the missing child workspaces — honouring
 * the ops_auto_provision_workspaces toggle: OFF blocks on the approval modal
 * (like manageProcess), ON provisions directly. `scaffold` CREATES the
 * envelopes that don't exist remotely (genie#6) and is ALWAYS approval-gated.
 * Gated to Ops workspaces.
 */
export async function provisionWorkspacesForMcp(
    terminalId: string,
    req: ProvisionWorkspacesRequest,
): Promise<ProvisionWorkspacesResult> {
    const wsId = callerWorkspaceIdFor(terminalId);
    const ws = wsId ? getWorkspace(wsId) : null;
    if (!ws) {
        return {
            ok: false,
            error: 'No Genie workspace resolved for this terminal.',
            isOps: false,
            children: [],
        };
    }

    let plan;
    try {
        plan = await computeOpsProvisionPlan(ws.path);
    } catch (e) {
        return {
            ok: false,
            error: e instanceof Error ? e.message : String(e),
            isOps: false,
            children: [],
        };
    }

    if (!plan.signedIn) {
        return {
            ok: false,
            error: 'Not signed in to Tynn — sign in so Genie can read this Ops project\'s governed children.',
            isOps: false,
            children: [],
        };
    }
    if (!plan.isOps) {
        return {
            ok: false,
            error: 'This workspace is not an Ops project, so it has no governed child projects to provision.',
            isOps: false,
            children: [],
        };
    }

    const children: OpsChildInfo[] = plan.children.map((c) => ({
        projectId: c.projectId,
        name: c.name,
        status: c.status,
        cloneUrl: c.cloneUrl,
        remote: c.remote,
        sourceRepoUrl: c.sourceRepoUrl,
    }));

    if (req.action === 'status') {
        return { ok: true, isOps: true, children };
    }

    if (req.action === 'scaffold') {
        const targets = scaffoldTargets(plan);
        if (targets.length === 0) {
            return {
                ok: true,
                isOps: true,
                children,
                scaffolded: [],
                errors: [],
            };
        }
        // Bad-URL targets never reach the apply step half-parsed.
        const parseable = targets.filter((t) => parseEnvelopeUrl(t.envelopeUrl));
        // Scaffold ALWAYS gates — it creates GitHub repos, never auto-approved.
        const approved = await approveOpsScaffold(ws, parseable);
        if (!approved) {
            return {
                ok: false,
                error: 'Denied by user — no envelopes were scaffolded.',
                isOps: true,
                children,
            };
        }
        const result = await applyOpsScaffold(ws.path, parseable, createEnvelopeRepo);
        if (result.scaffolded.length > 0) {
            broadcastWorkspacesChanged();
            deps.rebuildMenu();
        }
        const scaffoldedIds = new Set(result.scaffolded.map((p) => p.workspaceId));
        return {
            ok: true,
            isOps: true,
            children: children.map((c) =>
                scaffoldedIds.has(c.projectId)
                    ? { ...c, status: 'present' as const, cloneUrl: null, remote: null }
                    : c,
            ),
            scaffolded: result.scaffolded.map((p) => p.name),
            errors: result.errors,
        };
    }

    // action === 'provision'
    const targets = provisionTargets(plan);
    if (targets.length === 0) {
        // Nothing to do — every governed child already has a workspace (or the
        // missing ones can't be resolved to a clone URL / don't exist remotely,
        // surfaced per-child in `children` (remote: 'not-found' → scaffold).
        return { ok: true, isOps: true, children, provisioned: [], errors: [] };
    }

    // Approval gate: OFF (default) → block on the modal; ON → straight through.
    if (!opsAutoProvisionEnabled()) {
        const approved = await approveOpsProvision(ws, targets);
        if (!approved) {
            return {
                ok: false,
                error: 'Denied by user — no workspaces were provisioned.',
                isOps: true,
                children,
            };
        }
    }

    const result = await applyOpsProvision(ws.path, targets);
    if (result.provisioned.length > 0) {
        // The rail mirrors its own workspace edits but can't see this MCP-side
        // clone — tell it the set changed so the new workspaces appear live.
        broadcastWorkspacesChanged();
        deps.rebuildMenu();
    }
    // Re-derive child statuses post-provision so the caller sees what changed.
    const provisionedIds = new Set(result.provisioned.map((p) => p.workspaceId));
    const childrenAfter: OpsChildInfo[] = children.map((c) =>
        provisionedIds.has(c.projectId)
            ? { ...c, status: 'present', cloneUrl: null }
            : c,
    );
    return {
        ok: true,
        isOps: true,
        children: childrenAfter,
        provisioned: result.provisioned.map((p) => p.name),
        errors: result.errors,
    };
}

// --- Agent terminal / agent / workspace control (manageTerminals · runAgent ·
//     manageWorkspaces) ------------------------------------------------------
//
// These give an agent in a workspace the power to spawn terminals, run code in
// them, and launch + drive coding agents — in its OWN workspace AND in any
// workspace it governs (Ops → child). Two safety layers, both mandatory:
//
//   1. CROSS-WORKSPACE AUTHORIZATION (resolveAgentTarget) — the action's target
//      must be the caller's own workspace OR one it governs. Anything else is
//      rejected before any side effect. The governed set is resolved via the
//      SAME Ops-slaves path provisionWorkspaces uses, mapped to local workspace
//      ids (a child's local workspace id == its Tynn project id).
//   2. APPROVAL GATE (approveTerminalAction) — every code-executing / agent-
//      driving action (create / write / runAgent start / send) blocks on the
//      OS modal until the user approves, UNLESS the TARGET workspace has its
//      terminal-approval toggle OFF. read / list / kill / status are not gated.

/**
 * The set of LOCAL workspace ids the given Ops workspace governs. Reads the
 * workspace's Tynn link → ops-slaves, and keeps only those slaves that have a
 * local workspace registered (a child's local id == its Tynn project id). Empty
 * for a non-Ops / signed-out / unlinked caller, or on any failure — fail CLOSED.
 */
async function governedWorkspaceIdsFor(
    callerWorkspacePath: string,
): Promise<Set<string>> {
    const out = new Set<string>();
    const link = readTynnLink(callerWorkspacePath);
    if (!link?.projectId) return out;
    const backend = new TynnBackend();
    if (!(await backend.whoami())) return out;
    const { isOpsProject, slaves } = await backend.opsSlaves(link.projectId);
    if (!isOpsProject) return out;
    const localIds = new Set(listWorkspaces().map((w) => w.id));
    for (const s of slaves) {
        // A governed child is actionable only if it has a local workspace.
        if (localIds.has(s.id)) out.add(s.id);
    }
    return out;
}

/** True when the caller's workspace is an Ops project (backend `is_ops_project`).
 *  Backs the tools/list gate that hides the ops-only `provisionWorkspaces` tool
 *  from non-Ops workspaces. Fails CLOSED (false) on any error so an uncertain
 *  state never EXPOSES the ops tool. */
export async function isOpsProjectFor(callerWorkspacePath: string): Promise<boolean> {
    const link = readTynnLink(callerWorkspacePath);
    if (!link?.projectId) return false;
    try {
        const backend = new TynnBackend();
        if (!(await backend.whoami())) return false;
        const { isOpsProject } = await backend.opsSlaves(link.projectId);
        return isOpsProject;
    } catch {
        return false;
    }
}

/**
 * Resolve + authorize the workspace a tool call should act on. The caller's
 * terminal → its workspace is the default; a different `workspaceId` is allowed
 * only when the caller governs it. Returns the decision (with the resolved
 * workspace row when allowed) so handlers share one chokepoint.
 */
export async function resolveAgentTarget(
    callerTerminalId: string,
    requestedWorkspaceId: string | undefined,
): Promise<{ decision: TargetDecision; ws: ReturnType<typeof getWorkspace> | null }> {
    // A caller is a terminal OR an installed GApp (Tynn #250). Both land here, so
    // there is one answer to "may this caller act there?" instead of a second,
    // laxer path for apps.
    const caller = resolveCallerFor(callerTerminalId);
    if (caller.kind === 'app') {
        // App rules, not agent rules: an app never governs children and is never
        // the workstation operator — its reach is exactly the scope the user
        // granted at install.
        const decision = decideAppTarget(caller.workspaceId, requestedWorkspaceId, {
            scope: caller.grant.scope,
            ...(caller.grant.workspaces ? { workspaces: caller.grant.workspaces } : {}),
        });
        return {
            decision,
            ws: decision.allowed ? getWorkspace(decision.workspaceId) ?? null : null,
        };
    }

    const callerWorkspaceId = caller.workspaceId;
    const callerWs = callerWorkspaceId ? getWorkspace(callerWorkspaceId) : null;
    const decision = await resolveTargetWorkspace(requestedWorkspaceId, {
        callerWorkspaceId,
        governedWorkspaceIds: () =>
            callerWs
                ? governedWorkspaceIdsFor(callerWs.path)
                : Promise.resolve(new Set<string>()),
        // WORKSTATION OPERATOR (Tynn #248). Read from the caller's OWN workspace
        // row, never from the request: the authority has to come from what the
        // machine was configured to trust, not from what a caller claims.
        callerIsOperator: callerWorkspaceId ? isWorkstationOperator(callerWorkspaceId) : false,
    });
    const ws = decision.allowed ? getWorkspace(decision.workspaceId) ?? null : null;
    return { decision, ws };
}

/**
 * Block on the OS modal until the user approves a code-executing / agent-driving
 * action in `ws`, UNLESS the workspace has terminal-approval turned OFF. Mirrors
 * approveProcessRun: dismiss = deny, never auto-run on dismissal. Returns true to
 * proceed.
 */
async function approveTerminalAction(
    ws: { id: string; project_name: string },
    what: { title: string; lines: string[] },
): Promise<boolean> {
    if (!workspaceTerminalApproval(ws.id)) return true; // gate OFF → straight through
    const result = await forceQuestion(
        [
            {
                header: 'Allow?',
                question:
                    `${what.title}\n\n` +
                    `${what.lines.map((l) => `• ${l}`).join('\n')}\n\n` +
                    'Approve to allow it, or deny to block it.',
                options: [
                    { label: 'Approve', description: 'Allow this action.' },
                    { label: 'Deny', description: 'Block it — nothing runs.' },
                ],
            },
        ],
        ws.project_name,
    );
    if (result.cancelled) return false; // dismissed = deny
    return (result.answers[0]?.selected ?? []).includes('Approve');
}

/**
 * Resolve a create/launch cwd from an optional repo subfolder or an explicit
 * cwd, validated against the workspace. Returns { cwd } or { error }.
 */
function resolveAgentCwd(
    ws: { path: string },
    opts: { repo?: string; cwd?: string },
): { cwd: string } | { error: string } {
    if (opts.cwd) {
        // Absolute → use as-is; relative → resolve under the workspace root.
        const abs = path.isAbsolute(opts.cwd)
            ? path.normalize(opts.cwd)
            : path.join(ws.path, opts.cwd);
        // Containment: a relative cwd must stay inside the workspace. An absolute
        // cwd is allowed (the agent may legitimately target a sibling path it
        // owns), but a relative one escaping via .. is rejected.
        if (!path.isAbsolute(opts.cwd)) {
            const rel = path.relative(ws.path, abs);
            if (rel.startsWith('..')) {
                return { error: `cwd "${opts.cwd}" escapes the workspace.` };
            }
        }
        return { cwd: abs };
    }
    if (opts.repo) {
        let repos: string[] = [];
        try {
            repos = detectFolder(ws.path).repos ?? [];
        } catch {
            repos = [];
        }
        if (!repos.includes(opts.repo)) {
            return {
                error: `Unknown repo "${opts.repo}". Available: ${repos.join(', ') || '(none)'}.`,
            };
        }
        return { cwd: path.join(ws.path, 'repos', opts.repo) };
    }
    return { cwd: ws.path };
}

/** List a workspace's (non-process) terminals for the manageTerminals result. */
function listAgentTerminals(ws: { id: string; path: string }): ManagedTerminalInfo[] {
    return listTerminalSpecs()
        .filter((s) => s.workspace_id === ws.id && s.type !== 'process')
        .map((s) => {
            let rel = '';
            try {
                rel = path.relative(ws.path, s.cwd ?? ws.path).replace(/\\/g, '/');
            } catch {
                rel = '';
            }
            const agent = (s.meta?.agent as ManagedTerminalInfo['agent']) ?? null;
            const chatSessionId = (s.meta?.chat_session_id as string | undefined) ?? null;
            return { id: s.id, label: s.label, cwd: rel, agent, chatSessionId };
        });
}

/** Back the manageTerminals MCP tool (spawn/drive terminals; gated). */
export async function manageTerminalsForMcp(
    callerTerminalId: string,
    req: ManageTerminalsRequest,
): Promise<ManageTerminalsResult> {
    const { decision, ws } = await resolveAgentTarget(callerTerminalId, req.workspaceId);
    if (!decision.allowed || !ws) {
        return { ok: false, error: decision.reason, terminals: [] };
    }

    // A target terminal (write/read/kill) must belong to the resolved workspace —
    // never let an agent reach a terminal in a workspace it can't act on.
    const ownTerminal = (id: string | undefined) =>
        !!id &&
        !!listTerminalSpecs().find(
            (s) => s.id === id && s.workspace_id === ws.id && s.type !== 'process',
        );

    try {
        switch (req.action) {
            case 'list':
                return { ok: true, terminals: listAgentTerminals(ws) };
            case 'read': {
                if (!ownTerminal(req.id)) {
                    return {
                        ok: false,
                        error: `No terminal "${req.id ?? ''}" in this workspace.`,
                        terminals: listAgentTerminals(ws),
                    };
                }
                const r = readTerminalOutput(req.id!, {
                    cursor: req.cursor,
                    bytes: req.bytes,
                });
                return {
                    ok: true,
                    terminals: listAgentTerminals(ws),
                    affectedId: req.id,
                    data: req.strip ? stripAnsi(r.data) : r.data,
                    cursor: r.cursor,
                    dropped: r.dropped,
                    // Whether an empty read means "quiet", "restored from the pty
                    // host after a Genie restart", or "no pty at all" (genie#217).
                    state: r.state,
                };
            }
            case 'kill': {
                if (!ownTerminal(req.id)) {
                    return {
                        ok: false,
                        error: `No terminal "${req.id ?? ''}" in this workspace.`,
                        terminals: listAgentTerminals(ws),
                    };
                }
                killTerminalById(req.id!);
                return { ok: true, terminals: listAgentTerminals(ws), affectedId: req.id };
            }
            case 'create': {
                const cwdR = resolveAgentCwd(ws, { repo: req.repo, cwd: req.cwd });
                if ('error' in cwdR) {
                    return { ok: false, error: cwdR.error, terminals: listAgentTerminals(ws) };
                }
                const label = req.label?.trim() || 'Agent terminal';
                const approved = await approveTerminalAction(ws, {
                    title: 'An agent wants to open a terminal (it can run any command):',
                    lines: [label, `in: ${cwdR.cwd}`],
                });
                if (!approved) {
                    return {
                        ok: false,
                        error: 'Denied by user — no terminal was created.',
                        terminals: listAgentTerminals(ws),
                    };
                }
                const { id } = createAgentTerminal({
                    workspaceId: ws.id,
                    cwd: cwdR.cwd,
                    label,
                });
                // Give the shell a moment, then return its initial scrollback.
                const r = readTerminalOutput(id, {});
                return {
                    ok: true,
                    terminals: listAgentTerminals(ws),
                    affectedId: id,
                    data: r.data,
                    cursor: r.cursor,
                };
            }
            case 'write': {
                if (!ownTerminal(req.id)) {
                    return {
                        ok: false,
                        error: `No terminal "${req.id ?? ''}" in this workspace.`,
                        terminals: listAgentTerminals(ws),
                    };
                }
                const built = resolveTerminalInput(req.data, {
                    submit: req.submit,
                    key: req.key,
                });
                if ('error' in built) {
                    return {
                        ok: false,
                        error: `write ${built.error}`,
                        terminals: listAgentTerminals(ws),
                    };
                }
                const approved = await approveTerminalAction(ws, {
                    title: 'An agent wants to send input to a terminal:',
                    lines: [`terminal: ${req.id}`, `input: ${JSON.stringify(built.preview)}`],
                });
                if (!approved) {
                    return {
                        ok: false,
                        error: 'Denied by user — nothing was sent.',
                        terminals: listAgentTerminals(ws),
                    };
                }
                await deliverTerminalInput(req.id!, built);
                return { ok: true, terminals: listAgentTerminals(ws), affectedId: req.id };
            }
        }
    } catch (e) {
        return {
            ok: false,
            error: e instanceof Error ? e.message : String(e),
            terminals: listAgentTerminals(ws),
        };
    }
    // Unreachable (every action returns), but TS needs a terminal value.
    return { ok: false, error: 'Unhandled action.', terminals: listAgentTerminals(ws) };
}

/**
 * Resolve the CLI command for an agent type from the configurable settings, or
 * an explicit override. `custom` has no default — it needs an explicit command
 * (here or in Settings). Returns null when nothing resolves.
 */
export function resolveAgentCommand(agent: AgentType, override?: string): string | null {
    const o = override?.trim();
    if (o) return o;
    const s = getAllSettings();
    if (agent === 'claude') return (s.agent_command_claude || 'claude').trim() || 'claude';
    if (agent === 'codex') return (s.agent_command_codex || 'codex').trim() || 'codex';
    // custom: only the configured custom command (no built-in default).
    const c = (s.agent_command_custom || '').trim();
    return c || null;
}

/**
 * Resolve an agent's FULL launch command: the base command
 * ({@link resolveAgentCommand}) plus the user's ALWAYS-ON flags for that agent
 * type (`agent_flags_<agent>` in Settings), appended after the command. Both
 * launch paths (specialized-terminal create + runAgent start) go through this so
 * the flags apply everywhere. The session-id flag is injected LATER (in
 * createAgentTerminal's `renderAgentLaunch`), giving the order
 * `<command> <flags> --session-id <uuid>` — and that injection already skips
 * adding a second `--session-id` if the user's flags happen to include one.
 * Returns null when no base command resolves (same contract as
 * resolveAgentCommand).
 */
export function resolveAgentLaunch(
    agent: AgentType,
    override?: string,
    workspace?: { id: string; path: string },
): string | null {
    const base = resolveAgentCommand(agent, override);
    if (!base) return null;
    const s = getAllSettings();
    const flags =
        agent === 'claude'
            ? s.agent_flags_claude
            : agent === 'codex'
              ? s.agent_flags_codex
              : s.agent_flags_custom;
    const withFlags = appendLaunchFlags(base, flags);
    // Without a workspace there are no URLs to resolve; the gate (Codex + sync-on)
    // itself lives in withCodexMcpLaunch so it's unit-tested off host-tools.
    if (!workspace) {
        return withFlags;
    }
    // Only the WORKSPACE-scoped Tynn override is baked here. The genie endpoint is
    // deliberately NOT: it must be the TERMINAL's own per-terminal URL so its token
    // self-identifies the terminal (genie #35) — a workspace-scoped genie URL makes
    // the server REFUSE every multi-terminal call lacking `terminalId`. The terminal
    // id doesn't exist yet at this point, so the genie `-c` override is woven in
    // later, at terminal-create time, via withCodexGenieMcpLaunch (see terminal/ipc).
    return withCodexMcpLaunch(withFlags, {
        agent,
        mcpSyncCodexOff: s.mcp_sync_codex === 'off',
        tynnUrl: readTynnMcpUrl(workspace.path),
    });
}

/**
 * Create a SPECIALIZED (AI-TUI) terminal from the UI — the shared path behind
 * BOTH the local `terminal-spec:create-agent` IPC and the remote host endpoint
 * (`POST /api/desktop/terminal-spec/create-agent`). Resolves the agent's launch
 * command, spawns the headless agent terminal (stamping its captured chat-session
 * id + AgentInbox identity/accessibility, joining the broker), and submits the
 * boot command. No approval gate — the human is creating it directly in their own
 * (or the host's) Genie. Returns the persisted spec, or a clear error.
 */
export function createSpecializedAgentTerminal(input: {
    workspace_id: string;
    agent: AgentType;
    command?: string;
    cwd?: string;
    label?: string;
    purpose: string;
    scope: AgentInboxScope;
    scope_workspaces?: string[];
    wake_on_dm?: boolean;
    /** IssueWatch pings: participate in this workspace's IssueWatch deltas. */
    issuewatch_handle?: boolean;
    /** IssueWatch pings: how to react — glow (`notify`) or idle-wake (`wake`). */
    issuewatch_action?: 'notify' | 'wake';
}): { ok: boolean; spec?: TerminalSpecRow; error?: string } {
    const ws = getWorkspace(input.workspace_id);
    if (!ws) return { ok: false, error: 'Workspace not found.' };
    // Base command + the agent type's always-on flags (session-id injected later).
    const command = resolveAgentLaunch(input.agent, input.command, ws);
    if (!command) {
        return {
            ok: false,
            error:
                input.agent === 'custom'
                    ? 'A custom agent needs a command (here or in Settings → Agent commands).'
                    : `No command configured for agent "${input.agent}".`,
        };
    }
    let cwd = ws.path;
    if (input.cwd && input.cwd.trim()) {
        cwd = path.isAbsolute(input.cwd)
            ? path.normalize(input.cwd)
            : path.join(ws.path, input.cwd);
    }
    const label = input.label?.trim() || `${input.agent} · ${normalizePurpose(input.purpose)}`;
    // Spawns the pty AND launches the agent CLI into it, host-side (genie #63).
    const { id } = createAgentTerminal({
        workspaceId: ws.id,
        cwd,
        label,
        agentMeta: { agent: input.agent, command },
        agentInbox: {
            purpose: input.purpose,
            scope: input.scope,
            scopeWorkspaces: input.scope_workspaces,
            wakeOnDm: input.wake_on_dm,
        },
        issuewatch: {
            handle: input.issuewatch_handle,
            action: input.issuewatch_action,
        },
    });
    return { ok: true, spec: getTerminalSpec(id) ?? undefined };
}

/**
 * Apply an agent-settings edit — AgentInbox purpose / scope / wake-on-DM — to a
 * specialized terminal: LIVE-update the broker (so a running agent's accessibility
 * + wake opt-in change immediately) AND persist the durable bits to the spec meta,
 * then broadcast the spec change so every window's sidebar refreshes. Shared by the
 * local IPC handler (`agentInbox:update-channel`) AND the remote host route
 * (`POST /api/desktop/agentinbox/update-channel`) so a REMOTE window edits the HOST
 * agent through the exact same path — they can't drift.
 */
export function updateAgentInboxChannel(
    specId: string,
    patch: {
        purpose?: string;
        scope?: AgentInboxScope;
        scope_workspaces?: string[];
        wake_on_dm?: boolean;
        /** IssueWatch pings: participate in this workspace's IssueWatch deltas. */
        issuewatch_handle?: boolean;
        /** IssueWatch pings: how to react — glow (`notify`) or idle-wake (`wake`). */
        issuewatch_action?: 'notify' | 'wake';
    },
): { ok: boolean; error?: string } {
    const spec = getTerminalSpec(specId);
    if (!spec) return { ok: false, error: 'Terminal not found.' };
    const agentId = spec.meta?.agent_id;
    if (!agentId) return { ok: false, error: 'That terminal is not an AgentInbox agent.' };

    // A purpose rename must also refresh the DISPLAY LABEL (`<agent> · <purpose>`),
    // which drives the terminal header, sidebar row, AND AgentInbox — otherwise
    // it stays frozen at the creation-time value. Only recompute an AUTO-DERIVED
    // label (still `<agent> · …`); never clobber a custom label passed at creation.
    let nextLabel: string | undefined;
    if (patch.purpose !== undefined) {
        const agent = spec.meta?.agent;
        const looksDerived = agent != null && spec.label.startsWith(`${agent} · `);
        if (looksDerived) nextLabel = `${agent} · ${normalizePurpose(patch.purpose)}`;
    }

    agentInboxBroker.setAccessibility(agentId, {
        scope: patch.scope,
        workspaces: patch.scope_workspaces,
        purpose: patch.purpose,
        wakeOnDm: patch.wake_on_dm,
        label: nextLabel,
    });
    // Persist the durable bits to the spec meta + refresh the sidebar row. The
    // IssueWatch prefs live only in spec meta (no broker state) — the routing path
    // reads them off the spec when a delta lands.
    const meta = { ...spec.meta };
    if (patch.purpose !== undefined) meta.whisper_purpose = normalizePurpose(patch.purpose);
    if (patch.scope !== undefined) meta.whisper_scope = patch.scope;
    if (patch.scope_workspaces !== undefined) meta.whisper_workspaces = patch.scope_workspaces;
    if (patch.wake_on_dm !== undefined) meta.whisper_wake_on_dm = patch.wake_on_dm;
    if (patch.issuewatch_handle !== undefined) meta.issuewatch_handle = patch.issuewatch_handle;
    if (patch.issuewatch_action !== undefined) meta.issuewatch_action = patch.issuewatch_action;
    updateTerminalSpec(specId, nextLabel !== undefined ? { meta, label: nextLabel } : { meta });
    broadcastTerminalSpecsChanged();
    return { ok: true };
}

export type RestartAgentResult =
    | { ok: true; oldId: string; newId: string; agent: AgentInboxAgentType; command: string }
    | { ok: false; error: string };

/**
 * GRACEFULLY restart an agent terminal so its TUI reconnects to the (possibly
 * updated) MCP rig WITHOUT losing the conversation (wish #88): tear the current
 * agent down, then relaunch it in a fresh terminal with `--resume <captured-id>`.
 * Claude persists its session to disk continuously, so the resumed CLI continues
 * where it left off while re-reading the current `.mcp.json` + getting a fresh
 * agent MCP endpoint. REFUSES (no teardown) when the terminal isn't a resumable
 * agent — no captured session id, or a non-claude agent — so a restart can never
 * silently drop the conversation into a fresh, context-less session.
 */
export function restartAgentTerminal(id: string): RestartAgentResult {
    const spec = getTerminalSpec(id);
    const agent = spec?.meta?.agent;
    if (!spec || !agent) {
        return { ok: false, error: `"${id}" is not an agent terminal.` };
    }
    // Resolve the relaunch command with the ON-DISK transcript check, so a
    // drifted session id falls back to `--continue` instead of dead-ending at
    // `--resume <phantom>` ("No conversation found" — reads as lost work). Refuses
    // when the terminal has no resumable conversation.
    const decision = resolveRestartCommand(spec, (sid) => agentSessionTranscriptExists(spec, sid));
    if ('error' in decision) {
        return { ok: false, error: decision.error };
    }
    const resume = decision.command;

    // Tear the old agent down FIRST (releases its pty + MCP endpoint + AgentInbox
    // presence) so two processes never share the session id, THEN relaunch the
    // resumed agent in a fresh terminal that picks up the current rig.
    killTerminalById(id);
    const restarted = createAgentTerminal({
        workspaceId: spec.workspace_id!,
        cwd: spec.cwd,
        label: spec.label,
        agentMeta: { agent, command: resume },
        agentInbox: {
            purpose: spec.meta?.whisper_purpose,
            scope: spec.meta?.whisper_scope,
            scopeWorkspaces: spec.meta?.whisper_workspaces,
            // genie #65: the teardown above dropped the old agent from every
            // channel. Carry its explicitly-joined rooms onto the relaunched
            // identity, or a restart silently evicts it from the rooms it was
            // coordinating in — with its next channel send reporting a
            // delivered-to-nobody success.
            channels: Array.isArray(spec.meta?.whisper_channels)
                ? (spec.meta.whisper_channels as string[])
                : [],
        },
    });
    // createAgentTerminal launches it host-side; renderAgentLaunch leaves a
    // resume/continue command untouched (it already carries the session), so what
    // was submitted is `restarted.command` === resume.
    return { ok: true, oldId: id, newId: restarted.id, agent, command: restarted.command ?? resume };
}

/** Back the runAgent MCP tool (launch + drive a coding agent; gated). */
export async function runAgentForMcp(
    callerTerminalId: string,
    req: RunAgentRequest,
): Promise<RunAgentResult> {
    const { decision, ws } = await resolveAgentTarget(callerTerminalId, req.workspaceId);
    if (!decision.allowed || !ws) {
        return { ok: false, error: decision.reason };
    }

    const ownTerminal = (id: string | undefined) =>
        !!id &&
        !!listTerminalSpecs().find(
            (s) => s.id === id && s.workspace_id === ws.id && s.type !== 'process',
        );

    try {
        switch (req.action) {
            case 'start': {
                const agent: AgentType = req.agent ?? 'claude';
                // Base command + the agent type's always-on flags (session-id
                // injected later in createAgentTerminal).
                const command = resolveAgentLaunch(agent, req.command, ws);
                if (!command) {
                    return {
                        ok: false,
                        error:
                            agent === 'custom'
                                ? 'runAgent custom needs a `command` (or set agent_command_custom in Settings).'
                                : `No command configured for agent "${agent}".`,
                    };
                }
                const cwdR = resolveAgentCwd(ws, { repo: req.repo, cwd: req.cwd });
                if ('error' in cwdR) return { ok: false, error: cwdR.error };

                const approved = await approveTerminalAction(ws, {
                    title: `An agent wants to LAUNCH a ${agent} coding agent (it can read, write, and run code on its own):`,
                    lines: [`command: ${command}`, `in: ${cwdR.cwd}`],
                });
                if (!approved) {
                    return { ok: false, error: 'Denied by user — no agent was launched.' };
                }
                // Spawns the pty AND launches the agent CLI into it, host-side —
                // the agent is running the moment this returns, whether or not
                // anyone ever opens the panel (genie #63 Phase 0).
                const { id } = createAgentTerminal({
                    workspaceId: ws.id,
                    cwd: cwdR.cwd,
                    label: `${agent} agent`,
                    agentMeta: { agent, command },
                });
                return { ok: true, id, agent, command };
            }
            case 'send': {
                if (!ownTerminal(req.id)) {
                    return { ok: false, error: `No agent terminal "${req.id ?? ''}" in this workspace.` };
                }
                const built = resolveTerminalInput(req.prompt, {
                    submit: req.submit,
                    key: req.key,
                });
                if ('error' in built) {
                    return { ok: false, error: `send ${built.error}` };
                }
                const approved = await approveTerminalAction(ws, {
                    title: 'An agent wants to send a prompt to a running coding agent:',
                    lines: [`terminal: ${req.id}`, `prompt: ${JSON.stringify(built.preview)}`],
                });
                if (!approved) {
                    return { ok: false, error: 'Denied by user — nothing was sent.' };
                }
                await deliverTerminalInput(req.id!, built);
                return { ok: true, id: req.id };
            }
            case 'read': {
                if (!ownTerminal(req.id)) {
                    return { ok: false, error: `No agent terminal "${req.id ?? ''}" in this workspace.` };
                }
                const r = readTerminalOutput(req.id!, { cursor: req.cursor, bytes: req.bytes });
                return {
                    ok: true,
                    id: req.id,
                    data: req.strip ? stripAnsi(r.data) : r.data,
                    cursor: r.cursor,
                    dropped: r.dropped,
                    state: r.state,
                };
            }
            case 'stop': {
                if (!ownTerminal(req.id)) {
                    return { ok: false, error: `No agent terminal "${req.id ?? ''}" in this workspace.` };
                }
                killTerminalById(req.id!);
                return { ok: true, id: req.id };
            }
            case 'restart': {
                if (!ownTerminal(req.id)) {
                    return { ok: false, error: `No agent terminal "${req.id ?? ''}" in this workspace.` };
                }
                // Restarting relaunches an agent CLI (it can read/write/run code) —
                // gate it like start.
                const approved = await approveTerminalAction(ws, {
                    title: 'An agent wants to RESTART a running coding agent — relaunch its TUI (resuming the same conversation) so it picks up genie rig / protocol updates:',
                    lines: [`terminal: ${req.id}`],
                });
                if (!approved) {
                    return { ok: false, error: 'Denied by user — the agent was not restarted.' };
                }
                const r = restartAgentTerminal(req.id!);
                if (!r.ok) return { ok: false, error: r.error };
                return { ok: true, id: r.newId, agent: r.agent, command: r.command };
            }
        }
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    return { ok: false, error: 'Unhandled action.' };
}

/**
 * Write an agent's CURRENT channel membership to its spec meta (genie #65).
 *
 * The broker's `channelMembers` map is pure runtime state, so a membership that
 * only lives there dies on the next restart or agent-terminal relaunch — which
 * is exactly how a joined agent found itself silently out of a room. Called
 * after every action that can change membership (`join`, `leave`, and a channel
 * `send`, which auto-joins). Only the EXPLICIT rooms are stored; the agent's own
 * purpose room is re-derived from `whisper_purpose` on rejoin.
 */
function persistAgentChannels(specId: string, agentId: string): void {
    const cur = getTerminalSpec(specId);
    if (!cur) return;
    const channels = agentInboxBroker.persistableChannelKeys(agentId);
    const prev = Array.isArray(cur.meta?.whisper_channels)
        ? (cur.meta.whisper_channels as string[])
        : [];
    // Cheap equality — membership changes rarely, and a no-op write would churn
    // the spec row (and its change broadcast) on every channel send.
    if (prev.length === channels.length && prev.every((k, i) => k === channels[i])) return;
    updateTerminalSpec(specId, { meta: { ...cur.meta, whisper_channels: channels } });
}

/**
 * Back the AgentInbox MCP `agentinbox` tool. Resolves (or lazily creates) the
 * caller's AgentInbox identity from its terminal, then dispatches the action against
 * the in-memory broker:
 *   - `list` — the caller's self info + discoverable peers (scope-filtered) + its
 *     channels.
 *   - `send {to?|channel?, text, interrupt?}` — DM a discoverable peer, or
 *     broadcast on a channel (auto-joining it). `interrupt` nudges a DM target's
 *     terminal glow; it never injects into the pty.
 *   - `receive {cursor?, wait?, timeoutMs?}` — page the inbox; `wait` LONG-POLLS
 *     (this takes the SSE keepalive path in the server, like ForceTheQuestion).
 *   - `setAccessibility {scope, workspaces?, purpose?}` — change visibility; a
 *     `specific` workspace list is validated against what the caller GOVERNS (∪
 *     its own) so an agent can't expose itself to unrelated workspaces. Persisted
 *     to the spec meta (durable across restart).
 *   - `join`/`leave {channel}` — opt in/out of a channel (a bare purpose targets
 *     the caller's own workspace room; `slug:purpose` targets another's).
 *     Persisted to the spec meta, like accessibility, so a membership survives a
 *     restart instead of silently lapsing (genie #65).
 *
 * A NON-agent caller (a plain terminal that runs an agent and calls agentinbox) is
 * lazily joined with defaults (`self` scope, `general` purpose) so any Genie
 * terminal can participate.
 */
export async function agentInboxForMcp(
    callerTerminalId: string,
    req: AgentInboxRequest,
): Promise<AgentInboxResult> {
    const spec = callerTerminalId ? getTerminalSpec(callerTerminalId) : null;
    if (!spec || !spec.workspace_id) {
        return { ok: false, error: 'This terminal is not in a workspace, so it can’t use agentinbox.' };
    }
    const ws = getWorkspace(spec.workspace_id);
    if (!ws) return { ok: false, error: 'Workspace not found.' };

    // Resolve — or lazily create — the caller's AgentInbox identity.
    let agentId = spec.meta?.agent_id;
    if (!agentId) {
        agentId = crypto.randomUUID();
        const meta: TerminalSpecMeta = {
            ...spec.meta,
            agent: (spec.meta?.agent as AgentInboxAgentType) ?? 'custom',
            agent_id: agentId,
            whisper_purpose: normalizePurpose(spec.meta?.whisper_purpose),
            whisper_scope: (spec.meta?.whisper_scope as AgentInboxScope) ?? 'self',
        };
        updateTerminalSpec(spec.id, { meta });
        agentInboxBroker.join({
            agentId,
            terminalId: spec.id,
            workspaceId: ws.id,
            workspaceName: ws.project_name,
            slug: workspaceSlug(ws),
            agentType: meta.agent as AgentInboxAgentType,
            label: spec.label,
            purpose: meta.whisper_purpose!,
            scope: meta.whisper_scope as AgentInboxScope,
            scopeWorkspaces: Array.isArray(meta.whisper_workspaces)
                ? (meta.whisper_workspaces as string[])
                : [],
            chatSessionId: (meta.chat_session_id as string | undefined) ?? null,
        });
    } else {
        agentInboxBroker.markOnline(agentId);
        // SELF-HEAL (genie #65): the broker is in-memory, so an agent calling in
        // after a host restart may be registered without the rooms it joined —
        // the spec meta is the durable record. Re-apply it (idempotent; the
        // workspace tier is re-checked inside `join`) so a returning agent finds
        // itself where it left off instead of silently alone.
        const durable = Array.isArray(spec.meta?.whisper_channels)
            ? (spec.meta.whisper_channels as string[])
            : [];
        const live = new Set(agentInboxBroker.persistableChannelKeys(agentId));
        for (const key of durable) {
            if (!live.has(key)) agentInboxBroker.joinChannel(agentId, key);
        }
    }

    try {
        switch (req.action) {
            case 'list':
                return {
                    ok: true,
                    self: agentInboxBroker.getInfo(agentId) ?? undefined,
                    agents: agentInboxBroker.discoverableFor(agentId),
                    channels: agentInboxBroker.channelsForAgent(agentId),
                };
            case 'send': {
                if (!req.text || !req.text.trim()) {
                    return { ok: false, error: 'send needs a non-empty `text`.' };
                }
                if (!req.to && !req.channel) {
                    return { ok: false, error: 'send needs `to` (an agent) or `channel`.' };
                }
                // Attachments are read + stored BEFORE the message is created, so
                // a message never claims files that aren't in the store. The read
                // is confined to the SENDER's own workspace, and a single bad path
                // fails the whole send rather than silently shipping a subset.
                //
                // A send the broker then REFUSES (unreachable peer, closed
                // workspace) leaves the stored bytes behind. That is deliberate:
                // pre-checking reachability here would mean a second copy of the
                // broker's two-tier gate that could drift from the real one — the
                // very staleness `send` re-checks for. The store is
                // content-addressed (a repeat costs nothing) and reclaiming
                // unreferenced blobs is a sweep, not a send-path concern.
                let attachments: AgentInboxAttachment[] = [];
                if (req.attachments?.length) {
                    try {
                        attachments = await collectAttachmentsForSend({
                            workspaceRoot: ws.path,
                            paths: req.attachments,
                            storeRoot: attachmentStoreRoot(),
                            newId: () => crypto.randomUUID(),
                        });
                    } catch (e) {
                        return {
                            ok: false,
                            error: `Nothing was sent — ${e instanceof Error ? e.message : String(e)}`,
                        };
                    }
                }
                const r = agentInboxBroker.send({
                    fromAgentId: agentId,
                    toAgentId: req.to,
                    channelArg: req.channel,
                    text: req.text,
                    interrupt: req.interrupt,
                    attachments,
                });
                // A channel send auto-joins the room — make that membership durable
                // so it isn't silently lost on the next restart (genie #65).
                if (req.channel) persistAgentChannels(spec.id, agentId);
                // `delivered` / `channel` / `rejoined` ride BOTH arms: a broadcast
                // that reached NOBODY comes back `ok: false` (it used to read as a
                // clean success and the report was lost), and the caller still needs
                // the facts to act on it.
                return r.ok
                    ? {
                          ok: true,
                          delivered: r.delivered,
                          ...(attachments.length ? { attachments } : {}),
                          ...(r.channel ? { channel: r.channel, rejoined: r.rejoined === true } : {}),
                      }
                    : {
                          ok: false,
                          error: r.error,
                          ...(r.channel
                              ? { delivered: r.delivered ?? 0, channel: r.channel, rejoined: r.rejoined === true }
                              : {}),
                      };
            }
            case 'receive': {
                const { messages, cursor } = await agentInboxBroker.receive(agentId, {
                    cursor: req.cursor,
                    wait: req.wait,
                    timeoutMs: req.timeoutMs,
                });
                return { ok: true, messages, cursor };
            }
            case 'receipts': {
                // Read-receipts for the caller's sent DMs: `seen` once the recipient's
                // ACK cursor passed the message (issue #9) — so a sender can tell
                // 'queued' from 'seen' and decide whether to escalate to a nudge.
                return { ok: true, receipts: agentInboxBroker.receipts(agentId, req.limit) };
            }
            case 'saveAttachment': {
                // Write a received file into the CALLER's own workspace. Two gates,
                // both fail-closed: the broker only resolves an attachment for an
                // agent the MESSAGE reached (an id is a handle, not a capability),
                // and the write itself is confined to `ws.path`.
                const attachmentId = String(req.attachmentId ?? '').trim();
                if (!attachmentId) {
                    return { ok: false, error: 'saveAttachment needs an `attachmentId`.' };
                }
                const att = agentInboxBroker.attachmentFor(agentId, attachmentId);
                if (!att) {
                    // Deliberately ONE message for "no such attachment" and "not
                    // yours": distinguishing them would let an agent probe for
                    // attachments in conversations it was never part of.
                    return {
                        ok: false,
                        error: 'No such attachment, or it was not sent to you. Attachment ids come from a message you received via `receive`.',
                    };
                }
                try {
                    const saved = await saveAttachmentToWorkspace({
                        workspaceRoot: ws.path,
                        storeRoot: attachmentStoreRoot(),
                        attachment: att,
                        destPath: req.path,
                        overwrite: req.overwrite,
                    });
                    return { ok: true, savedPath: saved.relPath, savedBytes: saved.bytes };
                } catch (e) {
                    return { ok: false, error: e instanceof Error ? e.message : String(e) };
                }
            }
            case 'registerSession': {
                const registered = registerAgentInboxSession(spec.id, req.sessionId ?? '', {
                    getTerminalSpec,
                    updateTerminalSpec,
                    setChatSession: (id, sessionId) =>
                        agentInboxBroker.setChatSession(id, sessionId),
                });
                if (!registered.ok) return registered;
                broadcastTerminalSpecsChanged();
                return {
                    ok: true,
                    self: agentInboxBroker.getInfo(registered.agentId) ?? undefined,
                };
            }
            case 'setAccessibility': {
                // A `specific` visibility list is limited to workspaces the caller
                // GOVERNS (∪ its own) — an agent can't make itself discoverable to
                // arbitrary unrelated workspaces (a discovery leak). Fail-closed.
                let workspaces = req.workspaces;
                if (req.scope === 'specific') {
                    const governed = await governedWorkspaceIdsFor(ws.path).catch(
                        () => new Set<string>(),
                    );
                    const allowed = new Set<string>([ws.id, ...governed]);
                    workspaces = (req.workspaces ?? []).filter((id) => allowed.has(id));
                }
                const info = agentInboxBroker.setAccessibility(agentId, {
                    scope: req.scope,
                    workspaces,
                    purpose: req.purpose,
                    wakeOnDm: req.wakeOnDm,
                });
                // Persist the durable bits to the spec meta.
                const cur = getTerminalSpec(spec.id);
                if (cur) {
                    const meta: TerminalSpecMeta = { ...cur.meta };
                    if (req.scope !== undefined) meta.whisper_scope = req.scope;
                    if (workspaces !== undefined) meta.whisper_workspaces = workspaces;
                    if (req.purpose !== undefined) meta.whisper_purpose = normalizePurpose(req.purpose);
                    if (req.wakeOnDm !== undefined) meta.whisper_wake_on_dm = req.wakeOnDm;
                    updateTerminalSpec(spec.id, { meta });
                }
                return { ok: true, self: info ?? undefined };
            }
            case 'join': {
                if (!req.channel) return { ok: false, error: 'join needs a `channel`.' };
                const ok = agentInboxBroker.joinChannel(agentId, req.channel);
                if (!ok) return { ok: false, error: `Couldn't resolve channel "${req.channel}".` };
                // Durable membership (genie #65) — a join that lives only in the
                // broker's memory evaporates on the next restart.
                persistAgentChannels(spec.id, agentId);
                return { ok: true, channels: agentInboxBroker.channelsForAgent(agentId) };
            }
            case 'leave': {
                if (!req.channel) return { ok: false, error: 'leave needs a `channel`.' };
                agentInboxBroker.leaveChannel(agentId, req.channel);
                persistAgentChannels(spec.id, agentId);
                return { ok: true, channels: agentInboxBroker.channelsForAgent(agentId) };
            }
        }
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    return { ok: false, error: 'Unhandled agentinbox action.' };
}

/**
 * Back the workstation Knowledge Graph MCP `knowledge` tool. Unlike the other
 * tools this is NOT workspace-scoped — the store is workstation-wide (one shared
 * store across every workspace), so any agent in any workspace reads/writes it
 * and the caller's terminal is not resolved to a workspace here. Dispatches
 * against the shared {@link getKnowledgeStore}:
 *   - `search {query, limit?, tags?}` — keyword (FTS) retrieval.
 *   - `get {id}` — one node + its resolved links.
 *   - `add {title, body?, tags?, links?}` — create a node (source `agent`).
 *   - `list {tag?, limit?}` — recent nodes.
 *   - `link {from, to}` — add an edge.
 */
export async function knowledgeForMcp(
    _callerTerminalId: string,
    req: KnowledgeToolRequest,
): Promise<KnowledgeToolResult> {
    try {
        const store = getKnowledgeStore();
        switch (req.action) {
            case 'search': {
                const query = String(req.query ?? '').trim();
                if (!query) return { ok: false, error: 'search needs a non-empty `query`.' };
                const results = store.search({
                    query,
                    limit: req.limit,
                    tags: req.tags,
                });
                return { ok: true, results };
            }
            case 'get': {
                const id = String(req.id ?? '').trim();
                if (!id) return { ok: false, error: 'get needs an `id`.' };
                return { ok: true, node: store.get(id) };
            }
            case 'add': {
                const title = String(req.title ?? '').trim();
                if (!title) return { ok: false, error: 'add needs a `title`.' };
                const node = store.add({
                    title,
                    body: req.body,
                    tags: req.tags,
                    links: req.links,
                    source: 'agent',
                });
                return { ok: true, id: node.id };
            }
            case 'list': {
                const nodes = store.list({ tag: req.tag, limit: req.limit });
                return { ok: true, nodes };
            }
            case 'link': {
                const from = String(req.from ?? '').trim();
                const to = String(req.to ?? '').trim();
                if (!from || !to) return { ok: false, error: 'link needs `from` and `to`.' };
                const r = store.link(from, to);
                return r.ok ? { ok: true } : { ok: false, error: r.error };
            }
        }
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    return { ok: false, error: 'Unhandled knowledge action.' };
}

/** The caller's own workspace + every workspace it governs (manageWorkspaces). */
async function actionableWorkspaces(
    callerTerminalId: string,
): Promise<ManagedWorkspaceInfo[]> {
    const callerWorkspaceId = callerTerminalId
        ? getTerminalSpec(callerTerminalId)?.workspace_id ?? null
        : null;
    const callerWs = callerWorkspaceId ? getWorkspace(callerWorkspaceId) : null;
    const out: ManagedWorkspaceInfo[] = [];
    if (callerWs) {
        out.push({
            id: callerWs.id,
            name: callerWs.project_name,
            path: callerWs.path,
            relation: 'self',
        });
        let governed = new Set<string>();
        try {
            governed = await governedWorkspaceIdsFor(callerWs.path);
        } catch {
            governed = new Set();
        }
        // WORKSTATION OPERATOR (Tynn #248): every workspace on this machine is
        // actionable, so LIST them. Without this half the permission is useless —
        // an operator that may act on a workspace it cannot see still cannot
        // diagnose the site that is down in it, which is the reason the
        // designation exists.
        const operator = isWorkstationOperator(callerWs.id);
        for (const w of listWorkspaces()) {
            if (w.id === callerWs.id) continue;
            if (governed.has(w.id)) {
                out.push({
                    id: w.id,
                    name: w.project_name,
                    path: w.path,
                    relation: 'governed',
                });
            } else if (operator) {
                // Reported as `operator`, not `governed`: the caller does not own
                // this workspace, it merely has authority over the machine, and a
                // list that blurred the two would misrepresent why it is reachable.
                out.push({
                    id: w.id,
                    name: w.project_name,
                    path: w.path,
                    relation: 'operator',
                });
            }
        }
    }
    return out;
}

/** Back the manageWorkspaces MCP tool (status + open/activate/remove; authorized). */
export async function manageWorkspacesForMcp(
    callerTerminalId: string,
    req: ManageWorkspacesRequest,
): Promise<ManageWorkspacesResult> {
    const workspaces = await actionableWorkspaces(callerTerminalId);

    if (req.action === 'list' || req.action === 'status') {
        return { ok: true, workspaces };
    }

    // open / activate / remove all target a specific workspace (own or governed).
    const { decision, ws } = await resolveAgentTarget(callerTerminalId, req.workspaceId);
    if (!decision.allowed || !ws) {
        return { ok: false, error: decision.reason, workspaces };
    }
    try {
        switch (req.action) {
            case 'open':
                await openWorkspace(ws.id);
                break;
            case 'activate':
                // Activating = focus its window (open() already brings it forward)
                // and surface it. openWorkspace is the existing "make it the
                // active workspace" path.
                await openWorkspace(ws.id);
                deps.showMasterWindow();
                break;
            case 'remove':
                // UNREGISTER only — never touch disk. Mirrors the workspaces:remove
                // IPC. The caller can't remove its own workspace out from under
                // itself; guard that to avoid orphaning this very terminal.
                if (ws.id === workspaces.find((w) => w.relation === 'self')?.id) {
                    return {
                        ok: false,
                        error: "Refusing to unregister the caller's own workspace.",
                        workspaces,
                    };
                }
                // Same order as the `workspaces:remove` IPC: the Dev Server
                // teardown reads this workspace's sites and services, so it has
                // to run while the row still exists. (#234 P4)
                await devLifecycle()
                    ?.onWorkspaceRemove(ws.id)
                    .catch((e) => console.error('[dev-server] teardown failed', e));
                removeWorkspace(ws.id);
                broadcastWorkspacesChanged();
                deps.rebuildMenu();
                break;
        }
    } catch (e) {
        return {
            ok: false,
            error: e instanceof Error ? e.message : String(e),
            workspaces,
        };
    }
    return {
        ok: true,
        workspaces: await actionableWorkspaces(callerTerminalId),
        affectedId: ws.id,
    };
}

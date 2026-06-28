import {
    app,
    BrowserWindow,
    ipcMain,
    nativeImage,
    Notification,
    session,
} from 'electron';
import fs from 'fs';
import path from 'path';
import { createTray, rebuildMenu } from './tray';
import { registerShortcuts, unregisterShortcuts } from './shortcuts';
import { launchedFromAutostart } from './autostart';
import { registerIpcHandlers } from './ipc';
import crypto from 'node:crypto';
import {
    initDatabase,
    listWorkspaces,
    listTerminalSpecs,
    getAllSettings,
    getTerminalSpec,
    getWorkspace,
    createTerminalSpec,
    workspaceProcessApproval,
    workspaceTerminalApproval,
    getWorkspaceIssuewatchPolicy,
    removeWorkspace,
} from './db';
import { writeWorkspaceAgentMcp } from './mcp/agent-config';
import { resolveAlertSound } from './notify-sound';
import { workspaceDocHealth, repairWorkspaceDocs } from './workspace/create-agi';
import { registerForceQuestionIpc, forceQuestion } from './ask/force-question';
import {
    registerIssueWatchIpc,
    resolveWorkspaceRepos,
    getWorkspaceFeed,
    getOpenCounts,
} from './issue-watch';
import { getToken } from './github/storage';
import { detectFolder } from './workspace/detect';
import type {
    WorkspaceMap,
    WorkspaceRepoInfo,
    IssueWatchSnapshot,
    IssueWatchItem,
} from './mcp/protocol';
import { registerProtocolHandler, handleGenieUrl } from './auth';
import {
    registerTerminalIpc,
    stopAllTerminals,
    requestFinalSnapshots,
    snapshotRetainedWindowless,
    terminalHasWindow,
    broadcastTerminalAttention,
    broadcastWorkspacePulse,
    broadcastTerminalSpecsChanged,
    killTerminalById,
    lastActiveTerminalForWorkspace,
    reapOrphanTerminals,
    createAgentTerminal,
    writeToTerminal,
    readTerminalOutput,
} from './terminal/ipc';
import {
    buildSubmitBytes,
    resolveTerminalInput,
    stripAnsi,
} from './terminal/keystrokes';
import {
    startMcpServer,
    workspaceEndpointUrl,
    DEFAULT_MCP_PORT,
} from './mcp/server';
import { startControlServer } from './control';
import { startMobileServer, DEFAULT_MOBILE_PORT } from './mobile/server';
import {
    listPendingQuestions,
    answerPendingQuestion,
} from './ask/force-question';
import { listAllProcesses } from './terminal/process-list';
import {
    startAutostartProcesses,
    startProcess,
    stopProcess,
    restartProcess,
    getProcessStatuses,
} from './terminal/process-supervisor';
import type {
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
    ManageWorkspacesRequest,
    ManageWorkspacesResult,
    ManagedWorkspaceInfo,
    AgentType,
} from './mcp/protocol';
import { resolveTargetWorkspace, type TargetDecision } from './mcp/target-workspace';
import { TynnBackend } from './backend/tynn';
import { readTynnLink } from './tynn/provision';
import { openWorkspace } from './workspace/open';
import {
    computeOpsProvisionPlan,
    applyOpsProvision,
    provisionTargets,
    opsAutoProvisionEnabled,
} from './tynn/ops-provision';
import { broadcastWorkspacesChanged } from './ipc';
import {
    initTerminalBackend,
    isHostBacked,
    disconnectHostLeaveRunning,
    terminalManager,
} from '@particle-academy/fancy-term-host';
import {
    wireTerminalAdapter,
    killHostForUpdate,
    snapshotHostTerminalsForUpdate,
    getSnapshotStore,
    detachedTerminalsEnabled,
} from './terminal/genie-adapter';
import {
    activateHostService,
    hostBackendKind,
    selectTerminalBackend,
    shouldKillHostForUpdate,
    detachedHostPinsBinary,
} from './terminal/host-service';
import {
    liveHostTerminals,
    shouldConfirmQuit,
    confirmQuitTerminals,
    pickDialogWindow,
} from './terminal/quit-confirm';
import { workspaceIdOfTerminal } from './terminal/workspace-of-terminal';
import { isQuittingForUpdate } from './updater/quit-state';
import { registerFilesIpc } from './files/ipc';
import { registerGithubIpc } from './github/ipc';
import {
    registerCapabilityIpc,
    runBootCapabilityCheck,
} from './github/capability-service';
import {
    registerUpdaterIpc,
    checkForUpdatesNow,
    mobileUpdateStatus,
    mobileInstallUpdate,
    mobileCheckUpdate,
} from './updater/ipc';
import { registerDocsIpc } from './docs/ipc';
import { installAppMenu } from './app-menu';
import {
    isE2E,
    isE2EMobile,
    registerE2EMocks,
    startMobileE2EServer,
} from './e2e/mock';

/**
 * Genie — Tynn desktop companion.
 *
 * Architecture:
 *   - Main process owns everything sensitive (db, filesystem, git ops,
 *     sub-process spawning, session cookies).
 *   - Renderer (Next.js) is read-only across IPC; talks via typed channels.
 *   - Tray icon is the durable surface; windows are spawned lazily.
 *
 * Story #149 — scaffold + tray. Subsequent stories layer on top.
 */

const isProd = process.env.NODE_ENV === 'production';
const isDev = !isProd;

/**
 * Notify the user that an agent called imDone, per the Customization settings:
 *   - notify_sound → broadcast `notify:sound` so a renderer synthesizes a chime
 *     (no audio asset shipped; the tray window is always alive to play it).
 *   - notify_toast → an OS notification (the "tray popup"), reusing Electron's
 *     native Notification (proven in updater/ipc.ts).
 * Both default off and are independent of the always-on attention glow.
 */
function notifyImDone(terminalId: string): void {
    let settings;
    try {
        settings = getAllSettings();
    } catch {
        return;
    }
    // Resolve the per-alert sound choice (synth / bundled wav / custom file →
    // data-URL / off). A null descriptor means "off" for this alert — skip the
    // chime entirely. Only resolved when the master sound gate is on.
    const sound =
        settings.notify_sound === 'on' ? resolveAlertSound('imDone') : null;
    if (sound) {
        // Send to exactly one live renderer so the chime plays once. A hidden
        // window still runs its renderer, so this works tray-resident too.
        const target =
            (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null) ??
            BrowserWindow.getAllWindows()[0];
        target?.webContents.send('notify:sound', { kind: 'imDone', sound });
    }
    if (settings.notify_toast === 'on' && Notification.isSupported()) {
        const label = getTerminalSpec(terminalId)?.label ?? 'A terminal';
        const n = new Notification({
            title: 'Genie — agent finished',
            body: `${label} is done and waiting for you.`,
            // Silence the OS chime only when OUR chime actually plays, so we
            // don't double up — but if the alert sound is off, let the OS sound.
            silent: !!sound,
        });
        n.on('click', () => {
            const win = mainWindow ?? BrowserWindow.getAllWindows()[0];
            win?.show();
            win?.focus();
        });
        n.show();
    }
}

/** Detect which package manifests sit at a repo root (orientation hint). */
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
async function describeWorkspaceForMcp(
    terminalId: string,
): Promise<WorkspaceMap | null> {
    const workspaceId = terminalId
        ? getTerminalSpec(terminalId)?.workspace_id ?? null
        : null;
    if (!workspaceId) return null;
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
 * plus the per-bucket counts. Reports `connected: false` when GitHub has no
 * token (nothing is polled) and `workspaceResolved: false` when the terminal
 * maps to no workspace — so the formatter can explain an empty result honestly
 * instead of implying "nothing open".
 */
async function checkIssuesForMcp(terminalId: string): Promise<IssueWatchSnapshot> {
    const empty = { issue: 0, pr: 0, security: 0 };
    const wsId = terminalId ? getTerminalSpec(terminalId)?.workspace_id ?? null : null;
    if (!wsId || !getWorkspace(wsId)) {
        return { connected: !!getToken(), workspaceResolved: false, counts: empty, items: [] };
    }
    if (!getToken()) {
        return { connected: false, workspaceResolved: true, counts: empty, items: [] };
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
        counts,
        items,
        // The user's remediation preference rides along so the imDone count line
        // (formatIssueCountsLine) can tell the agent how to act on these. This is
        // a PER-WORKSPACE choice (set in the workspace settings window).
        policy: getWorkspaceIssuewatchPolicy(wsId),
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
        return {
            id: spec.id,
            label: spec.label,
            command: spec.meta?.command ?? '',
            status: statuses[spec.id] ?? 'stopped',
            autostart: spec.meta?.autostart === true,
            cwd: rel,
        };
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
 * Back the manageProcess MCP tool. Resolves the workspace from the (already
 * terminal-resolved) caller, then lists / creates / starts / stops / restarts
 * its background process specs via the existing supervisor + spec store.
 */
async function manageProcessForMcp(
    terminalId: string,
    req: ManageProcessRequest,
): Promise<ManageProcessResult> {
    const wsId = terminalId ? getTerminalSpec(terminalId)?.workspace_id ?? null : null;
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
                if (!label || !command) {
                    return { ok: false, error: 'create requires `label` and `command`.', processes: listFor() };
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
                // Approval gate: when the workspace requires it, block until the
                // user approves THIS process (label/command/cwd). Deny → nothing
                // is created or started. OFF → straight through (current behavior).
                if (workspaceProcessApproval(ws.id)) {
                    const approved = await approveProcessRun(ws, {
                        verb: 'run',
                        label,
                        command,
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
                createTerminalSpec({
                    id,
                    workspace_id: ws.id,
                    label,
                    cwd,
                    type: 'process',
                    meta: { command, autostart: req.autostart === true },
                });
                affectedId = id;
                // The renderer mirrors its OWN spec edits locally but can't see
                // this MCP-side create — tell it the spec set changed so the
                // Processes list shows the new process live (no restart). Must
                // fire whether or not we autostart below (a non-autostart process
                // emits no process:status, so this is its only signal).
                broadcastTerminalSpecsChanged();
                // autostart → start it now too (matches the "starts on launch" intent).
                if (req.autostart === true) startProcess(id);
                break;
            }
            case 'start':
            case 'stop':
            case 'restart': {
                const id = req.processId;
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
 * Back the provisionWorkspaces MCP tool. Resolves the Ops workspace from the
 * (already terminal-resolved) caller, computes the governed-children plan, and
 * for `provision` clones + registers the missing child workspaces — honouring
 * the ops_auto_provision_workspaces toggle: OFF blocks on the approval modal
 * (like manageProcess), ON provisions directly. Gated to Ops workspaces.
 */
async function provisionWorkspacesForMcp(
    terminalId: string,
    req: ProvisionWorkspacesRequest,
): Promise<ProvisionWorkspacesResult> {
    const wsId = terminalId ? getTerminalSpec(terminalId)?.workspace_id ?? null : null;
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
    }));

    if (req.action === 'status') {
        return { ok: true, isOps: true, children };
    }

    // action === 'provision'
    const targets = provisionTargets(plan);
    if (targets.length === 0) {
        // Nothing to do — every governed child already has a workspace (or the
        // missing ones can't be resolved to a clone URL, surfaced in children).
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
        rebuildMenu();
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
async function isOpsProjectFor(callerWorkspacePath: string): Promise<boolean> {
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
async function resolveAgentTarget(
    callerTerminalId: string,
    requestedWorkspaceId: string | undefined,
): Promise<{ decision: TargetDecision; ws: ReturnType<typeof getWorkspace> | null }> {
    const callerWorkspaceId = callerTerminalId
        ? getTerminalSpec(callerTerminalId)?.workspace_id ?? null
        : null;
    const callerWs = callerWorkspaceId ? getWorkspace(callerWorkspaceId) : null;
    const decision = await resolveTargetWorkspace(requestedWorkspaceId, {
        callerWorkspaceId,
        governedWorkspaceIds: () =>
            callerWs
                ? governedWorkspaceIdsFor(callerWs.path)
                : Promise.resolve(new Set<string>()),
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
            return { id: s.id, label: s.label, cwd: rel, agent };
        });
}

/** Back the manageTerminals MCP tool (spawn/drive terminals; gated). */
async function manageTerminalsForMcp(
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
                writeToTerminal(req.id!, built.bytes);
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
function resolveAgentCommand(agent: AgentType, override?: string): string | null {
    const o = override?.trim();
    if (o) return o;
    const s = getAllSettings();
    if (agent === 'claude') return (s.agent_command_claude || 'claude').trim() || 'claude';
    if (agent === 'codex') return (s.agent_command_codex || 'codex').trim() || 'codex';
    // custom: only the configured custom command (no built-in default).
    const c = (s.agent_command_custom || '').trim();
    return c || null;
}

/** Back the runAgent MCP tool (launch + drive a coding agent; gated). */
async function runAgentForMcp(
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
                const command = resolveAgentCommand(agent, req.command);
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
                const { id } = createAgentTerminal({
                    workspaceId: ws.id,
                    cwd: cwdR.cwd,
                    label: `${agent} agent`,
                    agentMeta: { agent, command },
                });
                // Launch the agent CLI in the fresh shell. A single-line command
                // submits on the trailing CR, same as a shell Enter.
                writeToTerminal(id, buildSubmitBytes(command, true));
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
                writeToTerminal(req.id!, built.bytes);
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
                };
            }
            case 'stop': {
                if (!ownTerminal(req.id)) {
                    return { ok: false, error: `No agent terminal "${req.id ?? ''}" in this workspace.` };
                }
                killTerminalById(req.id!);
                return { ok: true, id: req.id };
            }
        }
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    return { ok: false, error: 'Unhandled action.' };
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
        for (const w of listWorkspaces()) {
            if (governed.has(w.id) && w.id !== callerWs.id) {
                out.push({
                    id: w.id,
                    name: w.project_name,
                    path: w.path,
                    relation: 'governed',
                });
            }
        }
    }
    return out;
}

/** Back the manageWorkspaces MCP tool (status + open/activate/remove; authorized). */
async function manageWorkspacesForMcp(
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
                showMasterWindow();
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
                removeWorkspace(ws.id);
                broadcastWorkspacesChanged();
                rebuildMenu();
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

// Single-instance lock. If a second copy of Genie is launched (e.g. clicking
// a genie:// URL), the existing process gets the activation event and the
// second one exits. This is also how the Windows protocol handoff works.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
}

let mainWindow: BrowserWindow | null = null;
let captureWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let docsWindow: BrowserWindow | null = null;
let masterWindow: BrowserWindow | null = null;
const terminalWindows = new Set<BrowserWindow>();

export function getMainWindow(): BrowserWindow | null {
    return mainWindow;
}

/**
 * Open the master window and tell its renderer to surface the Task Manager
 * (the cross-workspace process panel). Used by the tray's "Task Manager…"
 * item. Sends after the webContents finishes loading so a freshly-created
 * window receives the event once its renderer is ready.
 */
export function openTaskManagerWindow(): void {
    showMasterWindow();
    const win = masterWindow;
    if (!win || win.isDestroyed()) return;
    const send = () => {
        if (!win.isDestroyed()) win.webContents.send('open-task-manager');
    };
    // A pre-existing window is already loaded → send now; a fresh one needs to
    // finish loading first (did-finish-load fires once the renderer mounts).
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
    else send();
}

/**
 * Open TheFloor — the unified workspace + terminal management window.
 * Hosts the cross-project terminal tree, the workspace CRUD sidebar,
 * the layout grid, and the project context menu. Single instance —
 * clicking the tray entry while already open just focuses it.
 */
export function showMasterWindow(): void {
    // Whenever the window comes to the front, refresh the update check so
    // the header pill reflects reality (throttled in the updater). Genie
    // lives in the tray, so this is the moment the user can actually see
    // the result.
    checkForUpdatesNow();
    if (masterWindow && !masterWindow.isDestroyed()) {
        masterWindow.show();
        masterWindow.focus();
        return;
    }
    const win = new BrowserWindow({
        width: 1280,
        height: 820,
        minWidth: 980,
        minHeight: 620,
        show: false,
        // Hidden native title bar — the in-app .titlebar row is the drag
        // region, so the window presents one "Genie" chrome instead of a
        // native label + menu bar duplicating it. The overlay keeps the
        // native min/max/close cluster (and its snap layouts flyout) on
        // Windows; macOS keeps inset traffic lights.
        title: 'Genie',
        titleBarStyle: 'hidden',
        ...(process.platform !== 'darwin'
            ? {
                  titleBarOverlay: {
                      color: '#0a0a0c',
                      symbolColor: '#a1a1aa',
                      height: 46,
                  },
              }
            : {}),
        autoHideMenuBar: true,
        backgroundColor: '#0a0a0c',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });

    if (isDev) {
        win.loadURL('http://localhost:8888/master');
    } else {
        win.loadFile(path.join(__dirname, 'master.html'));
    }

    win.once('ready-to-show', () => win.show());
    // Re-check on focus too — catches the case where Genie was left open
    // for hours and a release shipped in the meantime (throttled).
    win.on('focus', () => checkForUpdatesNow());
    win.on('closed', () => {
        if (masterWindow === win) masterWindow = null;
    });
    masterWindow = win;
}

/**
 * Open a Stage — a satellite TheFloor window pinned to a single project
 * by default. Multiple stages can be open at once; each one has its own
 * selection + layout state. Stages share the underlying ptys with
 * TheFloor (via the multi-attach manager), so a terminal running in
 * TheFloor will mirror its live output into the Stage when added.
 */
const stageWindows = new Set<BrowserWindow>();
export function showStageWindow(workspaceId?: string): void {
    const win = new BrowserWindow({
        width: 1100,
        height: 720,
        minWidth: 900,
        minHeight: 560,
        show: false,
        // Same hidden-titlebar treatment as the master window — one chrome.
        title: 'Genie',
        titleBarStyle: 'hidden',
        ...(process.platform !== 'darwin'
            ? {
                  titleBarOverlay: {
                      color: '#0a0a0c',
                      symbolColor: '#a1a1aa',
                      height: 46,
                  },
              }
            : {}),
        autoHideMenuBar: true,
        backgroundColor: '#0a0a0c',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });
    const query = workspaceId
        ? `?stage=${encodeURIComponent(workspaceId)}`
        : '?stage=1';
    if (isDev) {
        win.loadURL(`http://localhost:8888/master${query}`);
    } else {
        win.loadFile(path.join(__dirname, 'master.html'), {
            search: query.slice(1),
        });
    }
    win.once('ready-to-show', () => win.show());
    stageWindows.add(win);
    win.on('closed', () => stageWindows.delete(win));
}

/**
 * Open a standalone terminal window — used by the tray menu's "New
 * terminal" entry and (later) by the workspace UI. The window loads the
 * `/terminal` route, which mounts an XTerm bound to a fresh pty.
 */
export function showTerminalWindow(): void {
    const win = new BrowserWindow({
        width: 880,
        height: 560,
        show: false,
        frame: true,
        title: 'Genie · Terminal',
        backgroundColor: '#09090b',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });

    if (isDev) {
        win.loadURL('http://localhost:8888/terminal');
    } else {
        win.loadFile(path.join(__dirname, 'terminal.html'));
    }

    win.once('ready-to-show', () => win.show());
    terminalWindows.add(win);
    win.on('closed', () => terminalWindows.delete(win));
}

export function getCaptureWindow(): BrowserWindow | null {
    return captureWindow;
}

export function getSettingsWindow(): BrowserWindow | null {
    return settingsWindow;
}

/**
 * The legacy `/tray` BrowserWindow was retired in favour of TheFloor as the
 * single unified surface. Every old call site (auth callback, second-
 * instance handler, macOS dock click, IPC) now lands in TheFloor instead.
 * Kept exported only so existing imports compile; the underlying
 * `createMainWindow` is no longer reachable.
 */
export function showMainWindow(): void {
    showMasterWindow();
}

export function showSettingsWindow(): void {
    if (!settingsWindow || settingsWindow.isDestroyed()) {
        settingsWindow = createSettingsWindow();
        // createSettingsWindow defers .show() to 'ready-to-show'; just
        // wait for it. focus() also no-ops until the window is visible.
        settingsWindow.once('ready-to-show', () => settingsWindow?.focus());
        return;
    }
    settingsWindow.show();
    settingsWindow.focus();
}

export function getDocsWindow(): BrowserWindow | null {
    return docsWindow;
}

/**
 * Open (or focus) the Docs viewer window. Mirrors showSettingsWindow — a
 * separate BrowserWindow loading the `/docs` renderer page, reused on repeat
 * opens so we never stack duplicate doc windows.
 */
export function showDocsWindow(): void {
    if (!docsWindow || docsWindow.isDestroyed()) {
        docsWindow = createDocsWindow();
        docsWindow.once('ready-to-show', () => docsWindow?.focus());
        return;
    }
    docsWindow.show();
    docsWindow.focus();
}

export function showCaptureWindow(): void {
    if (!captureWindow || captureWindow.isDestroyed()) {
        captureWindow = createCaptureWindow();
    }
    captureWindow.show();
    captureWindow.focus();
}

export function hideCaptureWindow(): void {
    if (captureWindow && !captureWindow.isDestroyed()) {
        captureWindow.hide();
    }
}

function createMainWindow(): BrowserWindow {
    const win = new BrowserWindow({
        width: 480,
        height: 640,
        show: false,
        frame: true,
        title: 'Genie',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });

    if (isDev) {
        win.loadURL('http://localhost:8888/tray');
    } else {
        win.loadFile(path.join(__dirname, 'tray.html'));
    }

    win.on('close', (e) => {
        // Closing the window hides it instead of quitting — Genie is
        // tray-resident.
        if (!(app as any).isQuiting) {
            e.preventDefault();
            win.hide();
        }
    });

    return win;
}

function createSettingsWindow(): BrowserWindow {
    const win = new BrowserWindow({
        width: 860,
        height: 680,
        minWidth: 680,
        minHeight: 520,
        show: false,
        frame: true,
        title: 'Genie Settings',
        backgroundColor: '#0a0a0c',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });

    if (isDev) {
        win.loadURL('http://localhost:8888/settings');
    } else {
        win.loadFile(path.join(__dirname, 'settings.html'));
    }

    // Defer showing until the page has actually painted. Without this, the
    // window pops up as a white/blank rectangle for several frames while
    // the renderer boots, which reads as "broken" rather than "loading".
    win.once('ready-to-show', () => win.show());
    return win;
}

function createDocsWindow(): BrowserWindow {
    const win = new BrowserWindow({
        width: 960,
        height: 720,
        show: false,
        frame: true,
        title: 'Genie Documentation',
        backgroundColor: '#0a0a0c',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });

    if (isDev) {
        win.loadURL('http://localhost:8888/docs');
    } else {
        win.loadFile(path.join(__dirname, 'docs.html'));
    }

    win.once('ready-to-show', () => win.show());
    return win;
}

function createCaptureWindow(): BrowserWindow {
    const win = new BrowserWindow({
        width: 480,
        height: 200,
        show: false,
        frame: false,
        alwaysOnTop: true,
        resizable: false,
        skipTaskbar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });

    if (isDev) {
        win.loadURL('http://localhost:8888/capture');
    } else {
        win.loadFile(path.join(__dirname, 'capture.html'));
    }

    // Hide on blur — capture is a transient flow.
    win.on('blur', () => {
        if (!win.webContents.isDevToolsOpened()) {
            win.hide();
        }
    });

    return win;
}

app.on('second-instance', (_event, argv) => {
    // Windows: protocol URLs come in via argv. Find the genie:// URL.
    const url = argv.find((a) => a.startsWith('genie://'));
    if (url) {
        handleGenieUrl(url);
    } else {
        showMainWindow();
    }
});

// macOS: protocol URLs come in via 'open-url'.
app.on('open-url', (event, url) => {
    event.preventDefault();
    handleGenieUrl(url);
});

/**
 * The terminal-backend fallback chain (service → detached → in-process).
 * Reused by startup and the `genie host start/restart` control commands.
 */
async function runBackendSelection() {
    return selectTerminalBackend({
        // Never attempt the detached host under E2E: the --no-pack test build
        // ships no standalone runtime, and a detached + unref'd host child would
        // outlive the test by design (an orphan process on the dev machine).
        // The E2E specs don't exercise terminals, so in-process keeps boot
        // deterministic + side-effect-free. The production default is ON.
        detachedEnabled: detachedTerminalsEnabled() && !isE2E(),
        activateService: () =>
            activateHostService({
                snapshots: getSnapshotStore(),
                userDataDir: app.getPath('userData'),
            }),
        initDetached: () => initTerminalBackend(),
        isHostBackedProbe: () => isHostBacked(),
    });
}

function readPtyHostPid(): number | null {
    try {
        const j = JSON.parse(
            fs.readFileSync(
                path.join(app.getPath('userData'), 'ptyhost.json'),
                'utf8',
            ),
        );
        return typeof j.pid === 'number' ? j.pid : null;
    } catch {
        return null;
    }
}

/** `genie host stop` — kill the running pty-host (terminates its terminals). */
async function hostStop(): Promise<string> {
    const pid = readPtyHostPid();
    try {
        disconnectHostLeaveRunning();
    } catch {
        /* in-process backend — nothing to disconnect */
    }
    if (pid == null) return 'no host process recorded (in-process backend?)';
    try {
        process.kill(pid);
    } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') return `host pid ${pid} was not running`;
        return `failed to stop host pid ${pid}: ${e instanceof Error ? e.message : String(e)}`;
    }
    return `stopped host (pid ${pid}) — its running terminals were terminated`;
}

/** `genie host start` — (re)initialise the terminal backend. */
async function hostStart(): Promise<string> {
    const sel = await runBackendSelection();
    return `host start → backend: ${sel.kind}${
        sel.serviceReason ? ` (${sel.serviceReason})` : ''
    }`;
}

/** `genie host restart` — stop the host, then re-init the backend. */
async function hostRestart(): Promise<string> {
    const stopped = await hostStop().catch(() => 'stop skipped');
    const sel = await runBackendSelection();
    return `${stopped}\nhost restart → backend: ${sel.kind}`;
}

// Last-resort process-level guards. Without them, a single unhandled exception
// or promise rejection anywhere in main (an IPC handler, a stray async tick)
// tears the whole app down — the "selecting a workspace crashes everything"
// class of failure. Log loudly and keep running: one bad operation must not
// kill Genie. (Renderer-side crashes are caught by ErrorBoundary instead.)
process.on('uncaughtException', (err) => {
    // eslint-disable-next-line no-console
    console.error('[Genie main] uncaughtException — kept alive:', err);
});
process.on('unhandledRejection', (reason) => {
    // eslint-disable-next-line no-console
    console.error('[Genie main] unhandledRejection — kept alive:', reason);
});

app.whenReady().then(async () => {
    // Persistent session under "persist:tynn" so cookies survive restarts.
    // tynn-api.ts uses this session for all outbound calls.
    session.fromPartition('persist:tynn');

    // Surface preload-script errors loudly. Without this, a bug in
    // preload.ts fails silently — window.genie never attaches and the
    // renderer just sits on "Waiting for preload…" with no clue why.
    // The terminal running `npm run dev` now gets the error + stack.
    app.on('web-contents-created', (_e, contents) => {
        contents.on('preload-error', (_event, preloadPath, error) => {
            // eslint-disable-next-line no-console
            console.error(
                `[preload-error] ${preloadPath}\n${error?.stack ?? error?.message ?? String(error)}`,
            );
        });
    });

    initDatabase();
    registerIpcHandlers();
    // Wire the terminal core to its Electron/SQLite adapters (snapshot store +
    // settings provider + host spawner) and subscribe the cwd→db / host-status→
    // broadcast bridges. MUST run before initTerminalBackend (which reads the
    // host spawner + settings) and before registerTerminalIpc (which uses the
    // shared snapshot store). __dirname is the compiled main bundle dir, where
    // the detached pty-host script sits beside background.js.
    wireTerminalAdapter(__dirname);
    // Tier 3: choose the terminal backend BEFORE registering the terminal IPC.
    // initTerminalBackend connects-or-spawns the detached pty-host when the
    // `detached_terminals` setting is ON — now the DEFAULT (explicit 'off' →
    // in-process). It NEVER
    // throws — any failure degrades to the in-process backend with a non-fatal
    // toast. Doing this first means registerTerminalIpc binds its data/exit
    // fan-out to whichever backend won (subscribeBackendEvents also re-binds on
    // any later swap, so a mid-session fallback still routes correctly).
    // BACKEND SELECTION (fallback chain: service → detached-spawn → in-process).
    //
    //   1. detached_terminals OFF (an explicit opt-out now) → in-process only.
    //      Skip the whole host path.
    //   2. ON → FIRST try the per-user OS service (fancy-term-host@0.2.0
    //      /service): install-if-missing/stale → start → connect a HostClient to
    //      the SAME socket. A service-backed host runs on its OWN standalone Node
    //      runtime, so it survives BOTH a quit AND an update (it never pins
    //      Genie's binary). ensureHostService NEVER throws → on {ok:false} (no
    //      runtime shipped, unsupported OS, install/connect failure) we FALL BACK.
    //   3. Fallback → initTerminalBackend(): connect-to-existing-or-spawn the
    //      DETACHED host (Genie's execPath child — pins the binary, survives a
    //      normal quit, must be killed on update). It too NEVER throws → on
    //      failure it degrades to in-process with a non-fatal toast.
    //
    // selectTerminalBackend records which one won via setHostBackendKind, so
    // hostBackendKind() drives the update-teardown branch + willRestartPtyHost.
    const selection = await runBackendSelection();
    const backendInit: { host: boolean; reattachIds: string[] } = {
        host: selection.host,
        reattachIds: selection.reattachIds,
    };
    if (selection.kind === 'service') {
        // eslint-disable-next-line no-console
        console.log(
            `[terminal] per-user OS service active (action=${selection.serviceAction}); ` +
                `${backendInit.reattachIds.length} session(s) to reattach`,
        );
    } else if (selection.serviceReason) {
        // eslint-disable-next-line no-console
        console.log(`[terminal] OS service not used: ${selection.serviceReason}`);
    }
    // Static imports above — earlier dynamic imports could fail silently
    // on some bundlers, leaving the IPC channels unregistered and
    // surfacing as "No handler registered for 'terminal:resize'" in the
    // renderer once a window mounts.
    registerTerminalIpc();
    if (backendInit.host && backendInit.reattachIds.length > 0) {
        // The renderer remounts retained specs on launch via the create() rejoin
        // path; the host client's mirror already holds their scrollback, so the
        // normal master-view restore replays them. Nothing extra to push here —
        // the ids are surfaced for diagnostics/logging only.
        // eslint-disable-next-line no-console
        console.log(
            `[terminal] reattached to detached host: ${backendInit.reattachIds.length} session(s)`,
        );
    }
    // Reap orphaned host PTYs (a spec deleted out from under a detached
    // terminal, or a crashed session) once the host has settled its reattach.
    // Deferred + unref'd so it never blocks startup; safe because it only kills
    // ids with NO spec — retained/reattaching terminals all still have specs.
    setTimeout(() => {
        try {
            reapOrphanTerminals();
        } catch {
            /* best-effort */
        }
    }, 8000).unref?.();
    registerFilesIpc();
    registerGithubIpc();
    // GitHub capability gating: detect which features the App's granted
    // permissions allow + expose the gate to the renderer.
    registerCapabilityIpc();
    registerUpdaterIpc();
    // Issue Watch: per-workspace GitHub issue/PR/Dependabot watching + poller.
    registerIssueWatchIpc();
    // E2E test mode (GENIE_E2E=1): OVERRIDE the GitHub + Issue Watch channels
    // with scriptable mocks so a Playwright test can drive the device-flow /
    // reconnect UI deterministically (no GitHub, no OAuth, no keychain, no DB
    // seed). Runs AFTER the real registrations and removeHandler's each channel
    // first, so it wins. Inert (never called) in a normal run.
    if (isE2E()) {
        registerE2EMocks();
        // eslint-disable-next-line no-console
        console.log('[e2e] GENIE_E2E=1 — GitHub + Issue Watch IPC mocked.');
        // Open the harness window NOW — not at the end of whenReady. The later
        // startup steps (terminal backend selection, MCP/control servers) touch
        // native modules (node-pty) that may be unbuildable in a test sandbox; if
        // one of those awaits hangs or throws, the end-of-whenReady window would
        // never open. The flyout only needs IPC + the renderer, both ready here.
        showE2EWindow();
        // Mobile-server E2E harness (GENIE_E2E_MOBILE=1): bring the REAL mobile
        // server up on 127.0.0.1 at a fixed port/PIN with mock data deps, BEFORE
        // the native-module startup steps below (node-pty / sqlite) that may hang
        // or throw in a test sandbox. The desktop window above is irrelevant for
        // this spec — the served `/m/` page + REST + WS are what it drives.
        if (isE2EMobile()) {
            await startMobileE2EServer().catch((e) =>
                console.error('[e2e] mobile server failed to start', e),
            );
        }
    }
    // Start with the master window OPEN by default. Genie launches to the tray
    // alone (no window) only when EITHER the user set `start_minimized`
    // (Settings → General) OR the OS launched Genie at sign-in (autostart passes
    // `--autostart` / macOS wasOpenedAtLogin) — an auto-start should never ambush
    // the user with a window on every boot. In both cases the window opens on the
    // first tray click / quick-capture hotkey. E2E opened its own harness window
    // above. Shown here — right after IPC + the terminal backend are ready, before
    // the MCP/mobile servers — so it appears promptly and no later async step hides it.
    if (
        !isE2E() &&
        !launchedFromAutostart() &&
        (getAllSettings() as Record<string, string>)['start_minimized'] !== 'on'
    ) {
        showMasterWindow();
    }
    // Boot-time capability check: once GitHub is known-connected, detect any
    // missing required permission and broadcast `github:capabilities` so the
    // renderer can raise the resolve modal + persistent header warning. Deferred
    // + best-effort so it never blocks startup (the token may settle first).
    // Skipped under E2E — the mock owns the capability channels + state.
    if (!isE2E()) setTimeout(() => void runBootCapabilityCheck(), 4000).unref?.();
    // Start background Process service runners flagged autostart. Headless —
    // they run in the pty backend with no panel; the supervisor broadcasts
    // status to the workspace-row indicator + inline manager.
    startAutostartProcesses();
    // ForceTheQuestion modal IPC (the agent-integration MCP raises it).
    registerForceQuestionIpc({
        isDev,
        preloadPath: path.join(__dirname, 'preload.js'),
    });
    // Agent-integration MCP server (loopback). imDone pulses the caller's
    // terminal glow + optional chime/toast; ForceTheQuestion raises the modal.
    // Best-effort: a failed bind just means no MCP endpoints.
    await startMcpServer({
        serverVersion: app.getVersion(),
        userDataDir: app.getPath('userData'),
        // The fixed, user-settable port (Settings → Agent MCP). Parsed from the
        // k/v setting; falls back to the obscure default when unset/garbage.
        configuredPort: () => {
            const raw = (getAllSettings() as Record<string, string>)['mcp_port'];
            const n = raw ? parseInt(raw, 10) : NaN;
            return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_MCP_PORT;
        },
        // Resolve a workspace's terminals (for the workspace-scoped endpoint):
        // the set of its terminal-spec ids + the most-recently-active one, so a
        // tool call with no explicit terminalId still targets the right one.
        workspaceTerminals: (workspaceId) => ({
            ids: listTerminalSpecs()
                .filter((t) => t.workspace_id === workspaceId)
                .map((t) => t.id),
            lastActive: lastActiveTerminalForWorkspace(workspaceId),
        }),
        onImDone: (terminalId) => {
            if (!terminalId) return;
            broadcastTerminalAttention(terminalId, true);
            // Also pulse the workspace ROW so the user gets a sidebar-level cue
            // ("something finished in workspace X"), not just the terminal glow.
            // A System-Workspace terminal resolves to the synthetic system id.
            const wsId = workspaceIdOfTerminal(terminalId);
            if (wsId) broadcastWorkspacePulse(wsId);
            notifyImDone(terminalId);
        },
        checkIssues: (terminalId) => checkIssuesForMcp(terminalId),
        onForceQuestion: (terminalId, questions) => {
            // Resolve the requesting terminal → its workspace name, so the modal
            // title says WHICH project needs the user (a multi-project Genie
            // raises these from any of them). Best-effort: an unattached terminal
            // or lookup failure just falls back to the generic title.
            let workspaceLabel: string | undefined;
            try {
                const wsId = terminalId
                    ? getTerminalSpec(terminalId)?.workspace_id
                    : null;
                if (wsId) {
                    workspaceLabel = listWorkspaces().find((w) => w.id === wsId)
                        ?.project_name;
                }
            } catch {
                /* fall back to the generic title */
            }
            return forceQuestion(questions, workspaceLabel);
        },
        describeWorkspace: (terminalId) => describeWorkspaceForMcp(terminalId),
        manageProcess: (terminalId, req) => manageProcessForMcp(terminalId, req),
        provisionWorkspaces: (terminalId, req) =>
            provisionWorkspacesForMcp(terminalId, req),
        manageTerminals: (terminalId, req) => manageTerminalsForMcp(terminalId, req),
        runAgent: (terminalId, req) => runAgentForMcp(terminalId, req),
        manageWorkspaces: (terminalId, req) =>
            manageWorkspacesForMcp(terminalId, req),
        // Ops-tool gating: only an Ops project's workspace sees `provisionWorkspaces`
        // in tools/list. Resolve the caller's workspace → its Ops status (fail closed).
        isOpsProject: async (terminalId) => {
            const wsId = terminalId
                ? getTerminalSpec(terminalId)?.workspace_id ?? null
                : null;
            const ws = wsId ? getWorkspace(wsId) : null;
            return ws ? isOpsProjectFor(ws.path) : false;
        },
    }).catch((e) => console.error('[mcp] failed to start', e));
    // Backfill the genie MCP entry into the Claude/Cursor config of any
    // workspace already opted in — now with the stable workspace endpoint URL,
    // so older configs that carried the broken ${GENIE_MCP_URL} ref are
    // rewritten to the hard-coded URL on launch. Best-effort.
    for (const ws of listWorkspaces()) {
        if (ws.mcp_enabled) {
            writeWorkspaceAgentMcp(ws.path, true, workspaceEndpointUrl(ws.id));
        }
    }
    // Control server for the bundled `genie` CLI (status / kill / host control).
    // Loopback + token; writes <userData>/genie-control.json for discovery.
    void startControlServer({
        userDataDir: app.getPath('userData'),
        killTerminal: (id) => killTerminalById(id),
        hostStop,
        hostStart,
        hostRestart,
    }).catch((e) => console.error('[control] failed to start', e));
    // Mobile remote-control server (Settings → Mobile, opt-in). Bound ONLY to the
    // Tailscale IP — fail closed if no tailnet. Reuses the SAME terminal/process/
    // workspace/question functions the desktop + MCP use (built as MobileDataDeps
    // here so DB/terminal access stays in main, like startMcpServer's deps).
    // Non-fatal: a failed bind just means no mobile endpoint.
    // Skipped under the mobile E2E harness, which already started the singleton
    // above with mock deps — this production call would overwrite `deps`.
    if (!isE2EMobile()) await startMobileServer({
        serverVersion: app.getVersion(),
        userDataDir: app.getPath('userData'),
        // The compiled app dir holding mobile.html + the static export.
        appDir: __dirname,
        // Opt-in: mobile_enabled defaults 'off'. Only bind when the user turned it on.
        enabled: (getAllSettings() as Record<string, string>)['mobile_enabled'] === 'on',
        configuredPort: () => {
            const raw = (getAllSettings() as Record<string, string>)['mobile_port'];
            const n = raw ? parseInt(raw, 10) : NaN;
            return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_MOBILE_PORT;
        },
        // One-time DESKTOP confirm before minting a session token, so a tailnet
        // peer who learns the PIN still can't pair silently. Reuses the same
        // OS-level ForceTheQuestion modal as the MCP approval gates.
        confirmPair: async ({ ip, ua }) => {
            const result = await forceQuestion([
                {
                    header: 'Pair phone?',
                    question:
                        `A device wants to pair for mobile remote control:\n\n` +
                        `• from: ${ip}\n` +
                        `• ${ua || 'unknown device'}\n\n` +
                        `Once paired it can drive terminals on this machine. ` +
                        `Approve only if this is YOUR device.`,
                    options: [
                        { label: 'Pair', description: 'Allow this device to connect.' },
                        { label: 'Deny', description: 'Reject — nothing is paired.' },
                    ],
                },
            ]);
            if (result.cancelled) return false; // dismissed = deny
            return (result.answers[0]?.selected ?? []).includes('Pair');
        },
        data: {
            listWorkspaces: () =>
                listWorkspaces().map((w) => ({
                    id: w.id,
                    project_name: w.project_name,
                    path: w.path,
                })),
            listTerminalSpecs: () =>
                listTerminalSpecs().map((s) => ({
                    id: s.id,
                    workspace_id: s.workspace_id,
                    label: s.label,
                    type: s.type,
                    cwd: s.cwd,
                    live_cwd: s.live_cwd,
                })),
            listAllProcesses: () => listAllProcesses(),
            liveTerminalIds: () => {
                try {
                    return terminalManager().list().map((t) => t.id);
                } catch {
                    return [];
                }
            },
            startProcess: (id) => startProcess(id),
            stopProcess: (id) => stopProcess(id),
            restartProcess: (id) => restartProcess(id),
            createAgentTerminal: (opts) => createAgentTerminal(opts),
            killTerminalById: (id) => killTerminalById(id),
            writeToTerminal: (id, data) => writeToTerminal(id, data),
            readTerminalOutput: (id, o) => readTerminalOutput(id, o),
            getScrollback: (id) => {
                try {
                    return terminalManager().getScrollback(id) ?? '';
                } catch {
                    return '';
                }
            },
            resize: (id, cols, rows) => {
                try {
                    return terminalManager().resize(id, cols, rows);
                } catch {
                    return false;
                }
            },
            listPendingQuestions: () => listPendingQuestions(),
            answerPendingQuestion: (id, answers) => answerPendingQuestion(id, answers),
            // Self-update ("Upgrade Genie" tool) — backed by the SAME updater
            // module the desktop pill drives, so a phone-triggered install walks
            // the identical quitAndInstall / two-phase teardown path.
            updateStatus: () => mobileUpdateStatus(),
            installUpdate: () => mobileInstallUpdate(),
            checkUpdate: () => mobileCheckUpdate(),
        },
    }).catch((e) => console.error('[mobile] failed to start', e));
    // Docs viewer IPC (docs:list / docs:read). __dirname is the compiled main
    // bundle dir; resolveDocsDir uses it to find the bundled docs/ in both dev
    // and the packaged asar.
    registerDocsIpc(__dirname);
    // Two-phase quit (Tier 1 terminal persistence). On the FIRST before-quit we
    // hold the quit, ask every window to serialize its terminals one last time,
    // wait a bounded window for those final `terminal:snapshot` messages to
    // land, then kill the ptys and let the quit proceed. A re-entry guard means
    // the second (post-flush) quit passes straight through, so quit can never
    // hang on this. The wait is also unconditionally bounded by a timer, so a
    // wedged renderer can't block shutdown either.
    let snapshotFlushDone = false;
    // Manual-quit terminal confirmation (T3). When host-backed, a normal quit
    // leaves the ptys running in the detached host. Before doing that silently
    // we ask the user which terminals to keep vs shut down. This guards the
    // before-quit re-entry: while the dialog is up we've preventDefault'd and
    // are awaiting the renderer's decision; a stray second quit must not stack
    // another dialog.
    let quitConfirmInFlight = false;
    // Teardown picks behaviour by (a) active backend and (b) WHY we're quitting:
    //
    //   • NORMAL quit, host-backed   → disconnectHostLeaveRunning(). The detached
    //     pty-host OWNS the ptys and must OUTLIVE the quit so the next launch
    //     reattaches live sessions. We snapshot first (T1 floor) but DO NOT kill.
    //   • NORMAL quit, in-process    → stopAllTerminals() (kill the ptys we own).
    //   • UPDATE quit, host-backed   → the host PINS Genie's binary (it runs as
    //     execPath), so NSIS can't overwrite it. Snapshot every host terminal
    //     (so restore replays history, not fresh) then GRACEFULLY shut the host
    //     down (killHostForUpdate → shutdownHost(): the host kills its own ptys,
    //     cleans up pidfile/socket, exits) and WAIT (bounded) before
    //     quitAndInstall's installer runs, with a defensive pidfile-kill fallback
    //     if the graceful path doesn't take.
    //   • UPDATE quit, in-process    → stopAllTerminals() (no host to worry about).
    //
    // Returns a promise so the before-quit second phase can AWAIT the bounded
    // host kill before letting the quit proceed.
    const teardownTerminals = async (): Promise<void> => {
        const forUpdate = isQuittingForUpdate();
        const kind = hostBackendKind();
        if (isHostBacked()) {
            // UPDATE-quit teardown branches on the ACTIVE BACKEND KIND, because
            // only ONE kind pins Genie's binary:
            //   • 'service'  — the host runs on its OWN standalone Node runtime
            //     via the OS service, so it NEVER pins Genie's binary. It
            //     SURVIVES the update exactly like a normal quit: just disconnect
            //     and leave it running, so after the swap Genie reconnects and
            //     terminals are still live. NO kill, NO snapshot needed.
            //   • 'detached' — the host is a detached child. It only PINS the
            //     binary when launched as Genie's execPath child; a detached host
            //     on the shipped standalone Node (the default when the runtime is
            //     present) does NOT pin genie.exe and SURVIVES the update like a
            //     service-backed host. So only kill when it actually pins
            //     (detachedHostPinsBinary) — conservative: unknown ⇒ pins ⇒ kill.
            if (shouldKillHostForUpdate(forUpdate, kind) && detachedHostPinsBinary()) {
                // Snapshot windowless host ptys (windowed ones are covered by the
                // renderer snapshot broadcast) BEFORE the host dies, so the cold
                // post-update launch replays their history.
                snapshotHostTerminalsForUpdate(terminalHasWindow);
                // Disconnect the client first (no lingering socket), then shut the
                // host down so the installer can replace the pinned binary.
                disconnectHostLeaveRunning();
                await killHostForUpdate();
            } else {
                // Normal quit (any host kind) OR update quit with a service-backed
                // host → leave the host running so the next launch reattaches.
                disconnectHostLeaveRunning();
            }
        } else {
            stopAllTerminals();
        }
    };
    // The teardown+re-quit tail, shared by every path that proceeds to actually
    // quit (normal, post-confirm, post-timeout, no-window). Runs the backend
    // teardown (host-backed normal → disconnectHostLeaveRunning leaves the kept
    // terminals running; update → kills the host) then re-triggers app.quit(),
    // which the snapshotFlushDone guard now lets pass straight through.
    const finishQuit = (): void => {
        void teardownTerminals().finally(() => {
            snapshotFlushDone = true;
            quitConfirmInFlight = false;
            app.quit();
        });
    };

    // Drive the manual-quit confirmation: broadcast the live host terminals to
    // the chosen window and await the renderer's decision (via the tested
    // confirmQuitTerminals orchestrator — bounded timeout, one-shot listener).
    //   - 'cancelled' → abort the quit; clear the in-flight flag so a later quit
    //                   re-asks. Nothing torn down, Genie stays open.
    //   - 'proceed'   → the deselected terminals were already killed; run the
    //                   teardown tail (leaves the kept ones running) + quit.
    const runQuitConfirmThenQuit = (
        liveTerminals: ReturnType<typeof liveHostTerminals>,
    ): void => {
        const win = pickDialogWindow();
        if (!win) {
            // No-window fallback: nothing to host the dialog (e.g. tray quit with
            // all windows closed). Don't block — fall back to today's behaviour
            // (disconnectHostLeaveRunning leaves all running) and quit.
            finishQuit();
            return;
        }
        void confirmQuitTerminals({
            liveTerminals,
            send: (channel, payload) => win.webContents.send(channel, payload),
            focusWindow: () => {
                win.show();
                win.focus();
            },
        }).then((outcome) => {
            if (outcome === 'cancelled') {
                quitConfirmInFlight = false;
                return;
            }
            finishQuit();
        });
    };

    app.on('before-quit', (event) => {
        if (snapshotFlushDone) return; // re-entry: let the quit proceed
        // While the confirm dialog is up we've already preventDefault'd and are
        // awaiting the renderer; swallow any stray re-quit so we don't stack a
        // second dialog or double-teardown.
        if (quitConfirmInFlight) {
            event.preventDefault();
            return;
        }
        // PHASE 1 — SNAPSHOT. Tier 2 → Tier 1 degrade: snapshot any RETAINED-but-
        // windowless ptys from their scrollback before we tear down, so a
        // suspended dev server replays on the next launch. (Host-backed: this is
        // the resilience floor if the detached host is later killed externally.)
        // This ALWAYS runs first, so even a terminal the user later chooses to
        // shut down still has a replayable snapshot next launch.
        snapshotRetainedWindowless();
        // On the UPDATE path the host kill is async + bounded, so we must always
        // take the preventDefault → await → re-quit two-phase even with no window
        // open (otherwise the synchronous return would quit before the host dies).
        const forUpdate = isQuittingForUpdate();
        if (BrowserWindow.getAllWindows().length === 0 && !forUpdate) {
            // Nothing window-side to snapshot and a normal quit — tear down
            // immediately (the windowless retained snapshot above already ran).
            snapshotFlushDone = true;
            void teardownTerminals();
            return;
        }
        event.preventDefault();
        if (BrowserWindow.getAllWindows().length > 0) requestFinalSnapshots();
        // Give the renderer ~250ms to land its final snapshots, THEN advance the
        // state machine. The whole chain is bounded so quit can't hang.
        setTimeout(() => {
            // PHASE 2 — CONFIRM (manual quit only). After the snapshot flush, on a
            // MANUAL quit that's host-backed with ≥1 live host terminal AND a
            // window open, ask the user which terminals to keep vs shut down. The
            // update path skips this entirely (forUpdate gate) — it snapshots +
            // shuts the whole host down for the binary swap. In-process / no-
            // terminals / no-window all fall through to the teardown tail.
            const liveTerminals = forUpdate ? [] : liveHostTerminals();
            const confirm =
                !forUpdate &&
                shouldConfirmQuit({
                    hostBacked: isHostBacked(),
                    liveTerminals,
                    hasOpenWindow: BrowserWindow.getAllWindows().length > 0,
                });
            if (confirm) {
                quitConfirmInFlight = true;
                runQuitConfirmThenQuit(liveTerminals);
                return;
            }
            // PHASE 3 — TEARDOWN + QUIT (no confirmation needed).
            finishQuit();
        }, 250);
    });
    registerProtocolHandler();

    // Tray icons live at <asar>/resources/*.png in production (the
    // electron-builder files filter ships them) and at resources/*.png
    // in dev. The -update variant carries the amber badge dot shown
    // while an update is pending.
    const resourcesDir = isDev
        ? path.join(process.cwd(), 'resources')
        : path.join(__dirname, '..', 'resources');
    const trayImg = nativeImage.createFromPath(
        path.join(resourcesDir, 'tray-icon.png'),
    );
    const trayUpdateImg = nativeImage.createFromPath(
        path.join(resourcesDir, 'tray-icon-update.png'),
    );
    if (process.platform === 'darwin' && !trayImg.isEmpty()) {
        trayImg.setTemplateImage(true);
    }
    createTray(trayImg, trayUpdateImg.isEmpty() ? undefined : trayUpdateImg);

    installAppMenu();

    registerShortcuts();

    // On macOS, hitting the dock icon should show the main window.
    app.on('activate', () => {
        showMainWindow();
    });
});

/**
 * Open the E2E harness window (GENIE_E2E only). Loads the harness route named by
 * `GENIE_E2E_PAGE` (default `e2e-issuewatch`), which mounts a real flyout open
 * against the scriptable mock (main/e2e/mock.ts). Each spec picks its page:
 *   - `e2e-issuewatch` → IssueWatchFlyout (device-flow reconnect),
 *   - `e2e-ghcaps`     → GithubCapabilitiesFlyout (per-install resolve flow).
 * Plain BrowserWindow, shown immediately so Playwright can attach to its first
 * window.
 */
function showE2EWindow(): void {
    // Allowlist the harness routes so a stray env value can't load an arbitrary
    // page; default to the issue-watch harness for back-compat.
    const requested = process.env.GENIE_E2E_PAGE ?? 'e2e-issuewatch';
    const page = requested === 'e2e-ghcaps' ? 'e2e-ghcaps' : 'e2e-issuewatch';
    const win = new BrowserWindow({
        width: 900,
        height: 760,
        show: true,
        title: 'Genie E2E',
        backgroundColor: '#0a0a0c',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });
    if (isDev) {
        win.loadURL(`http://localhost:8888/${page}`);
    } else {
        win.loadFile(path.join(__dirname, `${page}.html`));
    }
}

app.on('window-all-closed', () => {
    // Genie stays alive in the tray. Do nothing.
});

app.on('before-quit', () => {
    (app as any).isQuiting = true;
    unregisterShortcuts();
});

// Bridge for getting the active project context (used by capture window).
ipcMain.handle('app:get-current-project', async () => {
    // Capture window uses this to pre-select the project. Defaults to the
    // last-opened workspace, then to primary's project, then null.
    const { getLastOpenedProject } = require('./workspace/last-opened');
    return getLastOpenedProject();
});

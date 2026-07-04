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
    createTerminalSpec,
    workspaceProcessApproval,
    workspaceTerminalApproval,
    getWorkspaceIssuewatchPolicyBuckets,
    removeWorkspace,
} from '../db';
import {
    broadcastTerminalSpecsChanged,
    killTerminalById,
    createAgentTerminal,
    writeToTerminal,
    readTerminalOutput,
} from '../terminal/ipc';
import { buildSubmitBytes, resolveTerminalInput, stripAnsi } from '../terminal/keystrokes';
import {
    startProcess,
    stopProcess,
    restartProcess,
    getProcessStatuses,
} from '../terminal/process-supervisor';
import { detectFolder } from '../workspace/detect';
import { workspaceDocHealth } from '../workspace/create-agi';
import { openWorkspace } from '../workspace/open';
import { resolveWorkspaceRepos, getWorkspaceFeed, getOpenCounts } from '../issue-watch';
import { getToken } from '../github/storage';
import { forceQuestion } from '../ask/force-question';
import { resolveTargetWorkspace, type TargetDecision } from './target-workspace';
import { readTynnLink } from '../tynn/provision';
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
export async function checkIssuesForMcp(terminalId: string): Promise<IssueWatchSnapshot> {
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
export async function manageProcessForMcp(
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

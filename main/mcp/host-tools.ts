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
    updateTerminalSpec,
    workspaceProcessApproval,
    workspaceTerminalApproval,
    getWorkspaceIssuewatchPolicyBuckets,
    removeWorkspace,
    type TerminalSpecMeta,
    type TerminalSpecRow,
} from '../db';
import { whisperBroker } from '../whisper/broker';
import { getKnowledgeStore } from '../knowledge/store';
import { workspaceSlug } from '../whisper/slug';
import { appendLaunchFlags } from '../whisper/session-capture';
import {
    normalizePurpose,
    type WhisperAgentType,
    type WhisperScope,
} from '../whisper/types';
import {
    broadcastTerminalSpecsChanged,
    killTerminalById,
    createAgentTerminal,
    writeToTerminal,
    readTerminalOutput,
} from '../terminal/ipc';
import {
    buildSubmitBytes,
    PASTE_SUBMIT_DELAY_MS,
    resolveTerminalInput,
    stripAnsi,
} from '../terminal/keystrokes';
import {
    startProcess,
    stopProcess,
    restartProcess,
    getProcessStatuses,
} from '../terminal/process-supervisor';
import { renderAgentResume } from '../whisper/session-capture';
import { detectFolder } from '../workspace/detect';
import { workspaceDocHealth } from '../workspace/create-agi';
import { openWorkspace } from '../workspace/open';
import { resolveWorkspaceRepos, getWorkspaceFeed, getOpenCounts } from '../issue-watch';
import { getToken } from '../github/storage';
import { forceQuestion } from '../ask/force-question';
import { resolveTargetWorkspace, type TargetDecision } from './target-workspace';
import { readTynnLink } from '../tynn/provision';
import { workspaceEndpointUrl } from './server';
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
    WhisperRequest,
    WhisperResult,
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
    return withCodexMcpLaunch(withFlags, {
        agent,
        mcpSyncCodexOff: s.mcp_sync_codex === 'off',
        genieUrl: workspaceEndpointUrl(workspace.id),
        tynnUrl: readTynnMcpUrl(workspace.path),
    });
}

/**
 * Create a SPECIALIZED (AI-TUI) terminal from the UI — the shared path behind
 * BOTH the local `terminal-spec:create-agent` IPC and the remote host endpoint
 * (`POST /api/desktop/terminal-spec/create-agent`). Resolves the agent's launch
 * command, spawns the headless agent terminal (stamping its captured chat-session
 * id + WhisperChat identity/accessibility, joining the broker), and submits the
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
    scope: WhisperScope;
    scope_workspaces?: string[];
    wake_on_dm?: boolean;
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
    const { id, command: launchCommand } = createAgentTerminal({
        workspaceId: ws.id,
        cwd,
        label,
        agentMeta: { agent: input.agent, command },
        whisper: {
            purpose: input.purpose,
            scope: input.scope,
            scopeWorkspaces: input.scope_workspaces,
            wakeOnDm: input.wake_on_dm,
        },
    });
    // Launch the agent CLI in the fresh shell (the session-captured form).
    writeToTerminal(id, buildSubmitBytes(launchCommand ?? command, true));
    return { ok: true, spec: getTerminalSpec(id) ?? undefined };
}

/**
 * Apply an agent-settings edit — WhisperChat purpose / scope / wake-on-DM — to a
 * specialized terminal: LIVE-update the broker (so a running agent's accessibility
 * + wake opt-in change immediately) AND persist the durable bits to the spec meta,
 * then broadcast the spec change so every window's sidebar refreshes. Shared by the
 * local IPC handler (`whisper:update-channel`) AND the remote host route
 * (`POST /api/desktop/whisper/update-channel`) so a REMOTE window edits the HOST
 * agent through the exact same path — they can't drift.
 */
export function updateWhisperChannel(
    specId: string,
    patch: {
        purpose?: string;
        scope?: WhisperScope;
        scope_workspaces?: string[];
        wake_on_dm?: boolean;
    },
): { ok: boolean; error?: string } {
    const spec = getTerminalSpec(specId);
    if (!spec) return { ok: false, error: 'Terminal not found.' };
    const agentId = spec.meta?.agent_id;
    if (!agentId) return { ok: false, error: 'That terminal is not a whisper agent.' };
    whisperBroker.setAccessibility(agentId, {
        scope: patch.scope,
        workspaces: patch.scope_workspaces,
        purpose: patch.purpose,
        wakeOnDm: patch.wake_on_dm,
    });
    // Persist the durable bits to the spec meta + refresh the sidebar row.
    const meta = { ...spec.meta };
    if (patch.purpose !== undefined) meta.whisper_purpose = normalizePurpose(patch.purpose);
    if (patch.scope !== undefined) meta.whisper_scope = patch.scope;
    if (patch.scope_workspaces !== undefined) meta.whisper_workspaces = patch.scope_workspaces;
    if (patch.wake_on_dm !== undefined) meta.whisper_wake_on_dm = patch.wake_on_dm;
    updateTerminalSpec(specId, { meta });
    broadcastTerminalSpecsChanged();
    return { ok: true };
}

export type RestartAgentResult =
    | { ok: true; oldId: string; newId: string; agent: WhisperAgentType; command: string }
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
    const resume = renderAgentResume(agent, spec.meta?.agent_command ?? '', spec.meta?.chat_session_id ?? null);
    if (!resume) {
        return {
            ok: false,
            error:
                `Cannot gracefully restart "${agent}": no captured session to resume, so a restart would ` +
                'lose the conversation. Only a claude agent with a captured session can be resumed.',
        };
    }

    // Tear the old agent down FIRST (releases its pty + MCP endpoint + whisper
    // presence) so two processes never share the session id, THEN relaunch the
    // resumed agent in a fresh terminal that picks up the current rig.
    killTerminalById(id);
    const restarted = createAgentTerminal({
        workspaceId: spec.workspace_id!,
        cwd: spec.cwd,
        label: spec.label,
        agentMeta: { agent, command: resume },
        whisper: {
            purpose: spec.meta?.whisper_purpose,
            scope: spec.meta?.whisper_scope,
            scopeWorkspaces: spec.meta?.whisper_workspaces,
        },
    });
    // renderAgentLaunch leaves a resume command untouched (it already carries the
    // session), so restarted.command === resume — submit it to launch.
    writeToTerminal(restarted.id, buildSubmitBytes(restarted.command ?? resume, true));
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
                const { id, command: launchCommand } = createAgentTerminal({
                    workspaceId: ws.id,
                    cwd: cwdR.cwd,
                    label: `${agent} agent`,
                    agentMeta: { agent, command },
                });
                // Launch the agent CLI in the fresh shell. A single-line command
                // submits on the trailing CR, same as a shell Enter. `launchCommand`
                // is the session-captured form (e.g. `claude --session-id <uuid>`);
                // fall back to the base command if none was rendered.
                writeToTerminal(id, buildSubmitBytes(launchCommand ?? command, true));
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
 * Back the WhisperChat MCP `whisper` tool. Resolves (or lazily creates) the
 * caller's whisper identity from its terminal, then dispatches the action against
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
 *
 * A NON-agent caller (a plain terminal that runs an agent and calls whisper) is
 * lazily joined with defaults (`self` scope, `general` purpose) so any Genie
 * terminal can participate.
 */
export async function whisperForMcp(
    callerTerminalId: string,
    req: WhisperRequest,
): Promise<WhisperResult> {
    const spec = callerTerminalId ? getTerminalSpec(callerTerminalId) : null;
    if (!spec || !spec.workspace_id) {
        return { ok: false, error: 'This terminal is not in a workspace, so it can’t use whisper.' };
    }
    const ws = getWorkspace(spec.workspace_id);
    if (!ws) return { ok: false, error: 'Workspace not found.' };

    // Resolve — or lazily create — the caller's whisper identity.
    let agentId = spec.meta?.agent_id;
    if (!agentId) {
        agentId = crypto.randomUUID();
        const meta: TerminalSpecMeta = {
            ...spec.meta,
            agent: (spec.meta?.agent as WhisperAgentType) ?? 'custom',
            agent_id: agentId,
            whisper_purpose: normalizePurpose(spec.meta?.whisper_purpose),
            whisper_scope: (spec.meta?.whisper_scope as WhisperScope) ?? 'self',
        };
        updateTerminalSpec(spec.id, { meta });
        whisperBroker.join({
            agentId,
            terminalId: spec.id,
            workspaceId: ws.id,
            workspaceName: ws.project_name,
            slug: workspaceSlug(ws),
            agentType: meta.agent as WhisperAgentType,
            label: spec.label,
            purpose: meta.whisper_purpose!,
            scope: meta.whisper_scope as WhisperScope,
            scopeWorkspaces: Array.isArray(meta.whisper_workspaces)
                ? (meta.whisper_workspaces as string[])
                : [],
            chatSessionId: (meta.chat_session_id as string | undefined) ?? null,
        });
    } else {
        whisperBroker.markOnline(agentId);
    }

    try {
        switch (req.action) {
            case 'list':
                return {
                    ok: true,
                    self: whisperBroker.getInfo(agentId) ?? undefined,
                    agents: whisperBroker.discoverableFor(agentId),
                    channels: whisperBroker.channelsForAgent(agentId),
                };
            case 'send': {
                if (!req.text || !req.text.trim()) {
                    return { ok: false, error: 'send needs a non-empty `text`.' };
                }
                if (!req.to && !req.channel) {
                    return { ok: false, error: 'send needs `to` (an agent) or `channel`.' };
                }
                const r = whisperBroker.send({
                    fromAgentId: agentId,
                    toAgentId: req.to,
                    channelArg: req.channel,
                    text: req.text,
                    interrupt: req.interrupt,
                });
                return r.ok ? { ok: true, delivered: r.delivered } : { ok: false, error: r.error };
            }
            case 'receive': {
                const { messages, cursor } = await whisperBroker.receive(agentId, {
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
                return { ok: true, receipts: whisperBroker.receipts(agentId, req.limit) };
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
                const info = whisperBroker.setAccessibility(agentId, {
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
                const ok = whisperBroker.joinChannel(agentId, req.channel);
                if (!ok) return { ok: false, error: `Couldn't resolve channel "${req.channel}".` };
                return { ok: true, channels: whisperBroker.channelsForAgent(agentId) };
            }
            case 'leave': {
                if (!req.channel) return { ok: false, error: 'leave needs a `channel`.' };
                whisperBroker.leaveChannel(agentId, req.channel);
                return { ok: true, channels: whisperBroker.channelsForAgent(agentId) };
            }
        }
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    return { ok: false, error: 'Unhandled whisper action.' };
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

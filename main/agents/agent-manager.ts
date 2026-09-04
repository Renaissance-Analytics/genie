import fs from 'node:fs';
import path from 'node:path';
import {
    getDb,
    getWorkspace,
    listAgentRuntimes,
    listWorkspaceAgents,
    type WorkspaceAgentRow,
} from '../db';
import {
    applyServer,
    claudeEntry,
    cursorEntry,
    GENIE_SERVER_NAME,
} from '../mcp/agent-config';
import { restartAgentTerminal, startRegisteredAgent } from '../mcp/host-tools';
import { isTerminalLive, killTerminalById } from '../terminal/ipc';
import { broadcastAgentsChanged } from '../ipc';
import { getWorkspaceAgentById } from './lookup';
import {
    agentMcpServers,
    MCP_CONFIG_RELATIVE_PATH,
    mcpConfigDrift,
    mcpRemovalGuard,
    mcpSourceForTui,
    type AgentMcpServer,
    type McpConfigSource,
} from './agent-mcp';
import {
    applyPersonaEdit,
    blankPersona,
    personaView,
    type PersonaEdit,
    type PersonaView,
} from './persona';
import { isSidecarName } from './sidecar';
import { sidecarActions, sidecarsOf, type SidecarAction } from './sidecar-control';

/**
 * The agent management surface's HOST side — Tynn #709, story #263.
 *
 * The owner asked for "a full agent manager with agent prompt and rules and MCP
 * management" and opened *Agent settings* to a driver picker, a purpose field
 * and two checkboxes. Everything the real surface needs already existed and had
 * no way to be reached: `agent-file.ts` reads and writes `AGENT.md`, and
 * `mcp/agent-config.ts` composes the MCP entries. So this is deliberately a
 * THIN layer — it reads files, applies the pure decisions made next door, and
 * writes back. Nothing here re-implements parsing or config generation.
 *
 * What it does own is the honesty. Every write reports its failure rather than
 * swallowing it: `mcp/agent-config.ts`'s own writers are best-effort by design
 * (a locked file must not break provisioning), which is right for a background
 * sync and wrong for a human who just pressed Save and needs to know whether it
 * landed.
 */

export interface AgentManagerPersona extends PersonaView {
    /** Absolute path to `AGENT.md`, or null for an agent with no `persona_path`. */
    path: string | null;
    /** False when the path is known but nothing is on disk yet — agents
     *  registered before registration started writing the file. */
    exists: boolean;
}

export interface AgentManagerMcp {
    source: McpConfigSource;
    /** Workspace-relative, so the human can find the file it came from. */
    configPath: string;
    servers: AgentMcpServer[];
    /**
     * Whether the running session can be PROVED to predate this config. The
     * three TUIs read their servers once, at session start; nothing said so, and
     * that silence is what cost an afternoon.
     */
    drift: 'not-running' | 'stale' | 'unproven';
    /** False for Codex: its servers live in a TOML file Genie only partly owns,
     *  so this surface reads it and does not rewrite it. */
    editable: boolean;
}

export interface AgentManagerSidecar {
    /** The sidecar's record id, when it has one. */
    id: string | null;
    name: string | null;
    exists: boolean;
    running: boolean;
    /** The terminal a graceful restart acts on, or null when it is not running. */
    terminalSpecId: string | null;
    actions: SidecarAction[];
    /** How this sidecar was matched — the FK, or the name convention it falls
     *  back to. Surfaced because the two mean different things for #708. */
    matchedBy: 'parent' | 'name' | null;
}

export interface AgentManagerState {
    ok: boolean;
    error?: string;
    agent: {
        id: string;
        workspaceId: string;
        name: string;
        purpose: string;
        avatar: string | null;
        role: string;
        tui: string | null;
        running: boolean;
        isSidecar: boolean;
        /**
         * The live terminal a graceful restart acts on, or null when the agent
         * is dormant.
         *
         * Surfaced because the MCP tab's Restart must go through
         * `restartAgentTerminal` (wish #88) — which relaunches with the
         * provider's RESUME grammar so the conversation survives — and NOT
         * through `agents.start`, which reattaches a bound terminal and would
         * reload nothing while reporting success.
         */
        terminalSpecId: string | null;
    } | null;
    persona: AgentManagerPersona | null;
    mcp: AgentManagerMcp | null;
    sidecar: AgentManagerSidecar | null;
}

const FAILED: AgentManagerState = {
    ok: false,
    error: 'That agent is no longer registered.',
    agent: null,
    persona: null,
    mcp: null,
    sidecar: null,
};

/** Every terminal an agent could be running under — its own binding and every
 *  runtime's. Same de-duplication `terminalsToStopFor` does, without the
 *  sidecar sweep, because here the sidecar is controlled separately. */
function ownTerminals(agent: WorkspaceAgentRow): string[] {
    const ids = new Set<string>();
    if (agent.terminal_spec_id) ids.add(agent.terminal_spec_id);
    for (const runtime of listAgentRuntimes(agent.id)) {
        if (runtime.terminal_spec_id) ids.add(runtime.terminal_spec_id);
    }
    return [...ids];
}

function isRunning(agent: WorkspaceAgentRow): boolean {
    return ownTerminals(agent).some((id) => isTerminalLive(id));
}

/** The LIVE terminal a graceful restart acts on, or null when none is up. */
function liveTerminalOf(agent: WorkspaceAgentRow): string | null {
    return ownTerminals(agent).find((id) => isTerminalLive(id)) ?? null;
}

function readJsonFile(file: string): unknown {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    } catch {
        // Missing, or a human mid-edit. Both read as "no servers from here", and
        // the surface still renders so they can fix it.
        return null;
    }
}

function readTextFile(file: string): string {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return '';
    }
}

function mtimeMs(file: string): number | null {
    try {
        return fs.statSync(file).mtimeMs;
    } catch {
        return null;
    }
}

/** The TUI an agent is actually driven by: the fronted runtime, else the record. */
function effectiveTui(agent: WorkspaceAgentRow): string | null {
    return listAgentRuntimes(agent.id).find((r) => r.fronted)?.tui ?? agent.tui ?? null;
}

/** Everything the agent manager draws, for one agent. */
export function agentManagerState(agentId: string): AgentManagerState {
    const agent = getWorkspaceAgentById(String(agentId ?? ''));
    if (!agent) return FAILED;
    const ws = getWorkspace(agent.workspace_id);
    if (!ws) {
        return { ...FAILED, error: 'That agent’s workspace is no longer registered.' };
    }

    const tui = effectiveTui(agent);
    const running = isRunning(agent);

    // --- AGENT.md ---------------------------------------------------------
    const personaPath = agent.persona_path;
    const personaExists = !!personaPath && fs.existsSync(personaPath);
    const raw = personaExists
        ? readTextFile(personaPath!)
        : blankPersona(agent.name, agent.purpose, tui ? [tui] : []);
    const persona: AgentManagerPersona = {
        ...personaView(raw),
        path: personaPath,
        exists: personaExists,
    };

    // --- MCP --------------------------------------------------------------
    const source = mcpSourceForTui(tui);
    const relative = MCP_CONFIG_RELATIVE_PATH[source];
    const configFile = path.join(ws.path, ...relative.split('/'));
    const mcp: AgentManagerMcp = {
        source,
        configPath: relative,
        servers: agentMcpServers({
            tui,
            claude: source === 'claude' ? readJsonFile(configFile) : null,
            cursor: source === 'cursor' ? readJsonFile(configFile) : null,
            codexToml: source === 'codex' ? readTextFile(configFile) : '',
        }),
        drift: mcpConfigDrift({
            running,
            readyAt: agent.ready_at,
            configMtimeMs: mtimeMs(configFile),
        }),
        // Codex keeps its servers in a TOML file Genie writes only a fenced
        // block of. Rewriting a human's tables with a regex is not an edit, it
        // is a gamble, so this surface reads it and says where to change it.
        editable: source !== 'codex',
    };

    // --- Sidecar ----------------------------------------------------------
    const roster = listWorkspaceAgents(agent.workspace_id);
    const found = sidecarsOf(agent, roster)[0] ?? null;
    const sidecar: AgentManagerSidecar = {
        id: found?.id ?? null,
        name: found?.name ?? null,
        exists: !!found,
        running: found ? isRunning(found) : false,
        terminalSpecId: found ? liveTerminalOf(found) : null,
        actions: [],
        matchedBy: found ? (found.parent_agent_id === agent.id ? 'parent' : 'name') : null,
    };
    sidecar.actions = sidecarActions({ exists: sidecar.exists, running: sidecar.running });

    return {
        ok: true,
        agent: {
            id: agent.id,
            workspaceId: agent.workspace_id,
            name: agent.name,
            purpose: agent.purpose,
            avatar: agent.avatar,
            role: agent.role,
            tui,
            running,
            // A sidecar has no sidecar of its own, so the manager drops that tab
            // rather than offering controls that would act on nothing.
            isSidecar: isSidecarName(agent.name),
            terminalSpecId: liveTerminalOf(agent),
        },
        persona,
        mcp,
        sidecar,
    };
}

export interface WriteResult {
    ok: boolean;
    error?: string;
}

/**
 * Save an edit to the agent's `AGENT.md`.
 *
 * Creates the file when the agent predates registration writing one — an agent
 * whose `persona_path` points at nothing is a normal state, and telling the
 * human their agent has no file and leaving them there is not a surface.
 *
 * `purpose` is mirrored into the record afterwards. The FILE is the source of
 * truth and the row is its cache (see `agent-file.ts`); leaving the cache stale
 * would show one purpose in the roster and another in the editor.
 */
export function saveAgentPersona(agentId: string, edit: PersonaEdit): WriteResult {
    const agent = getWorkspaceAgentById(String(agentId ?? ''));
    if (!agent) return { ok: false, error: 'That agent is no longer registered.' };
    if (!agent.persona_path) {
        return {
            ok: false,
            error: `${agent.name} has no AGENT.md path recorded, so there is nowhere to save this. Re-register the agent to give it one.`,
        };
    }

    const exists = fs.existsSync(agent.persona_path);
    const before = exists
        ? readTextFile(agent.persona_path)
        : blankPersona(agent.name, agent.purpose, effectiveTui(agent) ? [effectiveTui(agent)!] : []);
    const after = applyPersonaEdit(before, edit);

    // Report the failure. `mcp/agent-config.ts` writes best-effort on purpose —
    // a locked file must not break provisioning — but a human who pressed Save
    // has to be told it did not land, per CONTRIBUTING's "never report a success
    // you have not verified".
    try {
        fs.mkdirSync(path.dirname(agent.persona_path), { recursive: true });
        fs.writeFileSync(agent.persona_path, after);
    } catch (e) {
        return {
            ok: false,
            error: `Could not write ${agent.persona_path}: ${e instanceof Error ? e.message : String(e)}`,
        };
    }

    const purpose = personaView(after).purpose;
    if (purpose && purpose !== agent.purpose) {
        try {
            getDb()
                .prepare('UPDATE workspace_agents SET purpose = ?, updated_at = ? WHERE id = ?')
                .run(purpose, Date.now(), agent.id);
            broadcastAgentsChanged();
        } catch (e) {
            // The FILE is the source of truth and it is written, so the edit is
            // not lost — but the roster will show the old purpose until the
            // cache catches up, and that is worth saying rather than hiding.
            return {
                ok: false,
                error: `Saved ${agent.persona_path}, but could not update the agent record: ${e instanceof Error ? e.message : String(e)}`,
            };
        }
    }
    return { ok: true };
}

/** What a human may add: a remote endpoint, or a command Genie spawns. */
export type McpServerInput =
    | { kind: 'http'; name: string; url: string }
    | { kind: 'stdio'; name: string; command: string; args: string[] };

function writeJsonConfig(file: string, next: unknown): WriteResult {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
        return { ok: true };
    } catch (e) {
        return {
            ok: false,
            error: `Could not write ${file}: ${e instanceof Error ? e.message : String(e)}`,
        };
    }
}

/** The config file this agent's TUI reads, absolute. */
function mcpConfigFileFor(agent: WorkspaceAgentRow, workspacePath: string): {
    source: McpConfigSource;
    file: string;
} {
    const source = mcpSourceForTui(effectiveTui(agent));
    return {
        source,
        file: path.join(workspacePath, ...MCP_CONFIG_RELATIVE_PATH[source].split('/')),
    };
}

/**
 * Remove one MCP server from the config this agent reads.
 *
 * `genie` and its AgentInbox channel are REFUSED, with the reason — see
 * `mcpRemovalGuard`. That is the one hard no in this surface, and it is a no
 * rather than a warning because the failure it prevents is invisible: an agent
 * without `genie` starts, draws a square, looks healthy, and cannot reach the
 * person who started it.
 */
export function removeAgentMcpServer(agentId: string, name: string): WriteResult {
    const agent = getWorkspaceAgentById(String(agentId ?? ''));
    if (!agent) return { ok: false, error: 'That agent is no longer registered.' };
    const ws = getWorkspace(agent.workspace_id);
    if (!ws) return { ok: false, error: 'That agent’s workspace is no longer registered.' };

    const guard = mcpRemovalGuard(name);
    if (!guard.allowed) return { ok: false, error: guard.reason };

    const { source, file } = mcpConfigFileFor(agent, ws.path);
    if (source === 'codex') {
        return {
            ok: false,
            error: `Codex reads its servers from ${MCP_CONFIG_RELATIVE_PATH.codex}, a TOML file Genie only writes a fenced block of. Edit that file to remove "${name}" — Genie will not rewrite tables it did not author.`,
        };
    }

    const existing = readJsonFile(file);
    if (existing === null && !fs.existsSync(file)) {
        return { ok: false, error: `There is no ${MCP_CONFIG_RELATIVE_PATH[source]} to edit.` };
    }
    const next = applyServer(
        existing as Record<string, unknown> | null,
        name,
        {},
        false,
    );
    if (next === null) return { ok: true }; // nothing there to remove
    return writeJsonConfig(file, next);
}

/** Add (or replace) one MCP server in the config this agent reads. */
export function addAgentMcpServer(agentId: string, input: McpServerInput): WriteResult {
    const agent = getWorkspaceAgentById(String(agentId ?? ''));
    if (!agent) return { ok: false, error: 'That agent is no longer registered.' };
    const ws = getWorkspace(agent.workspace_id);
    if (!ws) return { ok: false, error: 'That agent’s workspace is no longer registered.' };

    const name = input.name.trim();
    if (!name) return { ok: false, error: 'Give the server a name.' };
    if (name === GENIE_SERVER_NAME) {
        return {
            ok: false,
            error: 'Genie writes its own server entry. Toggle Agent MCP on the workspace instead of adding it by hand — a hand-written one is overwritten on the next sync.',
        };
    }

    const { source, file } = mcpConfigFileFor(agent, ws.path);
    if (source === 'codex') {
        return {
            ok: false,
            error: `Codex reads its servers from ${MCP_CONFIG_RELATIVE_PATH.codex}. Add "${name}" there — Genie will not rewrite tables it did not author.`,
        };
    }

    let entry: Record<string, unknown>;
    if (input.kind === 'http') {
        const url = input.url.trim();
        if (!url) return { ok: false, error: 'Give the server a URL.' };
        entry = source === 'cursor' ? cursorEntry(url) : claudeEntry(url);
    } else {
        const command = input.command.trim();
        if (!command) return { ok: false, error: 'Give the server a command to run.' };
        entry = { command, args: input.args.filter((a) => a.trim().length > 0) };
    }

    const next = applyServer(readJsonFile(file) as Record<string, unknown> | null, name, entry, true);
    if (next === null) return { ok: false, error: 'Nothing to write.' };
    return writeJsonConfig(file, next);
}

/**
 * Start, stop or restart this agent's sidecar.
 *
 * **Stop** kills the sidecar's terminals and leaves its RECORD alone — it keeps
 * its identity, its inbox and its `AGENT.md`, and starting it again is the same
 * agent rather than a new one. That is the difference between this and Delete,
 * and conflating the two is how someone loses a conversation they meant to
 * pause.
 *
 * **Restart** goes through `restartAgentTerminal` (wish #88), which relaunches
 * with the provider's RESUME grammar so the conversation SURVIVES. Not
 * kill-then-start: a sidecar exists precisely to keep a second conversation
 * warm, so a "restart" that dropped it would destroy the only thing it is for.
 * When that path refuses — no captured session, or a provider with no resume
 * grammar — the refusal is returned rather than quietly downgraded to a hard
 * restart, because a hard restart is exactly what the refusal is protecting
 * against.
 */
export async function agentSidecarAction(
    agentId: string,
    action: SidecarAction,
): Promise<WriteResult> {
    const agent = getWorkspaceAgentById(String(agentId ?? ''));
    if (!agent) return { ok: false, error: 'That agent is no longer registered.' };
    const ws = getWorkspace(agent.workspace_id);
    if (!ws) return { ok: false, error: 'That agent’s workspace is no longer registered.' };

    const sidecar = sidecarsOf(agent, listWorkspaceAgents(agent.workspace_id))[0];
    if (!sidecar) {
        return { ok: false, error: `${agent.name} has no sidecar to ${action}.` };
    }

    if (action === 'stop') {
        if (!isRunning(sidecar)) {
            return { ok: false, error: `${sidecar.name} is not running.` };
        }
        for (const id of ownTerminals(sidecar)) killTerminalById(id);
        broadcastAgentsChanged();
        return { ok: true };
    }

    if (action === 'restart') {
        const live = liveTerminalOf(sidecar);
        if (!live) return { ok: false, error: `${sidecar.name} is not running.` };
        const result = restartAgentTerminal(live);
        broadcastAgentsChanged();
        return result.ok ? { ok: true } : { ok: false, error: result.error };
    }

    if (isRunning(sidecar)) {
        return { ok: false, error: `${sidecar.name} is already running.` };
    }

    // The SAME path `runAgent start` and the agent square use, so the terminal
    // cap and reattach still apply — a button must not become a way past a limit
    // the owner set. Only the approval modal is skipped: the click IS the
    // approval.
    const started = await startRegisteredAgent(
        ws,
        { action: 'start', name: sidecar.name } as never,
        { humanInitiated: true },
    );
    broadcastAgentsChanged();
    if (started && typeof started === 'object' && 'ok' in started && started.ok === false) {
        return {
            ok: false,
            error:
                'error' in started && typeof started.error === 'string'
                    ? started.error
                    : `Could not start ${sidecar.name}.`,
        };
    }
    return { ok: true };
}

/**
 * The agent manager's WIRE TYPES — Tynn #709, story #263.
 *
 * ZERO IMPORTS, and that is the entire point of this file.
 *
 * `renderer/tsconfig.json` includes `./**\/*`, so any module a renderer file
 * imports — *including through a type-only import* — is dragged into the
 * renderer's compilation. TypeScript type-checks every file in the program;
 * `import type` decides what is EMITTED, not what is COMPILED.
 *
 * The manager's types first lived beside their implementations, so
 * `renderer/lib/genie.ts` naming `AgentManagerState` pulled in
 * `main/agents/agent-manager.ts` → `main/terminal/ipc.ts` →
 * `main/terminal/genie-adapter.ts`: a module that spawns child processes, now
 * inside the renderer's program. Its long-standing `spawn` typings then failed
 * the renderer typecheck — but that compile error was the SYMPTOM. The defect
 * was a hole in the main/renderer boundary.
 *
 * The boundary was already there, unwritten. Every `main/` module the renderer
 * reaches — `agents/registry`, `mcp/tynn-health`, `terminal/replay`,
 * `terminal/agent-cap`, `terminal/keystrokes`, `dev-server/serve-recipe`,
 * `ask/inbox` — is a LEAF: zero imports, or one type-only import of another
 * leaf. Not one touches `node:fs`, `electron`, `../db`, or a child process.
 * This file joins that set and is the ONLY one of the manager's modules the
 * renderer may name. `renderer/lib/__tests__/renderer-main-boundary.test.ts`
 * enforces it now, so the next person gets a failing test naming the offending
 * import instead of a mysterious error in a file they never opened.
 *
 * Main's own modules import these types back FROM here, so there is one
 * definition and the two sides cannot drift. Values — anything that reads a
 * file, spawns, or touches the database — stay on their side of the boundary
 * and cross by IPC, which is the boundary that already exists.
 */

/* ── MCP ──────────────────────────────────────────────────────────────────── */

/** Which config file an agent's TUI reads its MCP servers from. */
export type McpConfigSource = 'claude' | 'cursor' | 'codex';

export interface AgentMcpServer {
    name: string;
    /** The config file the agent's TUI reads this from. */
    source: McpConfigSource;
    /** How the agent reaches it — a url, or the command it spawns. For display;
     *  a blank cell for a stdio server would read as a bug. */
    detail: string;
    /** Genie's own lifeline. Removal is refused. */
    required: boolean;
    /** Genie writes this entry itself, so removing it comes back on the next
     *  workspace sync. Saying so beats the human doing it twice. */
    managed: boolean;
}

/** What a human may add: a remote endpoint, or a command Genie spawns. */
export type McpServerInput =
    | { kind: 'http'; name: string; url: string }
    | { kind: 'stdio'; name: string; command: string; args: string[] };

/* ── Mode ──────────────────────────────────────────────────────────────── */

/**
 * Whether an agent is expected to act unattended (genie#408).
 *
 * `manual` is the default and the safe direction — see `agents/agent-mode.ts`,
 * which owns what each one is TOLD. GUIDANCE, never a permission boundary.
 */
export type AgentMode = 'automated' | 'manual';

/* ── AGENT.md ─────────────────────────────────────────────────────────────── */

/**
 * What the manager may change in an `AGENT.md`.
 *
 * `name` is deliberately ABSENT. Identity is (workspace, name) — the roster, the
 * AgentInbox channel, `.agents/<name>/` and `persona_path` all key on it — so a
 * rename is a migration, not a text field, and offering it here would
 * desynchronise every one of them from a control that looks harmless.
 *
 * Every field is optional and `undefined` means "not edited", which is what
 * makes an empty edit a genuine no-op rather than a reset to defaults.
 */
export interface PersonaEdit {
    purpose?: string;
    /** Automated or Manual. Written to the file as a `mode:` line — stated in
     *  both directions, because choosing Manual is a declaration a human made,
     *  not a reversion to a blank. */
    mode?: AgentMode;
    /** null clears it back to the whole workspace. */
    scope?: string | null;
    tuis?: string[];
    avatar?: string | null;
    /** The system prompt, verbatim. */
    body?: string;
}

/** One header key Genie has no field for, shown read-only so a human can SEE it
 *  was not lost rather than having to diff the file to find out. */
export interface PersonaExtraView {
    key: string;
    value: string;
}

/** An `AGENT.md`, as the manager draws it. */
export interface PersonaView {
    name: string;
    purpose: string;
    /** RESOLVED, never null: a file that declares nothing is Manual, and the
     *  surface must show the mode the agent will actually be spoken to in. */
    mode: AgentMode;
    scope: string | null;
    tuis: string[];
    avatar: string | null;
    body: string;
    extra: PersonaExtraView[];
}

/* ── Sidecar ──────────────────────────────────────────────────────────────── */

export type SidecarAction = 'start' | 'stop' | 'restart';

/* ── The manager's state ──────────────────────────────────────────────────── */

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

/** The result of any manager write. A failure carries its reason: a human who
 *  pressed Save has to be told it did not land. */
export interface WriteResult {
    ok: boolean;
    error?: string;
}

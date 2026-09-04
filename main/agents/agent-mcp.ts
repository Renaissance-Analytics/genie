import {
    AGENTINBOX_CLAUDE_CHANNEL_NAME,
    GENIE_SERVER_NAME,
    TYNN_SERVER_NAME,
} from '../mcp/agent-config';

/**
 * Which MCP servers an agent actually gets — and what a human may do about it.
 *
 * Tynn #709. An agent's MCP set has never been visible from the app, and the
 * cost of that is on record: an afternoon went into an agent that looked healthy
 * and was toolless. A change to `.mcp.json` does NOT reach a session that is
 * already running — Claude Code, Cursor and Codex all read their servers at
 * session start — and nothing anywhere said so, so nothing suggested a restart.
 *
 * Two facts shape everything here:
 *
 *  1. **The set is per-TUI, not per-workspace.** One workspace holds three
 *     different answers: `.mcp.json` (Claude), `.cursor/mcp.json` (Cursor) and
 *     `.codex/config.toml` (Codex). Showing "the workspace's MCP servers" would
 *     be wrong for two agents out of three.
 *  2. **`genie` is not optional.** It is how an agent calls `imDone`, asks a
 *     question, and reaches every host tool. An agent without it looks healthy
 *     and is unreachable — the same failure mode this surface exists to end — so
 *     removing it is REFUSED with a reason, not merely warned about.
 *
 * PURE — the caller reads the files. Composing the configs is `main/mcp/
 * agent-config.ts`'s job and is not duplicated here; this only READS what that
 * module wrote, and delegates every write back to its `applyServer`.
 */

export type McpConfigSource = 'claude' | 'cursor' | 'codex';

export interface AgentMcpServer {
    name: string;
    /** The config file the agent's TUI reads this from. */
    source: McpConfigSource;
    /** How the agent reaches it — a url, or the command it spawns. For display;
     *  a blank cell for a stdio server would read as a bug. */
    detail: string;
    /** Genie's own lifeline. Removal is refused — see {@link mcpRemovalGuard}. */
    required: boolean;
    /** Genie writes this entry itself, so removing it comes back on the next
     *  workspace sync. Saying so beats the human doing it twice. */
    managed: boolean;
}

/** The entries Genie writes and re-writes. */
const MANAGED = new Set<string>([
    GENIE_SERVER_NAME,
    TYNN_SERVER_NAME,
    AGENTINBOX_CLAUDE_CHANNEL_NAME,
]);

/** The entries an agent cannot function without. */
const REQUIRED = new Set<string>([GENIE_SERVER_NAME, AGENTINBOX_CLAUDE_CHANNEL_NAME]);

/**
 * Which config an agent's TUI actually reads.
 *
 * A registered-but-never-started agent has `tui: null`, and it will almost
 * certainly start under Claude Code. Showing it nothing would read as "this
 * agent has no MCP servers", which is false and is exactly the invisible-set
 * problem again.
 */
export function mcpSourceForTui(tui: string | null): McpConfigSource {
    if (tui === 'cursor') return 'cursor';
    if (tui === 'codex') return 'codex';
    return 'claude';
}

/** The workspace-relative path of the config a source lives in. */
export const MCP_CONFIG_RELATIVE_PATH: Record<McpConfigSource, string> = {
    claude: '.mcp.json',
    cursor: '.cursor/mcp.json',
    codex: '.codex/config.toml',
};

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** How the agent reaches a server, read off a `mcpServers` entry. */
function detailOf(entry: unknown): string {
    if (!isObject(entry)) return '';
    if (typeof entry.url === 'string') return entry.url;
    if (typeof entry.command === 'string') {
        const args = Array.isArray(entry.args)
            ? entry.args.filter((a): a is string => typeof a === 'string')
            : [];
        return [entry.command, ...args].join(' ');
    }
    return '';
}

/**
 * The `[mcp_servers.<name>]` tables in a Codex `config.toml`, in file order.
 *
 * A regex rather than a TOML parser because that is all Genie itself writes
 * (`applyCodexServerBlock` emits exactly this table form) and pulling a parser
 * in to read back our own output would be the larger change. Anchored to the
 * start of a line so a commented-out or quoted mention cannot become a phantom
 * server in a list a human is about to act on.
 */
export function codexServerNames(toml: string): string[] {
    const names: string[] = [];
    const pattern = /^[ \t]*\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\][ \t]*$/gm;
    for (const match of toml.matchAll(pattern)) {
        const name = match[1] ?? match[2];
        if (name && !names.includes(name)) names.push(name);
    }
    return names;
}

/** The `mcpServers` map out of a parsed JSON config, or an empty map. */
export function jsonServerMap(config: unknown): Record<string, unknown> {
    if (!isObject(config)) return {};
    const servers = config.mcpServers;
    return isObject(servers) ? servers : {};
}

/**
 * Every MCP server the agent gets, sorted by name so the list does not reshuffle
 * between reads of the same file.
 */
export function agentMcpServers(input: {
    tui: string | null;
    /** Parsed `.mcp.json`. */
    claude: unknown;
    /** Parsed `.cursor/mcp.json`. */
    cursor: unknown;
    /** Raw `.codex/config.toml`. */
    codexToml: string;
}): AgentMcpServer[] {
    const source = mcpSourceForTui(input.tui);
    const decorate = (name: string, detail: string): AgentMcpServer => ({
        name,
        source,
        detail,
        required: REQUIRED.has(name),
        managed: MANAGED.has(name),
    });

    if (source === 'codex') {
        // Codex tables are already in file order and Genie writes at most a
        // couple; sorting keeps it consistent with the JSON sources.
        return codexServerNames(input.codexToml)
            .sort((a, b) => a.localeCompare(b))
            .map((name) => decorate(name, ''));
    }

    const servers = jsonServerMap(source === 'cursor' ? input.cursor : input.claude);
    return Object.keys(servers)
        .sort((a, b) => a.localeCompare(b))
        .map((name) => decorate(name, detailOf(servers[name])));
}

export type McpRemovalGuard = { allowed: true } | { allowed: false; reason: string };

/**
 * Whether a human may remove this server.
 *
 * `genie` and its AgentInbox channel are refused. This is the one place in the
 * surface that says no, and it says no because the alternative is silent: an
 * agent whose `genie` server is gone still starts, still draws a square, still
 * looks fine — and can no longer report that it finished or ask the human
 * anything. That is not a preference to respect; it is a footgun, and the
 * instruction was to say so rather than allow it quietly.
 */
export function mcpRemovalGuard(name: string): McpRemovalGuard {
    if (name === GENIE_SERVER_NAME) {
        return {
            allowed: false,
            reason:
                'The genie server is how this agent reports it has finished, asks you a question, and reaches every host tool. An agent without it still starts and still looks healthy — it just cannot reach you. Genie will not remove it.',
        };
    }
    if (name === AGENTINBOX_CLAUDE_CHANNEL_NAME) {
        return {
            allowed: false,
            reason:
                'This is the AgentInbox channel — the same lifeline as the genie server, on the delivery side. Removing it drops messages sent to this agent with no error. Genie will not remove it.',
        };
    }
    return { allowed: true };
}

/**
 * Whether a running agent can be PROVED to predate its current MCP config.
 *
 * The three TUIs all read their servers once, at session start. So a config
 * written after this session started did not reach it — and `ready_at` is set at
 * or after that start, which makes `configMtime > readyAt` a proof.
 *
 * There is deliberately no `current` verdict. The converse does not follow: a
 * session can start before the write and become ready after it, so a config
 * older than `ready_at` proves nothing. Reporting "up to date" there would be a
 * claim the data does not support, and this whole surface exists because
 * something looked fine and was not.
 */
export function mcpConfigDrift(input: {
    running: boolean;
    readyAt: number | null;
    configMtimeMs: number | null;
}): 'not-running' | 'stale' | 'unproven' {
    if (!input.running) return 'not-running';
    if (input.readyAt === null || input.configMtimeMs === null) return 'unproven';
    return input.configMtimeMs > input.readyAt ? 'stale' : 'unproven';
}

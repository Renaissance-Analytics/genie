import { TYNN_SERVER_NAME } from '../mcp/agent-config';
import {
    AGENTINBOX_CLAUDE_CHANNEL_NAME,
    GENIE_OWNED_SERVERS,
    GENIE_SERVER_NAME,
    isGenieOwnedServer,
} from '../mcp/genie-servers';

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

/* The shapes live in `agent-manager-types.ts` — a ZERO-IMPORT leaf — because
   the renderer needs them and this module reaches `mcp/agent-config.ts`, which
   reaches electron and the filesystem. Importing them from here would drag all
   of that into the renderer's compilation. See that file's header. */
export type { AgentMcpServer, McpConfigSource } from './agent-manager-types';
// Re-exporting does NOT bind the names locally, and this module uses both in
// its own signatures.
import type { AgentMcpServer, McpConfigSource } from './agent-manager-types';

/** The entries Genie writes and re-writes — everything it owns, plus `tynn`,
 *  which Genie writes but which points at Tynn rather than at Genie's endpoint. */
const MANAGED = new Set<string>([...GENIE_OWNED_SERVERS, TYNN_SERVER_NAME]);

/** The entries an agent cannot function without. Every server Genie points at
 *  its OWN endpoint qualifies: the tool channel and the delivery channel are
 *  both lifelines, and a third would be too (genie#618). */
const REQUIRED = new Set<string>(GENIE_OWNED_SERVERS);

/* `mcpSourceForTui` now lives in `mcp/genie-servers.ts` — a zero-import leaf —
   because the post-upgrade reconnect needs the same TUI→config mapping to work
   out which servers an upgrade replaced, and that module is PURE while this one
   reaches `mcp/agent-config.ts` (fs, db, plugins). Re-exported so this stays its
   address for the surfaces already reading it. See genie#613. */
export { mcpSourceForTui } from '../mcp/genie-servers';
// Re-exporting does NOT bind the name locally, and `agentMcpServers` below uses
// it.
import { mcpSourceForTui } from '../mcp/genie-servers';

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
 * WHY each Genie-owned server is not a human's to add or remove.
 *
 * Structured so that {@link GENIE_OWNED_SERVERS} membership is the ONLY gate
 * and these are only the wording (genie#618). The obvious shape — an `if` per
 * name, with a derived check last — reads the same and tests as a lie: with
 * every declared name carrying its own branch, a test asserting "every owned
 * server is refused" passes just as well with the derived check DELETED, so it
 * proves nothing about the case it exists for. Here, deleting the membership
 * test breaks every refusal at once.
 *
 * A name with no entry still gets refused, with the generic sentence below. It
 * is the third server nobody has written prose for yet, and the whole point is
 * that it is covered on the day it is declared rather than the day someone
 * notices.
 */
const OWNED_SERVER_REASONS: Record<string, { add: string; remove: string }> = {
    [GENIE_SERVER_NAME]: {
        add: 'Genie writes its own server entry. Toggle Agent MCP on the workspace instead of adding it by hand — a hand-written one is overwritten on the next sync.',
        remove:
            'The genie server is how this agent reports it has finished, asks you a question, and reaches every host tool. An agent without it still starts and still looks healthy — it just cannot reach you. Genie will not remove it.',
    },
    [AGENTINBOX_CLAUDE_CHANNEL_NAME]: {
        add: 'That name belongs to the AgentInbox channel bridge, which Genie writes and rewrites. A hand-written entry there is overwritten on the next sync — and until it is, it sits on the push-delivery path, where a broken server drops messages to this agent with no error.',
        remove:
            'This is the AgentInbox channel — the same lifeline as the genie server, on the delivery side. Removing it drops messages sent to this agent with no error. Genie will not remove it.',
    },
};

function ownedServerGuard(name: string, kind: 'add' | 'remove'): McpRemovalGuard {
    if (!isGenieOwnedServer(name)) return { allowed: true };
    const written = OWNED_SERVER_REASONS[name]?.[kind];
    if (written) return { allowed: false, reason: written };
    return {
        allowed: false,
        reason:
            kind === 'add'
                ? `Genie writes and owns the "${name}" entry. A hand-written one is overwritten on the next sync — add your server under a different name.`
                : `Genie writes and owns the "${name}" entry, and rewrites it on the next workspace sync. Removing it here would not stick. Genie will not remove it.`,
    };
}

/**
 * Whether a human may ADD a server under this name.
 *
 * The mirror of {@link mcpRemovalGuard}, and pure for the same reason: this
 * decision was inline in `addAgentMcpServer`, which needs a registered agent and
 * a workspace row before it can be reached — so the one branch worth testing was
 * the one nothing could call. It had also fallen a name behind: it refused
 * `genie` and accepted `genie-agentinbox-channel`, which is genie#618.
 */
export function mcpAddGuard(name: string): McpRemovalGuard {
    return ownedServerGuard(name, 'add');
}

/**
 * Whether a human may remove this server.
 *
 * Every server Genie points at its own endpoint is refused. This is the one
 * place in the surface that says no, and it says no because the alternative is
 * silent: an agent whose `genie` server is gone still starts, still draws a
 * square, still looks fine — and can no longer report that it finished or ask
 * the human anything. That is not a preference to respect; it is a footgun, and
 * the instruction was to say so rather than allow it quietly.
 */
export function mcpRemovalGuard(name: string): McpRemovalGuard {
    return ownedServerGuard(name, 'remove');
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

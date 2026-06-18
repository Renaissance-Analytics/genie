import fs from 'node:fs';
import path from 'node:path';

/**
 * MCP config consolidation for `.agi` envelopes.
 *
 * Repos brought into an envelope often carry their own MCP config —
 * Claude's `.mcp.json` or Cursor's `.cursor/mcp.json` (both use the same
 * `mcpServers` shape). A Claude/Cursor session opened at the ENVELOPE
 * root won't see configs buried inside `repos/<name>/`, so we surface the
 * union of every repo's servers at the envelope root, written to BOTH
 * `.mcp.json` and `.cursor/mcp.json` so either tool picks it up.
 *
 * Precedence: a server the envelope root already defines wins over a
 * repo-sourced one of the same name (the root is authoritative); among
 * repos, first-seen wins. Genie never invents servers — it only relocates
 * what the repos already declared.
 */

export interface McpServers {
    [name: string]: unknown;
}

const ROOT_FILE = '.mcp.json';
const CURSOR_FILE = path.join('.cursor', 'mcp.json');

/**
 * MCP servers that a Claude Code plugin (or similar tool) injects into a
 * client's config at runtime — they are NOT declared in the envelope's own
 * `.mcp.json` / `.cursor/mcp.json`, so their presence in one config but not
 * the other must never count as an out-of-sync discrepancy, and consolidation
 * must never try to relocate them into the envelope config. Stripped from
 * every read below so the ignore applies uniformly to the sync boolean, the
 * missing-servers list, and the consolidate action. Add other plugin-provided
 * server names here as they surface.
 */
const IGNORED_SERVERS = new Set<string>(['fancy-ui']);

function readServers(file: string): McpServers {
    try {
        if (!fs.existsSync(file)) return {};
        const json = JSON.parse(fs.readFileSync(file, 'utf8')) as {
            mcpServers?: McpServers;
        };
        const servers =
            json.mcpServers && typeof json.mcpServers === 'object'
                ? json.mcpServers
                : {};
        // Drop plugin-provided servers so they're invisible to every
        // comparison and to consolidation.
        const filtered: McpServers = {};
        for (const [name, def] of Object.entries(servers)) {
            if (!IGNORED_SERVERS.has(name)) filtered[name] = def;
        }
        return filtered;
    } catch {
        // Malformed JSON — skip rather than crash the whole conversion.
        return {};
    }
}

/** Server names declared in either MCP file inside a given dir. */
function serversInDir(dir: string): McpServers {
    return {
        ...readServers(path.join(dir, ROOT_FILE)),
        ...readServers(path.join(dir, CURSOR_FILE)),
    };
}

/** Every repo's MCP servers, keyed by repo dir name (first-seen wins). */
function collectRepoServers(envelopePath: string): McpServers {
    const reposDir = path.join(envelopePath, 'repos');
    if (!fs.existsSync(reposDir)) return {};
    const merged: McpServers = {};
    for (const entry of fs.readdirSync(reposDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const found = serversInDir(path.join(reposDir, entry.name));
        for (const [name, def] of Object.entries(found)) {
            if (!(name in merged)) merged[name] = def;
        }
    }
    return merged;
}

export interface McpStatus {
    /** Server names declared by repos under repos/. */
    repoServers: string[];
    /** Server names already present at the envelope root. */
    rootServers: string[];
    /** Repo servers not yet surfaced at the root. */
    missingAtRoot: string[];
    /** True when consolidation would add or change something. */
    needsConsolidation: boolean;
}

export function mcpStatus(envelopePath: string): McpStatus {
    const repo = collectRepoServers(envelopePath);
    const root = serversInDir(envelopePath);
    const repoServers = Object.keys(repo);
    const rootServers = Object.keys(root);
    const missingAtRoot = repoServers.filter((n) => !(n in root));
    // Also flag when one of the two root files is out of sync with the
    // other (e.g. .mcp.json has servers but .cursor/mcp.json is absent).
    const rootMcp = Object.keys(readServers(path.join(envelopePath, ROOT_FILE)));
    const rootCursor = Object.keys(
        readServers(path.join(envelopePath, CURSOR_FILE)),
    );
    const filesDiverge =
        rootServers.length > 0 &&
        (rootMcp.length !== rootServers.length ||
            rootCursor.length !== rootServers.length);
    return {
        repoServers,
        rootServers,
        missingAtRoot,
        needsConsolidation: missingAtRoot.length > 0 || filesDiverge,
    };
}

export interface ConsolidateMcpResult {
    /** Server names written to the root config. */
    servers: string[];
    /** Files written (relative paths). Empty when nothing to do. */
    files: string[];
}

/**
 * Merge every repo's MCP servers with whatever the envelope root already
 * declares (root wins) and write the union to BOTH root config files.
 * No-op when there are no servers anywhere. Returns what was written so
 * callers can commit it.
 */
export function consolidateMcp(envelopePath: string): ConsolidateMcpResult {
    const repo = collectRepoServers(envelopePath);
    const root = serversInDir(envelopePath);
    const merged: McpServers = { ...repo, ...root }; // root wins
    const names = Object.keys(merged);
    if (names.length === 0) return { servers: [], files: [] };

    const payload = JSON.stringify({ mcpServers: merged }, null, 2) + '\n';

    const rootPath = path.join(envelopePath, ROOT_FILE);
    fs.writeFileSync(rootPath, payload, 'utf8');

    const cursorPath = path.join(envelopePath, CURSOR_FILE);
    fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
    fs.writeFileSync(cursorPath, payload, 'utf8');

    return { servers: names, files: [ROOT_FILE, '.cursor/mcp.json'] };
}

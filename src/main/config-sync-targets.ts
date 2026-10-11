import { join } from 'node:path';
import type { SyncTarget } from '../core/integrations.js';

/**
 * CONFIG SYNC TARGETS (§6.9) — Genie's MCP endpoint written into FOUR independent places in a
 * workspace, so every harness a person opens there finds Genie: Claude Code's `.mcp.json`, Cursor's
 * `.cursor/mcp.json`, Codex's `.codex/config.toml`, and the imDone Stop hook in
 * `.claude/settings.local.json`. Each MERGES into what is there — other servers and a person's own
 * entries stay — each is gated by its own setting (off = write nothing, remove nothing), and the
 * core's `configSync` reports each on its own. The filesystem is a port.
 */

export interface SyncFs {
    read(path: string): Promise<string | null>;
    write(path: string, text: string): Promise<void>;
}

export interface SyncFlags {
    readonly mcp_sync_claude: boolean;
    readonly mcp_sync_cursor: boolean;
    readonly mcp_sync_codex: boolean;
    readonly mcp_sync_hooks: boolean;
}

type Payload = Readonly<Record<string, string>>;

const SERVER_KEY = 'genie';
const TOML_BEGIN = '# >>> genie — managed by Genie; edits between the markers are replaced on sync';
const TOML_END = '# <<< genie';

function serverEntry(payload: Payload): Record<string, unknown> {
    return { type: 'http', url: payload.GENIE_MCP_URL, ...(payload.GENIE_MCP_TOKEN ? { headers: { Authorization: `Bearer ${payload.GENIE_MCP_TOKEN}` } } : {}) };
}

async function readJson(fs: SyncFs, path: string): Promise<Record<string, unknown>> {
    const text = await fs.read(path);
    if (text === null) return {};
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

function mergeMcpServers(current: Record<string, unknown>, payload: Payload): Record<string, unknown> {
    const servers = typeof current.mcpServers === 'object' && current.mcpServers !== null ? (current.mcpServers as Record<string, unknown>) : {};
    return { ...current, mcpServers: { ...servers, [SERVER_KEY]: serverEntry(payload) } };
}

function stopHook(payload: Payload): Record<string, unknown> {
    // Fires imDone for this terminal when the agent stops; the token rides the header the server checks.
    const auth = payload.GENIE_MCP_TOKEN ? ` -H "Authorization: Bearer ${payload.GENIE_MCP_TOKEN}"` : '';
    const body = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"imDone","arguments":{"terminalId":"$GENIE_TERMINAL_ID"}}}';
    return { matcher: '', hooks: [{ type: 'command', command: `curl -s -X POST${auth} -H "Content-Type: application/json" -H "Mcp-Param-TerminalId: $GENIE_TERMINAL_ID" --data '${body}' ${payload.GENIE_MCP_URL} > /dev/null` }] };
}

function isGenieStopHook(hook: unknown): boolean {
    // Match on the command text itself: a re-stringified object escapes the inner quotes and never matches.
    if (typeof hook !== 'object' || hook === null) return false;
    const inner = (hook as { hooks?: unknown }).hooks;
    return Array.isArray(inner) && inner.some((h) => typeof (h as { command?: unknown }).command === 'string' && ((h as { command: string }).command.includes('"name":"imDone"')));
}

export function configSyncTargets(input: { workspacePath: string; fs: SyncFs; flags: SyncFlags }): SyncTarget[] {
    const { fs, flags } = input;
    const path = (...parts: string[]) => join(input.workspacePath, ...parts).replace(/\\/g, '/');
    const jsonTarget = (id: string, label: string, file: string, on: boolean): SyncTarget => ({
        id,
        label,
        write: async (payload) => {
            if (!on) return;
            await fs.write(file, `${JSON.stringify(mergeMcpServers(await readJson(fs, file), payload), null, 2)}\n`);
        },
    });
    return [
        jsonTarget('claude', 'Claude Code (.mcp.json)', path('.mcp.json'), flags.mcp_sync_claude),
        jsonTarget('cursor', 'Cursor (.cursor/mcp.json)', path('.cursor', 'mcp.json'), flags.mcp_sync_cursor),
        {
            id: 'codex',
            label: 'Codex (.codex/config.toml)',
            write: async (payload) => {
                if (!flags.mcp_sync_codex) return;
                const file = path('.codex', 'config.toml');
                const current = (await fs.read(file)) ?? '';
                const block = `${TOML_BEGIN}\n[mcp_servers.${SERVER_KEY}]\nurl = ${JSON.stringify(payload.GENIE_MCP_URL)}\n${payload.GENIE_MCP_TOKEN ? `http_headers = { Authorization = ${JSON.stringify(`Bearer ${payload.GENIE_MCP_TOKEN}`)} }\n` : ''}${TOML_END}`;
                const begin = current.indexOf(TOML_BEGIN);
                const end = current.indexOf(TOML_END);
                const next = begin >= 0 && end > begin ? current.slice(0, begin) + block + current.slice(end + TOML_END.length) : `${current}${current.length === 0 || current.endsWith('\n') ? '' : '\n'}${block}\n`;
                await fs.write(file, next);
            },
        },
        {
            id: 'hooks',
            label: 'Claude Code Stop hook (.claude/settings.local.json)',
            write: async (payload) => {
                if (!flags.mcp_sync_hooks) return;
                const file = path('.claude', 'settings.local.json');
                const current = await readJson(fs, file);
                const hooks = typeof current.hooks === 'object' && current.hooks !== null ? (current.hooks as Record<string, unknown[]>) : {};
                const stop = Array.isArray(hooks.Stop) ? hooks.Stop.filter((h) => !isGenieStopHook(h)) : [];
                await fs.write(file, `${JSON.stringify({ ...current, hooks: { ...hooks, Stop: [...stop, stopHook(payload)] } }, null, 2)}\n`);
            },
        },
    ];
}

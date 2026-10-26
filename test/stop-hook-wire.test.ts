import { afterEach, expect, it } from 'vitest';
import { genieToolDeps } from '../src/main/genie-tool-deps.js';
import { allGenieTools } from '../src/main/mcp-registrations.js';
import { genieMcpServer, type GenieMcpServer } from '../src/main/mcp-server.js';
import type { Caller } from '../src/main/mcp-tools.js';
import { configSyncTargets } from '../src/main/config-sync-targets.js';

/**
 * THE imDone STOP HOOK, SENT EXACTLY AS CONFIG SYNC WRITES IT, IS ANSWERED BY GENIE'S SERVER (genie#869). The hook is a
 * one-shot `curl` with no `initialize` first (a stateless request), its output thrown away — so if the server refuses it
 * (no `_meta`, a missing protocol header), nobody ever knows. This replays the hook's own body and headers against the real
 * server over HTTP: the call must reach imDone.
 */

const term: Caller = { agentId: 'claude:builder' as Caller['agentId'], agentName: 'builder', workspaceId: 'ws_1', workspacePath: '/w' };
const never = (() => { throw new Error('not exercised'); }) as never;
let server: GenieMcpServer | null = null;
afterEach(async () => { await server?.stop(); server = null; });

it('the generated Stop hook reaches imDone (no initialize, the hook’s own headers and body)', async () => {
    const done: string[] = [];
    server = genieMcpServer({
        port: 0,
        registrations: allGenieTools(genieToolDeps({
            inbox: never, knowledge: never, settings: never, approve: never, roster: () => [],
            attention: { imDone: async (input: { agentId: string }) => { done.push(input.agentId); return { ok: true, handoff: { saved: false, reason: 'none given' }, checklist: [] }; } } as never,
            resolveCaller: (id) => (id === 'term_7' ? term : null),
            userActive: () => true, glow: () => false, thumbsUp: never, openFile: never, terminals: never,
            plugins: { tools: () => [], guard: () => null, run: never },
        })),
    });
    const { url, token } = await server.start();

    // The hook exactly as config sync writes it into .claude/settings.local.json.
    const files = new Map<string, string>();
    const fs = { read: async (p: string) => files.get(p) ?? null, write: async (p: string, t: string) => { files.set(p, t); } };
    const hooks = configSyncTargets({ workspacePath: '/w', fs, flags: { mcp_sync_claude: false, mcp_sync_cursor: false, mcp_sync_codex: false, mcp_sync_hooks: true } }).find((t) => t.id === 'hooks')!;
    await hooks.write({ GENIE_MCP_URL: url, GENIE_MCP_TOKEN: token });
    const settings = JSON.parse([...files.values()][0]!) as { hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> } };
    const command = settings.hooks.Stop[0]!.hooks[0]!.command.replace(/\$GENIE_TERMINAL_ID/g, 'term_7');
    const body = /--data '([^']+)'/.exec(command)![1]!;
    const headers: Record<string, string> = {};
    for (const m of command.matchAll(/-H "([^:]+): ([^"]*)"/g)) headers[m[1]!] = m[2]!;

    const res = await fetch(url, { method: 'POST', headers, body });
    const text = await res.text();
    expect({ status: res.status, refused: /"error"|isError":true/.test(text) }).toEqual({ status: 200, refused: false });
    expect(done).toEqual(['claude:builder']);
});

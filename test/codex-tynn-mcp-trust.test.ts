import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TYNN_TOML_BEGIN, TYNN_TOML_END } from '../src/main/tynn-agent-token.js';

/**
 * THE TYNN SERVER REACHES A CODEX SESSION THE WAY THE GENIE SERVER DOES (2026-10-22). Genie writes `[mcp_servers.tynn]`
 * into the workspace's `.codex/config.toml` (#1098, config sync), so Codex loads it from the file — and asks before its
 * tools run, which a session has nobody to answer. prism-acp only lets a session approve a server it was GIVEN
 * (`mcpToolApproval names "tynn", which is not one of the MCP servers given`), so the Tynn server Genie wrote is handed to
 * the session beside Genie's own, from the same block config sync wrote: one token, read back, never minted here.
 *
 * Imported lazily so that on origin/main these fail on their assertions, not on a missing export.
 */
const module = () => import('../src/main/tynn-agent-token.js');

const codexToml = (url: string, token: string) => `[model]\nname = "gpt-5"\n\n${TYNN_TOML_BEGIN}\n[mcp_servers.tynn]\nurl = ${JSON.stringify(url)}\nhttp_headers = { Authorization = ${JSON.stringify(`Bearer ${token}`)} }\n${TYNN_TOML_END}\n`;

describe('the Tynn server Genie wrote, as a session’s MCP server', () => {
    it('is read back from the workspace’s Codex config: the url and the literal token, under the name config sync used', async () => {
        const { tynnMcpServersOnDisk } = await module();
        const files: Record<string, string> = { '/w/.codex/config.toml': codexToml('https://tynn.ai/mcp', 'tok_1') };
        const read = (path: string) => files[path.replace(/\\/g, '/')] ?? null;
        expect(tynnMcpServersOnDisk('/w', read)).toEqual([{ type: 'http', name: 'tynn', url: 'https://tynn.ai/mcp', headers: [{ name: 'Authorization', value: 'Bearer tok_1' }] }]);
    });

    it('a workspace with no Tynn token gets no server (and nothing is minted here)', async () => {
        const { tynnMcpServersOnDisk } = await module();
        expect(tynnMcpServersOnDisk('/w', () => null)).toEqual([]);
        // A block without a literal token (Genie 1's `${ENV}` form) is not a server a session can use.
        expect(tynnMcpServersOnDisk('/w', (p) => (p.endsWith('.codex/config.toml') ? codexToml('https://tynn.ai/mcp', '${TYNN_TOKEN}') : null))).toEqual([]);
    });

    it('main hands it to a Codex session beside Genie’s own server', () => {
        const main = readFileSync('src/main/main.ts', 'utf8');
        const line = main.match(/mcpServersFor: \(record\) =>[^\n]*(?:\n[^\n]*){0,6}/)?.[0] ?? '';
        expect(line).toContain('genieMcpServers(');
        expect(line).toContain('tynnMcpServersOnDisk(');
        expect(line).toContain("'codex'");
    });
});

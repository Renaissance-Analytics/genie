import { describe, expect, it, vi, beforeEach } from 'vitest';

// Verify the per-target config-sync gating (alpha.74): writeWorkspaceAgentMcp
// only touches a target's file when its mcp_sync_* setting is on, and leaves it
// ENTIRELY ALONE (no write, no remove) when off. We back fs with an in-memory
// map and drive the settings via the mocked db.

const files = new Map<string, string>();
let settings: Record<string, string> = {};

vi.mock('fs', () => ({
    default: {
        existsSync: (p: string) => files.has(p),
        readFileSync: (p: string) => {
            if (!files.has(p)) throw new Error('ENOENT');
            return files.get(p)!;
        },
        writeFileSync: (p: string, data: string) => {
            files.set(p, data);
        },
        mkdirSync: () => {},
    },
}));
vi.mock('../../db', () => ({ getAllSettings: () => settings }));

import path from 'node:path';
import { writeWorkspaceAgentMcp } from '../agent-config';

// Build keys with path.join so they match the separators agent-config uses
// (backslashes on Windows, forward slashes elsewhere).
const WS = path.join('/ws', 'demo');
const mcpJson = path.join(WS, '.mcp.json');
const cursorJson = path.join(WS, '.cursor', 'mcp.json');
const URL = 'http://127.0.0.1:51717/mcp/tok';

beforeEach(() => {
    files.clear();
    settings = {};
});

describe('writeWorkspaceAgentMcp — per-target sync gating', () => {
    it('writes all targets when every sync flag is on (default)', () => {
        settings = { mcp_sync_claude: 'on', mcp_sync_cursor: 'on', mcp_sync_agents: 'on' };
        writeWorkspaceAgentMcp(WS, true, URL);
        expect(files.has(mcpJson)).toBe(true);
        expect(files.has(cursorJson)).toBe(true);
        expect(JSON.parse(files.get(mcpJson)!).mcpServers.genie.url).toBe(URL);
    });

    it('leaves .cursor/mcp.json untouched when mcp_sync_cursor is off', () => {
        settings = { mcp_sync_cursor: 'off' };
        writeWorkspaceAgentMcp(WS, true, URL);
        expect(files.has(mcpJson)).toBe(true); // Claude still synced (default on)
        expect(files.has(cursorJson)).toBe(false); // Cursor never created
    });

    it('does not REMOVE an off target on disable (manual edits stick)', () => {
        // User has a Cursor config with the genie entry; Cursor sync is off.
        files.set(
            cursorJson,
            JSON.stringify({ mcpServers: { genie: { url: URL }, other: { command: 'x' } } }),
        );
        settings = { mcp_sync_cursor: 'off' };
        writeWorkspaceAgentMcp(WS, false, null); // disable
        // The file is left byte-for-byte alone — genie entry NOT removed.
        expect(JSON.parse(files.get(cursorJson)!).mcpServers.genie).toEqual({ url: URL });
    });

    it('leaves .mcp.json untouched when mcp_sync_claude is off', () => {
        settings = { mcp_sync_claude: 'off' };
        writeWorkspaceAgentMcp(WS, true, URL);
        expect(files.has(mcpJson)).toBe(false);
        expect(files.has(cursorJson)).toBe(true); // Cursor default-on
    });
});

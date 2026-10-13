import { describe, expect, it } from 'vitest';
import { GENIE_IGNORES, writeAgentGitignore, type IgnoreFs } from '../src/main/agent-gitignore.js';

/**
 * THE TOKENS GENIE WRITES ARE NEVER COMMITTED (the owner: Genie 2 manages every workspace agent file). The sync puts
 * Genie's MCP bearer token into `.mcp.json`, `.codex/config.toml` and `.cursor/mcp.json`, and regenerates
 * `.agents/_genie/` and the `genie*` skills on every run. Genie 1 appended ignore lines for them; Genie 2 did not, so a
 * workspace first added in Genie 2 had a token in `.mcp.json` and nothing keeping it out of a commit. The sync appends
 * each MISSING line once, under one Genie heading; a person's lines are never reordered or removed.
 */
function memFs(files: Record<string, string>) {
    const store = new Map(Object.entries(files));
    let writes = 0;
    const fs: IgnoreFs = { read: async (p) => store.get(p) ?? null, write: async (p, t) => { writes++; store.set(p, t); } };
    return { fs, store, writes: () => writes };
}
const W = '/w/moic';
const run = (fs: IgnoreFs) => writeAgentGitignore({ workspacePath: W, fs });

describe('.gitignore', () => {
    it('a workspace with none gets every Genie line, the token files among them', async () => {
        const { fs, store } = memFs({});
        await run(fs);
        const lines = store.get(`${W}/.gitignore`)!.split('\n');
        for (const l of ['.mcp.json', '.codex/config.toml', '.cursor/mcp.json', '.claude/settings.local.json', '.env', '.agents/_genie/', '.agents/skills/genie*/', '.claude/skills/genie*/']) expect(lines).toContain(l);
        expect(GENIE_IGNORES.length).toBe(8);
    });

    it('only the missing lines are appended, once; a person\'s lines and CRLF are kept as they are', async () => {
        const before = 'node_modules/\r\n.mcp.json\r\n.env\r\n';
        const { fs, store } = memFs({ [`${W}/.gitignore`]: before });
        await run(fs);
        const after = store.get(`${W}/.gitignore`)!;
        expect(after.startsWith(before)).toBe(true);
        expect(after.match(/^\.mcp\.json\r?$/gm)).toHaveLength(1);
        expect(after.match(/^\.env\r?$/gm)).toHaveLength(1);
        expect(after).toContain('.codex/config.toml\r\n');
        expect(after).not.toMatch(/[^\r]\n/);
    });

    it('a .gitignore that already has every line is not written (positive control: the same file minus one line is)', async () => {
        const full = `${GENIE_IGNORES.join('\n')}\n`;
        const a = memFs({ [`${W}/.gitignore`]: full });
        await run(a.fs);
        expect(a.writes()).toBe(0);
        const b = memFs({ [`${W}/.gitignore`]: full.replace('.mcp.json\n', '') });
        await run(b.fs);
        expect(b.writes()).toBe(1);
        await run(b.fs);
        expect(b.writes()).toBe(1);
    });
});

/**
 * THE FILES GENIE WRITES INTO A WORKSPACE THAT MUST NEVER BE COMMITTED. Three carry Genie's MCP bearer token
 * (`.mcp.json`, `.codex/config.toml`, `.cursor/mcp.json`), two are machine-local (`.claude/settings.local.json`, `.env`),
 * and three are regenerated on every sync (`.agents/_genie/`, the `genie*` skills for both harnesses). Each missing line
 * is appended once, under one Genie heading, in the file's own line endings; nothing a person wrote is moved or removed.
 */
export interface IgnoreFs {
    read(path: string): Promise<string | null>;
    write(path: string, text: string): Promise<void>;
}

export const GENIE_IGNORES: readonly string[] = [
    '.mcp.json',
    '.codex/config.toml',
    '.cursor/mcp.json',
    '.claude/settings.local.json',
    '.env',
    '.agents/_genie/',
    '.agents/skills/genie*/',
    '.claude/skills/genie*/',
];

const HEADING = '# Genie: machine-local agent config (carries Genie\'s MCP token) and regenerated agent files — never commit';

export async function writeAgentGitignore(input: { workspacePath: string; fs: IgnoreFs }): Promise<void> {
    const path = `${input.workspacePath}/.gitignore`;
    const before = (await input.fs.read(path)) ?? '';
    const have = new Set(before.split(/\r?\n/).map((l) => l.trim()));
    const missing = GENIE_IGNORES.filter((l) => !have.has(l));
    if (missing.length === 0) return;
    const eol = before.includes('\r\n') ? '\r\n' : '\n';
    const lead = before === '' ? '' : before.endsWith('\n') ? eol : `${eol}${eol}`;
    const heading = have.has(HEADING) ? [] : [HEADING];
    await input.fs.write(path, `${before}${lead}${[...heading, ...missing].join(eol)}${eol}`);
}

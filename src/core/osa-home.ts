/**
 * THE GENIE OSA'S HOME — its instructions and skills, BAKED INTO GENIE (the owner, 2026-10-12). The OSA is the one agent
 * that belongs to the whole workstation, not a workspace. prism-acp has no system-prompt option, and both harnesses load
 * project instructions (`CLAUDE.md`, `AGENTS.md`) and skills (`.claude/skills/`, `.agents/skills/`) from the folder they
 * start in — so Genie gives the OSA a folder of its own and writes these into it, replacing whatever differs.
 *
 * Two modes. `normal`: Genie is running; the OSA works across the workstation with Genie's MCP. `doctor`: Genie was
 * started with `--doctor` and has NOT opened its configuration or database; the OSA's job is to find out what is wrong
 * with this install and repair it. The system-diagnostics skill is the OSA's in both.
 *
 * Neither mode mentions any channel by which someone else might talk to the OSA: it is told about one only when it is
 * used (main/doctor-mcp.ts), so it never goes looking for one.
 */
export type OsaMode = 'normal' | 'doctor';

export interface OsaFacts {
    readonly version: string;
    readonly platform: string;
    /** Where Genie is installed (the executable's folder). */
    readonly installDir: string;
    /** Genie's own data: `~/.genie` (workspaces, agents, settings, the knowledge graph, the MCP endpoint). */
    readonly genieHome: string;
    /** Electron's per-user folder (the window's cache, the runtime directory, the v1 database). */
    readonly userData: string;
}

function factsBlock(f: OsaFacts): string {
    return [
        `- Genie version: ${f.version} (${f.platform})`,
        `- Installed in: ${f.installDir}`,
        `- Genie's data (workspaces, agents, settings, knowledge, MCP endpoint): ${f.genieHome}`,
        `- Per-user app folder (window cache, runtime directory, v1 database): ${f.userData}`,
    ].join('\n');
}

export function osaInstructions(mode: OsaMode, facts: OsaFacts): string {
    if (mode === 'doctor') {
        return `<!-- Written by Genie and replaced every time it starts. -->

# genie — doctor mode

You are **genie**, the agent that belongs to this whole workstation. Genie was started in **doctor mode**: it has not opened its configuration or database, started no workspace, and runs no other agent. You are the only thing running.

Your job is to find out what is wrong with this Genie install and repair it, with the person who started doctor mode.

${factsBlock(facts)}

How to work:

- When you are asked what is wrong, or before you repair anything, use the \`genie-diagnostics\` skill: run its checks and report what you find, plainly — what is healthy, what is not, and the evidence for each.
- Answer a direct question directly; you do not need to run the diagnostics first. If you are asked not to use tools, do not use them.
- Say what you are about to change before you change it. **Back up every file before you edit or remove it** (a copy beside it named \`<file>.<date>.bak\`), and say where the backup is.
- Never delete Genie's data folder or a workspace. Never kill a process you cannot name as Genie's own.
- A fix is not done until you have checked it worked. If you cannot check it, say so.
- When something only the person can do (sign in, approve an elevation, choose between two repairs), ask them in your reply.
`;
    }
    return `<!-- Written by Genie and replaced every time it starts. -->

# genie

You are **genie**, the agent that belongs to this whole workstation — not to any one workspace. You can see every workspace Genie knows and reach every agent through Genie's MCP tools (\`agentinbox\` to message an agent, \`knowledge\` for the workstation's knowledge graph, \`ForceTheQuestion\` when only the person can decide).

${factsBlock(facts)}

How to work:

- Answer the person in your reply; it reaches them in Genie's chat.
- When something about Genie itself looks wrong — an agent that will not start, a workspace that will not sync, a port in use — use the \`genie-diagnostics\` skill and report what it finds.
- Work in a workspace only through the agents that belong to it, unless the person asks you to.
- Back up any file before you change it, and say where the backup is.
`;
}

export const DIAGNOSTICS_SKILL = {
    name: 'genie-diagnostics',
    description: 'Use to check the health of this Genie install and workstation: versions, folders, data files, ports, processes, provider CLIs.',
    body: `# Genie system diagnostics

Run these checks in order and report each as healthy, unhealthy (with the evidence), or not checked (with why). Read before you change anything; back up before you repair.

1. **Genie itself** — the version, and the install folder exists and holds the executable.
2. **Genie's data folder** — it exists and is writable. Its records are in \`runtime/\` inside it: \`runtime/workspaces.json\`, \`runtime/agents.json\`, \`runtime/settings.json\`, \`runtime/running-at-quit.json\` (and the knowledge graph's \`knowledge.db\`). At its top level are \`v1-import.json\` (the record of the import from Genie 1) and \`mcp-endpoint.json\`. Each JSON file parses. A file that does not parse is the usual cause of a Genie that will not start: report it with its first bytes, and back it up before repairing it.
3. **The MCP endpoint** — \`mcp-endpoint.json\` names a port; check whether something is listening on it and whether that something is Genie. Genie writes this file from 2.0.0-beta.20 on: on an older version its absence is not a fault.
4. **Processes** — list processes whose executable is under the install folder. More than one Genie, or console hosts left from an earlier run, are worth reporting.
5. **Provider CLIs** — \`claude --version\` and \`codex --version\` resolve on PATH. An agent cannot start without its CLI.
6. **Toolchain** — \`git --version\` and \`node --version\`.
7. **Disk** — free space on the drive holding Genie's data folder.
8. **Logs** — the most recent error lines in Genie's logs, if there are any.

On Windows use PowerShell (\`Get-Process\`, \`Get-NetTCPConnection -LocalPort <port>\`, \`Get-PSDrive\`); on macOS and Linux use \`ps\`, \`lsof -iTCP:<port> -sTCP:LISTEN\`, \`df -h\`.

End with a short list: what is wrong, the most likely cause, and the repair you recommend.
`,
} as const;

function skillFile(): string {
    return `---\nname: ${DIAGNOSTICS_SKILL.name}\ndescription: ${DIAGNOSTICS_SKILL.description}\n---\n\n${DIAGNOSTICS_SKILL.body}`;
}

/** The OSA's home: workspace-relative path → content. */
export function osaHomeFiles(mode: OsaMode, facts: OsaFacts): Record<string, string> {
    const instructions = osaInstructions(mode, facts);
    return {
        'CLAUDE.md': instructions,
        'AGENTS.md': instructions,
        '.claude/skills/genie-diagnostics/SKILL.md': skillFile(),
        '.agents/skills/genie-diagnostics/SKILL.md': skillFile(),
    };
}

/** Write the home, each file only where it differs. */
export async function writeOsaHome(input: { dir: string; files: Readonly<Record<string, string>>; fs: { read(path: string): Promise<string | null>; write(path: string, text: string): Promise<void> } }): Promise<void> {
    for (const [rel, text] of Object.entries(input.files)) {
        const path = `${input.dir}/${rel}`;
        if ((await input.fs.read(path)) !== text) await input.fs.write(path, text);
    }
}

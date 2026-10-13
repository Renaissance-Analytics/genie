/**
 * GENIE 2'S SKILLS IN A WORKSPACE (the owner: Genie 2 manages every workspace agent file and upgrades Genie 1's).
 *
 * Claude reads skills from `.claude/skills/<name>/SKILL.md`, Codex from `.agents/skills/<name>/SKILL.md`. Genie 1 wrote
 * `genie-*` skills into both that send an agent to tools Genie 2 does not have (`connectToGenie`, `genieGuide`,
 * `checkIssues`, `manageProcess`, `manageWorkspaces`, `manageGappDev`) and a handoff skill for an upgrade that no longer
 * asks for one. Genie 2 writes its own skills, naming only the tools its MCP serves, and replaces them on every sync.
 * Genie 1's skills with no Genie 2 meaning are backed up under `.agents/_genie/backups/skills/` and removed with their
 * folder. Nothing else in a skills folder is touched — a person's skill, a plugin's skill.
 */
export interface SkillFs {
    read(path: string): Promise<string | null>;
    write(path: string, text: string): Promise<void>;
    remove(path: string): Promise<void>;
    /** The entries (files and folders) directly inside a folder; [] when it does not exist. */
    list(dir: string): Promise<string[]>;
    /** Remove an EMPTY folder. */
    removeDir(dir: string): Promise<void>;
}

export interface GenieSkill {
    readonly name: string;
    readonly description: string;
    readonly body: string;
}

export const GENIE_SKILLS: readonly GenieSkill[] = [
    {
        name: 'genie',
        description: 'Use whenever you work inside Genie 2 or its `genie` MCP tools are available: what each tool is for.',
        body: `# Working in Genie 2

Genie's MCP server (\`genie\`) comes with your session. Its tools:

- \`imDone\` when you hand work back, with a handoff: what you did, what is unfinished, what the next run picks up.
- \`ForceTheQuestion\` when only the person can make a decision. It returns at once; the answer arrives in your inbox.
- \`agentinbox\` to reach another agent. Never edit another agent's files to talk to it.
- \`lists\` for your own checklist and for things only a person can do.
- \`openFileForUser\` to put a file in front of the person.
- \`manageTerminals\` for shells, builds and services. You are never run in one yourself.
- \`runAgent\` to start your sidecar, a review partner with its own context.
- \`knowledge\` for the workstation's knowledge graph.
- \`thumbsUp\` to say you are ready; \`submitFeedback\` to tell Genie's makers about Genie itself.

Workspace rules are in \`RULES.md\`; they may be stricter than this.
`,
    },
    {
        name: 'genie-attention',
        description: 'Use when finishing work, handing back, surfacing a file, or needing a decision only the person can make.',
        body: `# Getting the person's attention

- Call \`imDone\` every time you hand work back, with a handoff note. It replaces your last one.
- Use \`ForceTheQuestion\` for a decision only the person can make: up to four questions, two to four options each, all in one call. The person reads the options, so you are "I" and they are "you"; when an option is about who acts, put the actor first ("Agent: …" / "You: …"). It never blocks: the answer arrives in your inbox.
- A question is never a \`lists\` item. Use \`lists\` for your own checklist and for things only a person can do.
- Use \`openFileForUser\` to put a result in front of the person.
- As a session, your reply already reaches the person in the chat; just answer. In a terminal, pass your \`GENIE_TERMINAL_ID\` with each call.
`,
    },
    {
        name: 'genie-agentinbox',
        description: 'Use to find other agents, message them, read your mail, and check receipts in Genie.',
        body: `# AgentInbox

Use \`agentinbox\` to list peers, send a message, receive your mail and check receipts. To wait for a reply, make ONE receive with \`wait: true\`; never poll in a loop. Only your own receive marks mail read. Address an agent as \`provider:name\`, or \`workspace:provider:name\` when two share a name. Attachments are copied, not referenced; executables are refused.
`,
    },
    {
        name: 'genie-terminals',
        description: 'Use when you need a shell, a build, a long-running service, or your sidecar in Genie.',
        body: `# Terminals and your sidecar

Use \`manageTerminals\` to list, create, write to and read the workspace's terminals. Creating one and writing to one may need the person's approval. Multi-line text is pasted as one block and Enter is sent separately. A read that says \`dropped: true\` was cut at the scrollback cap. Terminals are for shells, builds and services; no agent runs in one.

Use \`runAgent\` with action \`sidecar\` to start \`<agent>-slave\`, your review partner. Calling it again rejoins the same one. Genie never stops it for you.
`,
    },
    {
        name: 'genie-knowledge',
        description: 'Use when reading or recording durable, workstation-wide knowledge in Genie.',
        body: `# Knowledge

Use \`knowledge\` to search the graph before you add a node. Keep nodes small and reusable, get a full node only when it is relevant, and connect related nodes with [[wikilinks]]. An ambiguous link resolves to nothing. The graph is workstation-wide; scope is a filter, not a security boundary.
`,
    },
];

/** Genie 1's skill folders with no Genie 2 meaning, by path under a skills folder. */
const RETIRED = ['genie-orientation', 'genie-handoff', 'genie-issuewatch', 'genie-workspaces', 'genie-gdw', 'genie/scripts'];

const SKILL_ROOTS = [{ dir: '.claude/skills', key: 'claude' }, { dir: '.agents/skills', key: 'agents' }];

function skillFile(s: GenieSkill): string {
    return `---\nname: ${s.name}\ndescription: ${s.description}\n---\n\n${s.body}`;
}

/** Every file under a folder, as paths relative to it. */
async function filesUnder(fs: SkillFs, dir: string, prefix = ''): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await fs.list(dir)) {
        const inner = await fs.list(`${dir}/${entry}`);
        if (inner.length === 0 && (await fs.read(`${dir}/${entry}`)) !== null) out.push(`${prefix}${entry}`);
        else out.push(...(await filesUnder(fs, `${dir}/${entry}`, `${prefix}${entry}/`)));
    }
    return out;
}

export async function writeAgentSkills(input: { workspacePath: string; fs: SkillFs; stamp: string }): Promise<void> {
    const { fs } = input;
    const at = (...parts: string[]) => [input.workspacePath, ...parts].join('/');
    for (const root of SKILL_ROOTS) {
        // Genie 1's skills with no Genie 2 meaning: backed up, then removed with their folders (deepest first).
        for (const retired of RETIRED) {
            const dir = at(root.dir, retired);
            const files = await filesUnder(fs, dir);
            if (files.length === 0) continue;
            for (const f of files) {
                const text = await fs.read(`${dir}/${f}`);
                if (text !== null) await fs.write(at('.agents', '_genie', 'backups', 'skills', root.key, `${retired}.${input.stamp}`, f), text);
                await fs.remove(`${dir}/${f}`);
            }
            const folders = [...new Set(files.flatMap((f) => f.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/'))))].sort((a, b) => b.length - a.length);
            for (const sub of folders) await fs.removeDir(`${dir}/${sub}`);
            await fs.removeDir(dir);
        }
        // Genie 2's own skills, replaced when they differ.
        for (const s of GENIE_SKILLS) {
            const path = at(root.dir, s.name, 'SKILL.md');
            const want = skillFile(s);
            if ((await fs.read(path)) !== want) await fs.write(path, want);
        }
    }
}

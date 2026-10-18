/**
 * THE PROTOCOL GENIE 2 WRITES INTO A WORKSPACE (`.agents/_genie/`), read by every harness through the AGENTS.md /
 * CLAUDE.md routers. It replaces Genie 1's text, which told an agent its plaintext goes unseen and to call tools Genie 2
 * does not have (`genieGuide`, `connectToGenie`). What it says has to be true for BOTH ways an agent runs in Genie 2: a
 * SESSION Genie started (its replies reach the person in the chat) and a TERMINAL agent in a Take Over window (Genie
 * does not read its terminal). The tool list is the one the MCP server actually registers, passed in — never typed here.
 */
export interface ProtocolTool {
    readonly name: string;
    readonly description: string;
}

const HEADER = '<!-- Written by Genie 2 and replaced on every sync. Put your own rules in RULES.md. -->';

export function sharedProtocol(tools: readonly ProtocolTool[]): string {
    // NAMES ONLY (the owner, 2026-10-18: no duplicate info in the system prompt chain): each tool's description already
    // reaches the agent through the MCP tool list; this file is read into every agent's instructions on top of it.
    const list = tools.length > 0
        ? `${tools.map((t) => `\`${t.name}\``).join(', ')}. Each describes itself in your tool list; read it there.`
        : '(Genie’s MCP server is not listening right now; no tools are listed.)';
    return `${HEADER}

## Genie 2

This file is written by Genie 2. You are one of several agents working for one person across their workspaces.

**How the person hears you depends on how you were started:**

- **Started by Genie as a session** (no terminal): your replies reach the person in Genie’s chat, rendered as Markdown. Your thinking and tool calls show in your Agent view. Just answer.
- **In a terminal** (a Take Over window; \`GENIE_TERMINAL_ID\` is set in your environment): Genie does not read your terminal. Reach the person with \`imDone\` when you finish and \`ForceTheQuestion\` when you need a decision.

**Genie’s MCP server (\`genie\`) comes with your session.** Its tools:

${list}

- When you finish a piece of work, call \`imDone\` with a handoff: what you did, what is unfinished, what the next run picks up.
- A decision only the person can make goes through \`ForceTheQuestion\` (it returns at once; the answer arrives in your inbox). Anything else, just say it.
- Reach another agent with \`agentinbox\`, never by editing its files.
- If the \`genie\` tools are missing, say so in your reply and carry on with what you can do.

Workspace rules are in \`RULES.md\`. Your own persona is \`.agents/<your name>/AGENT.md\`.
`;
}

const LABEL: Readonly<Record<string, string>> = { claude: 'Claude Code', codex: 'Codex' };

export function providerProtocol(provider: string): string {
    if (provider === 'claude') {
        return `${HEADER}

# Genie 2 for Claude Code

- As a session, each agent has a tool setting in its Agent view: **all tools** (the default; nothing waits), **ask before shell commands** (a shell command waits for the person's approval in the chat; wait for it, do not retry it while it waits — if it is denied, it did not run), or **edits only** (file edits go through; shell commands are refused). If you need the shell and it is refused, say so in your reply.
- In a terminal, Claude Code asks for approval in the terminal as usual.
`;
    }
    if (provider === 'codex') {
        return `${HEADER}

# Genie 2 for Codex

- As a session, an approval you request appears inline in the person’s chat, with each option you offer. Wait for the answer; do not repeat the request.
- In a terminal, Codex asks for approval in the terminal as usual.
`;
    }
    return `${HEADER}

# Genie 2 for ${LABEL[provider] ?? provider}

- Genie runs ${LABEL[provider] ?? provider} in a terminal (a Take Over window). Genie does not read the terminal: reach the person with \`imDone\` and \`ForceTheQuestion\`, passing your \`GENIE_TERMINAL_ID\`.
`;
}

/**
 * The Genie MCP server's self-served guide. ONE source of truth, consumed by:
 *   - the MCP `initialize` result's `instructions` field (MCP-native channel),
 *   - the `genieGuide` tool (so an agent can fetch it explicitly on demand),
 *   - the brief section auto-synced into a workspace's AGENTS.md, which points
 *     back here ("call genieGuide for full details").
 *
 * Keep the brief short — it lives in users' AGENTS.md files. Keep the full guide
 * actionable: what each tool does, when to use it, and the zero-setup contract.
 */

/** Full reference — served by the MCP itself (instructions + `genieGuide`). */
export const GENIE_MCP_GUIDE = `# Genie MCP

You are running inside **Genie** — a desktop UX for **agentic engineering**.
Genie hosts **many projects (workspaces) at once**, each with **multiple
terminals, editors, and background processes**, all in one window. You are very
likely **one of several agents**, each working in its own terminal across
different projects.

**What this means for you:** the user is almost never watching THIS terminal.
They're in another terminal, another project, or another app entirely. Output
you print here — "done", "which option?", "I need X to continue" — will sit
**unseen**, stalling your work. This \`genie\` MCP server is how you reach across
to the user. It's auto-wired for this workspace (a fixed local URL in
\`.mcp.json\`), so the tools work with zero setup.

**Targeting this exact terminal:** Genie sets \`GENIE_TERMINAL_ID\` in your
environment. Pass it as the \`terminalId\` argument to \`imDone\` /
\`ForceTheQuestion\` and Genie acts on precisely THIS terminal. If you omit it,
Genie falls back to the workspace's most-recently-active terminal — usually
still the right one, but passing \`GENIE_TERMINAL_ID\` is exact.

**Use these tools whenever you need the user's attention — don't just print and
wait.** Assume they can't see your terminal until you pull them to it.

## Tools

### initializeWorkspace
Call this **FIRST**, before doing any work, whenever you start in a fresh or
newly-converted Genie workspace. It returns a MAP of the workspace — the \`.agi\`
envelope, its \`.ai/knowledge\`, and (the main resource) every repo under
\`repos/\` with its path, GitHub owner/repo, and which orientation files exist
(README, AGENTS.md, CLAUDE.md, manifest) — plus a numbered plan for learning the
project. It doesn't read file contents; follow the plan with your own file
tools. The repos are the primary resource — learn them. Pass \`terminalId\`
(your \`GENIE_TERMINAL_ID\`) for exact resolution; optional.

### imDone
Call this the moment you **finish your work / hand back to the user** in THIS
terminal. Genie pulses the terminal's glow in the workspace rail, the flyout row,
and the panel border until the user focuses it — so they're drawn to the terminal
that needs them even from another project. Pass \`terminalId\` (your
\`GENIE_TERMINAL_ID\`) to target this exact terminal; omit it to use the
workspace's most-recently-active one. Prefer this over silently ending: a
finished task the user never notices isn't really done.

### ForceTheQuestion
Call this whenever you are **blocked on a decision, clarification, or approval
only the user can give**. It raises an OS-level, always-on-top modal that floats
above EVERY window (not just Genie), so the user sees it even if they're heads-
down in another app — then it blocks until they answer. Far better than printing
a question into a terminal they aren't looking at.

- Optionally pass \`terminalId\` (your \`GENIE_TERMINAL_ID\`) so the modal is
  attributed to this terminal.
- Pass a \`questions\` array (1–4). Each question has a \`header\` (short chip), a
  \`question\` string, 2–4 \`options\` ({ label, description? }), and optional
  \`multiSelect\`.
- Every question ALSO gets a free-text note field in the UI automatically.
- **Batch ALL your open questions into a single call** — never fire it repeatedly
  in a row; gather everything you need and ask once.
- Returns each question's selected option(s) + note, or a cancellation.

## Rule of thumb
If you would otherwise stop and wait for the user — **finished**, **blocked**, or
**need a decision** — reach for these tools first. In a multi-terminal,
multi-project workspace, an agent that waits silently is an agent that's stuck.

## Notes
- The server is reached at a fixed local URL written into this workspace's
  \`.mcp.json\`. Pass \`GENIE_TERMINAL_ID\` as \`terminalId\` for exact targeting.
- More tools may appear over time, some contextual to the project type. Re-read this
  guide (or \`tools/list\`) if you need the current set.
`;

/** Brief body synced into a workspace's AGENTS.md (points back to the full guide). */
export const GENIE_AGENTS_BRIEF = `This workspace runs inside **Genie** — a desktop UX for agentic engineering that hosts many projects at once, each with multiple terminals/editors/processes. You are likely **one of several agents in different terminals**, and **the user is probably NOT watching this terminal**. A local \`genie\` MCP server (a fixed URL in this workspace's \`.mcp.json\`) lets you pull their attention:

- **\`initializeWorkspace\`** — call this **FIRST** in a fresh/converted workspace; it returns a map of the envelope + every repo (paths, GitHub refs, which README/AGENTS/CLAUDE/manifest exist) and a plan for learning them. The repos are the primary resource.
- **\`imDone\`** — call when you **finish / hand back**; Genie glows this terminal across the whole UI until the user looks. Pass \`terminalId\` (your \`GENIE_TERMINAL_ID\`) for exact targeting; optional.
- **\`ForceTheQuestion\`** — call when **blocked or needing a decision**; pops an OS-level, always-on-top modal (above every app) with your question(s) (options + a free-text note) and blocks for the answer. Batch all questions into one call.

**Don't just print "done" or a question and wait** — the user won't see it. Use these tools whenever you'd otherwise stop and wait. For full usage call the **\`genieGuide\`** tool (or read the server's instructions).`;

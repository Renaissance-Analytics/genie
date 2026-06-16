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

You are running in a terminal hosted by **Genie** (a desktop workspace manager).
This \`genie\` MCP server lets you drive the Genie UI. Your endpoint is auto-wired
per-terminal via the \`GENIE_MCP_URL\` env var, so the tools below resolve *this*
terminal with no setup on your part.

## Tools

### imDone
Signal that you have finished your work in THIS terminal. Genie pulses the
terminal's glow in the workspace rail, the flyout row, and the panel border until
the user focuses it. Takes no arguments — the terminal is resolved from the
connection. Call it when you've completed a task and want to hand back to the user.

### ForceTheQuestion
Raise an OS-level, always-on-top modal (it floats above every window, not just
Genie) to ask the user one or more questions, and block until they answer. Use it
when you're blocked on a decision only the user can make.

- Pass a \`questions\` array (1–4). Each question has a \`header\` (short chip), a
  \`question\` string, 2–4 \`options\` ({ label, description? }), and optional
  \`multiSelect\`.
- Every question ALSO gets a free-text note field in the UI automatically.
- **Batch all your open questions into a single call** — there's no reason to call
  this repeatedly in a row.
- Returns each question's selected option(s) + note, or a cancellation.

## Notes
- These tools only work from inside a Genie terminal (where \`GENIE_MCP_URL\` is set).
- More tools may appear over time, some contextual to the project type. Re-read this
  guide (or \`tools/list\`) if you need the current set.
`;

/** Brief body synced into a workspace's AGENTS.md (points back to the full guide). */
export const GENIE_AGENTS_BRIEF = `This workspace runs inside **Genie**. A local \`genie\` MCP server is auto-wired into every Genie terminal (via \`GENIE_MCP_URL\`), giving agents tools to drive the Genie UI:

- **\`imDone\`** — signal you've finished in this terminal; Genie glows it until the user looks. No args.
- **\`ForceTheQuestion\`** — pop an OS-level, always-on-top modal to ask the user question(s) (each with options + a free-text note) and block for the answer. Batch all questions into one call.

For full usage, call the **\`genieGuide\`** tool on the \`genie\` MCP server (or read the server's instructions). More tools may appear contextually per project type.`;

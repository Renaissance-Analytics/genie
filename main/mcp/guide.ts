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

## Orientation prompt (user-run, not a tool)

**\`initializeWorkspace\`** is an MCP **prompt** the USER runs from their client's
prompt / slash-command UI on first boot of a fresh or newly-converted Genie
workspace — you do NOT call it yourself. When the user runs it, it hands you a
MAP of the workspace — the \`.agi\` envelope, its \`.ai/knowledge\`, and (the main
resource) every repo under \`repos/\` with its path, GitHub owner/repo, and which
orientation files exist (README, AGENTS.md, CLAUDE.md, manifest) — plus a
numbered plan for learning the project. Follow that plan with your own file
tools; the repos are the primary resource.

## Tools

### manageProcess
Set up and control this workspace's **background processes** — Genie's Processes
feature: long-running dev servers, queue workers, SSR, etc., supervised with
status + crash auto-restart. Use it whenever your work needs a service running.
Actions (\`action\` arg):
- \`list\` — the workspace's processes + their status (use this to get ids).
- \`create\` — register a new process. Needs \`label\` + \`command\`; optional
  \`repo\` to run inside \`repos/<repo>\` (else the workspace root); optional
  \`autostart\` to start it now and on every launch.
- \`start\` / \`stop\` / \`restart\` — by \`processId\` (from a \`list\`).
Returns the resulting process list. Pass \`terminalId\` (your
\`GENIE_TERMINAL_ID\`) for exact workspace resolution; optional.

### provisionWorkspaces
**Only for an Ops project's workspace.** An Ops project governs other (child)
projects, each with its own \`*.agi\` envelope repo. This tool stands up a local
Genie workspace for any governed child that doesn't have one yet. Actions
(\`action\` arg):
- \`status\` — read-only: every governed child + whether it's \`present\` (a local
  workspace exists) or \`missing\` (none yet), plus the \`*.agi\` URL that would be
  cloned for each missing one.
- \`provision\` — clone + register a workspace for every missing child, then
  surface it in Genie's rail. Provision-only — never removes anything.
Approval honours the \`ops_auto_provision_workspaces\` setting: OFF (default)
blocks \`provision\` on your approval modal; ON provisions directly. Called from a
non-Ops workspace it returns a clear "not an ops project" message. Pass
\`terminalId\` (your \`GENIE_TERMINAL_ID\`) for exact workspace resolution; optional.

### manageTerminals
**Spawn and drive real shell TERMINALS** — in your own workspace, or (for an Ops
agent) a workspace you govern. This EXECUTES ARBITRARY CODE. Actions (\`action\`):
- \`create\` — open a terminal (optional \`repo\` (repos/<repo>) or \`cwd\`, optional
  \`label\`); returns its id + initial output.
- \`write\` — send \`data\` to terminal \`id\`. By DEFAULT it is SUBMITTED (an Enter
  is appended). Pass \`submit: false\` to type without running. Multi-line \`data\`
  is wrapped in bracketed paste with the Enter delivered separately, so it
  submits cleanly even to a TUI. Or pass \`key\` (\`enter\` | \`escape\` | \`ctrl-c\`)
  to deliver a bare keypress on its own — e.g. a lone \`enter\` to submit or clear
  a stuck buffer.
- \`read\` — recent output of \`id\`: pass a \`cursor\` from a prior read for just
  what's new, or \`bytes\` for the last N bytes; add \`strip: true\` for readable
  plain text with ANSI/escape codes removed. (Output comes from a bounded
  buffer; a read after lots of output may report \`dropped: true\`.)
- \`list\` — the workspace's terminals. \`kill\` — terminate \`id\`.
Target a governed workspace with \`workspaceId\`; omit it for your own.
**Approval:** \`create\` and \`write\` are GATED — when the target workspace
requires approval (the default) each blocks on an OS modal until the user
approves; when the user turned approval OFF they run immediately. \`read\` /
\`list\` never prompt.

### runAgent
**Launch and control a coding agent** (claude / codex / a custom CLI) inside a
terminal — your own workspace or one you govern. A thin layer over
manageTerminals; it SPAWNS AN AUTONOMOUS AGENT. Actions (\`action\`):
- \`start\` — open a terminal + launch the agent. \`agent\` is \`claude\` | \`codex\`
  | \`custom\` (default \`claude\`); the real CLI is configurable in Genie Settings,
  or pass an explicit \`command\` (required for \`custom\` unless one is configured).
  Optional \`repo\`/\`cwd\`. Returns the agent terminal's \`id\` + the launched command.
- \`send\` — deliver a \`prompt\` to the running agent \`id\`. SUBMITTED by default,
  even multi-line: the prompt is wrapped in bracketed paste and the Enter is
  delivered separately (outside the paste) so the agent's TUI submits it instead
  of leaving it parked as a "[Pasted text +N lines]" buffer. Pass \`submit: false\`
  to load the prompt without sending, or \`key\` (\`enter\` | \`escape\` | \`ctrl-c\`)
  to deliver a bare keypress — e.g. a lone \`enter\` to submit or clear a stuck
  multi-line buffer.
- \`read\` — its output (\`cursor\` for new, or \`bytes\` for the last N; add
  \`strip: true\` for plain text with escape codes removed).
- \`stop\` — terminate the agent \`id\`.
**Approval:** \`start\` and \`send\` are GATED the same way (OFF runs immediately);
\`read\` never prompts.

### manageWorkspaces
**Manage the Genie workspaces you can act on** — your own + (for an Ops agent)
the ones you govern. Actions (\`action\`): \`list\`/\`status\` (read-only — each
workspace's id, name, path, and whether it's yours or a governed child);
\`open\` / \`activate\` (focus / surface a workspace); \`remove\` (UNREGISTER a
workspace from Genie — never deletes anything on disk). Targets are limited to
your own or a governed workspace. To CREATE missing child workspaces, use
\`provisionWorkspaces\`.

### checkIssues
Get a detailed, grouped list of the open GitHub **Issues, Pull Requests, and
SECURITY ALERTS** (Dependabot + Code-scanning + Secret-scanning) that Genie's
IssueWatch tracks for THIS terminal's workspace — across every repo in it. Each
item shows its repo, number, title, severity (for security alerts), an unread
flag, and URL, grouped by kind so it's easy to scan. Read-only. Use it to see
what needs attention (e.g. before you finish). Pass \`terminalId\` (your
\`GENIE_TERMINAL_ID\`) for exact workspace resolution; omit to use the
most-recently-active terminal. It explains clearly when GitHub isn't connected,
the terminal maps to no workspace, or nothing is open. (The same per-bucket
counts are also appended to every \`imDone\` response — see below.)

### imDone
Call this the moment you **finish your work / hand back to the user** in THIS
terminal. Genie pulses the terminal's glow in the workspace rail, the flyout row,
and the panel border until the user focuses it — so they're drawn to the terminal
that needs them even from another project. Pass \`terminalId\` (your
\`GENIE_TERMINAL_ID\`) to target this exact terminal; omit it to use the
workspace's most-recently-active one. Prefer this over silently ending: a
finished task the user never notices isn't really done. **Better yet, automate
it** — see "Automate imDone" below to fire this on every finish via a harness
hook. The response also reports your workspace's open IssueWatch counts (e.g.
\`IssueWatch — issues:3, PR:1, sec:3\`, where \`sec\` is the security-alert
aggregate), so you see what's still open the moment you hand back; call
\`checkIssues\` for the full list.

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

## Automate imDone — set up a "finished" hook (recommended)
Calling \`imDone\` by hand is easy to forget. If your harness can run a command
when a run/turn finishes, wire it up ONCE so the glow fires automatically every
time you hand back — then you never leave a finished terminal sitting unseen.
**Set this up yourself in YOUR harness's own config; Genie deliberately does NOT
edit your harness files.** Do it only if such a hook feature exists in your
harness — if you're unsure whether it's supported, skip it rather than guess.

The hook just needs to POST a JSON-RPC \`tools/call\` for \`imDone\` to this
server. The endpoint + this terminal's id are in your environment as
\`GENIE_MCP_URL\` and \`GENIE_TERMINAL_ID\`, so a one-line curl works:

\`\`\`bash
curl -s -X POST "$GENIE_MCP_URL" -H 'Content-Type: application/json' \\
  -d "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":1,\\"method\\":\\"tools/call\\",\\"params\\":{\\"name\\":\\"imDone\\",\\"arguments\\":{\\"terminalId\\":\\"$GENIE_TERMINAL_ID\\"}}}" >/dev/null 2>&1 || true
\`\`\`

- **Claude Code:** add a \`Stop\` hook (fires when you finish responding) in the
  project's \`.claude/settings.json\` (or \`.claude/settings.local.json\` to keep it
  local/uncommitted) under \`"hooks" → "Stop" → [{ "type": "command", "command":
  "<the curl above>" }]\`. The hook inherits this terminal's environment, so
  \`$GENIE_MCP_URL\` / \`$GENIE_TERMINAL_ID\` resolve. Exit 0 (don't block) so you
  never loop. (\`SubagentStop\` is the equivalent for sub-agents.)
- **Codex:** set \`notify\` in \`~/.codex/config.toml\` to a small script that does
  the same POST on the \`agent-turn-complete\` event.
- **Other harnesses:** use whatever "on finish / on stop" hook they expose; the
  payload is the same JSON-RPC call.

Confirm with the user before writing into a shared/committed config; a
local-only hook file is fine to add on your own. This complements — doesn't
replace — calling \`imDone\` explicitly when you finish.

## Rule of thumb
If you would otherwise stop and wait for the user — **finished**, **blocked**, or
**need a decision** — reach for these tools first. In a multi-terminal,
multi-project workspace, an agent that waits silently is an agent that's stuck.

## Notes
- The server is reached at a fixed local URL written into this workspace's
  \`.mcp.json\`. Pass \`GENIE_TERMINAL_ID\` as \`terminalId\` for exact targeting.
- \`initializeWorkspace\` is an MCP **prompt** (\`prompts/list\` / \`prompts/get\`),
  user-run — not in \`tools/list\`.
- More tools may appear over time, some contextual to the project type. Re-read this
  guide (or \`tools/list\`) if you need the current set.
`;

/** Brief body synced into a workspace's AGENTS.md (points back to the full guide). */
export const GENIE_AGENTS_BRIEF = `This workspace runs inside **Genie** — a desktop UX for agentic engineering that hosts many projects at once, each with multiple terminals/editors/processes. You are **one of several agents in different terminals**, and **the user is NOT watching this terminal.** Anything you print here — "done", a question, "I'm blocked" — goes **UNSEEN** and silently stalls the work. The local \`genie\` MCP server (a fixed URL in this workspace's \`.mcp.json\`) is your ONLY way to reach the user. Use it:

- **\`imDone\`** — **ALWAYS call \`imDone\` the moment you finish or hand back.** Genie glows this terminal across the whole UI until the user looks. Pass \`terminalId\` (your \`GENIE_TERMINAL_ID\`) for exact targeting.
- **\`ForceTheQuestion\`** — when you need a decision or are blocked, you **MUST call \`ForceTheQuestion\`** — do NOT ask in plaintext and wait. It pops an OS-level, always-on-top modal (above every app) with your question(s) (options + a free-text note) and blocks for the answer. Batch all questions into one call.
- **\`manageProcess\`** — the way to set up and control this workspace's background processes (dev servers, workers, SSR) — \`list\` / \`create\` (label + command, optional repo + autostart) / \`start\` / \`stop\` / \`restart\`.
- **\`manageTerminals\`** / **\`runAgent\`** — spawn + drive real terminals (run commands, read output) and launch + control coding agents (claude / codex / custom) — in this workspace or one this Ops project governs. High-power (arbitrary code + autonomous agents): \`create\`/\`write\`/agent \`start\`/\`send\` are approval-gated by default. **\`manageWorkspaces\`** lists/opens/activates/removes the workspaces you can act on.

**Automate \`imDone\`:** if your harness supports an on-finish hook (Claude Code's \`Stop\` hook in \`.claude/settings.json\`; Codex's \`notify\`), wire it ONCE to POST a \`tools/call\` for \`imDone\` to \`$GENIE_MCP_URL\` (passing \`$GENIE_TERMINAL_ID\`) so the glow fires automatically every finish. Set this up in YOUR harness config yourself — Genie won't touch it. Call \`genieGuide\` for the exact hook snippet.

**Never just print "done" or a question and wait — the user won't see it.** Reach for these tools every time you'd otherwise stop and wait. For full usage call the **\`genieGuide\`** tool (or read the server's instructions).`;

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
  workspace exists) or \`missing\` (none yet), the \`*.agi\` URL for each missing
  one, and \`remote\` — whether that repo actually EXISTS on GitHub: \`exists\`
  (clonable), \`not-found\` (the envelope was never published — use \`scaffold\`),
  \`auth-required\` (this Genie's git credentials can't reach it).
- \`provision\` — clone + register a workspace for every missing child whose
  envelope exists, then surface it in Genie's rail. Provision-only — never
  removes anything.
- \`scaffold\` — for each \`remote:'not-found'\` child that has a registered
  SOURCE repo: build its \`<slug>.agi\` envelope locally around that repo,
  CREATE the GitHub repo, push, and register the workspace. ALWAYS blocks on
  the user's approval (it creates repos), regardless of the toggle.
\`provision\` approval honours the \`ops_auto_provision_workspaces\` setting: OFF
(default) blocks on your approval modal; ON provisions directly. Called from a
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
- \`restart\` — GRACEFULLY relaunch the agent \`id\`: it resumes the SAME
  conversation (via \`--resume\`) in a fresh terminal, so its TUI reconnects to the
  current MCP rig / \`.mcp.json\` after a genie update WITHOUT losing context.
  claude-only, needs a captured session. Returns the NEW terminal \`id\`.
**Approval:** \`start\`, \`send\`, and \`restart\` are GATED the same way (OFF runs
immediately); \`read\` never prompts.

### manageWorkspaces
**Manage the Genie workspaces you can act on** — your own + (for an Ops agent)
the ones you govern. Actions (\`action\`): \`list\`/\`status\` (read-only — each
workspace's id, name, path, and whether it's yours or a governed child);
\`open\` / \`activate\` (focus / surface a workspace); \`remove\` (UNREGISTER a
workspace from Genie — never deletes anything on disk). Targets are limited to
your own or a governed workspace. To CREATE missing child workspaces, use
\`provisionWorkspaces\`.

### whisper
**Coordinate with the OTHER AI agents in this Genie** — WhisperChat, a LOCAL
inter-agent messaging network. Discover peer agents, DM them 1:1, and broadcast
on shared CHANNELS. Delivery is **PULL-based** — you POLL for messages; nothing is
ever injected into your terminal (that would corrupt your turn). Actions (\`action\`):
- \`list\` — discovery: your own agent info (\`self\`), the peers you can reach
  (\`agents\`, filtered by their accessibility scope), and your \`channels\`.
- \`send\` — DM a peer with \`to\` = their \`agentId\`, OR broadcast with \`channel\` =
  a purpose (\`frontend\` → your workspace's room) or \`slug:purpose\` (another
  workspace's). Needs \`text\`. Optional \`interrupt: true\` also glows a DM target's
  terminal so they notice (never injected into their pty).
- \`receive\` — fetch NEW messages: pass a \`cursor\` from a prior receive to page
  forward; set \`wait: true\` to LONG-POLL (optional \`timeoutMs\`) — it blocks until
  a message arrives, you leave, or the timeout, so you can wait for a peer's reply
  without busy-looping.
- \`setAccessibility\` — \`scope\`: \`none\` (hidden) / \`self\` (your workspace only,
  the default) / \`specific\` + \`workspaces\` (a chosen set — limited to workspaces
  you govern) / \`all\` (the whole workstation) — governs who can see + DM you.
  Optional \`purpose\` renames your channel.
- \`join\` / \`leave\` — opt in/out of a \`channel\`.
Your identity + accessibility persist across restarts. Local-only — no relay, no
cross-host. Use it to hand a peer context, ask another agent to take a task, or
watch a shared channel while you work.

### knowledge
**Genie's workstation KNOWLEDGE GRAPH** — a workstation-wide, LOCAL knowledge/
memory store shared across EVERY workspace on this Genie (one store, not
per-workspace). Stash durable, reusable context as small markdown "memory" nodes
and retrieve it on demand — so shared, system-wide knowledge lives here instead
of bloating every workspace's AGENTS.md/CLAUDE.md. Nodes cross-link with
\`[[wikilink]]\` references in their body; each link is a graph edge. Actions
(\`action\`):
- \`search\` — keyword retrieval (needs \`query\`; optional \`limit\`, and \`tags\` to
  restrict to nodes carrying ALL those tags). Returns ranked \`{ id, title,
  snippet, score, tags }\` hits. **Search FIRST** to see what's already known.
- \`get\` — a node by \`id\` (full body + its linked node ids).
- \`add\` — create a node: \`title\` (required), optional markdown \`body\` (put
  \`[[wikilink]]\`s to related nodes in it), optional \`tags\`, optional explicit
  \`links\` (ids/titles/slugs). Returns the new \`id\`.
- \`list\` — recent nodes (optional \`tag\`, \`limit\`).
- \`link\` — add an edge from node \`from\` to \`to\` (an id, title, or slug).
Keyword search is always available (no API key, no setup). Prefer searching
before adding a duplicate, and cross-link related memories with \`[[wikilink]]\`s
so the graph stays connected.

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

### openFileForUser
**Put a file in front of the user** in Genie's built-in editor (a Code panel on
the Floor) — instead of only describing a change or result, surface the actual
file. It REUSES an editor panel already open for this workspace (adds the file as
a tab and focuses it; just focuses the tab if it's already open), or opens a NEW
panel when none is open. Args: \`path\` (workspace-relative — preferred — or
absolute; System-workspace agents pass an absolute/system path), optional \`line\`
(1-based) to reveal, and the usual \`terminalId\` (your \`GENIE_TERMINAL_ID\`) for
exact workspace resolution (omit → most-recently-active terminal). Benign DISPLAY
action — like \`imDone\` it just surfaces something, so there's NO approval prompt.
Returns whether it reused an existing panel or opened a new one + the resolved
file. Available to System-workspace agents too.

### setEnv
**Record a KEY=value in the workspace's \`.env\`** (or a repo's). Args: \`key\`
(A–Z/0–9/_), \`value\`, optional \`target\` (omit / \`workspace\` → the workspace
root \`.env\`; a REPO NAME → \`repos/<name>/.env\`), and the usual \`terminalId\`.
PRESERVES other lines + comments and CREATES the gitignored \`.env\` if absent.
\`.env\` is gitignored, so this never commits a secret — and Genie LOADS the
workspace \`.env\` into the agent's terminal, so a value you set here is resolvable
as \`\${KEY}\` (e.g. a \`\${DATABASE_URL}\` your app or an MCP entry reads). No
approval prompt — an agent manages its own workspace env. Returns which \`.env\`
was written. Available to System-workspace agents too.

### checkEnv
**Check a key in the workspace's \`.env\`** (or a repo's, via \`target\`). By DEFAULT
a PRESENCE check: returns \`exists\` and does NOT reveal the value — use it to
decide whether you still need to \`setEnv\` something. Pass \`value:true\` to return
the value, BUT a value detected as a SECRET (key name like \*TOKEN/\*SECRET/
\*PASSWORD/\*PASS/\*PWD/\*KEY/\*API_KEY, or a token-shaped value) comes back
OBFUSCATED to its last 4 chars (\`••••••3f2a\`) unless you pass \`force:true\`.
Non-secret values return in full. Only \`force\` a secret when you truly need the
literal. Available to System-workspace agents too.

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
- **VERNACULAR (who-does-what):** the modal is read by the USER, so first-person
  pronouns INVERT and confuse. By convention the **agent is \`I\`/\`the agent\`** and
  the **user is \`you\`/\`the owner\`**; when an option is about WHO performs an action,
  **name the actor at the front** — \`Agent: I create the repo\` vs \`You: you create
  the repo\` — never a bare "I create it" (the user reads it as *themselves*).

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

## tynn-cli toolkit — already on your PATH
Genie bundles a small bash dev toolkit and puts it on your PATH — in Genie
terminals AND system-wide once installed (bash via \`~/.bashrc\`; cmd + PowerShell
on Windows via generated \`.cmd\` shims on the User PATH). **Run these commands
DIRECTLY in your current shell. NEVER open a new terminal — and never request
approval to spawn one — just to run one.** They're workspace-aware: Genie injects
\`GENIE_WORKSPACE\`, \`GENIE_REPO\`, \`GENIE_ENVELOPE_ROOT\`, and \`GENIE_CLI_HOME\` so a
command knows which project/repo it's acting on.

- \`resetme\` — reset the detected stack's DB/state (Laravel \`migrate:fresh\` or the
  stack's equivalent). Flags: \`--seed\`, \`--demo\`, \`--dry-run\`, \`--stack\`.
- \`reload\` — clear the detected stack's caches and rebuild its assets, scoped to
  the current dir (Laravel \`optimize:clear\` + \`<pm> run build\`; Node \`<pm> run build\`).
  Flags: \`--dry-run\`, \`--stack\`.
- \`puse <tool>\` — install/configure a dev tool for the detected stack
  (e.g. \`puse pest\`, \`puse vitest\`, \`puse playwright\`, \`puse pest --browser\`).
  \`puse --list\` / \`puse --stack\` to inspect.
- \`sandbox <cmd>\` — run a command inside the sandbox project dir configured in
  \`tynn.config\` (\`SANDBOX_PATH\`); bare \`sandbox\` prints the path + stack.
- \`pkg <pkg> <cmd>\` — run a command in a monorepo \`packages/<pkg>\` dir
  (auto-detects when there's a single package).
- \`npmx <dir> <cmd>\` — run an npm command in a subdirectory that has its own
  \`package.json\`.
- \`copy-screenshots <file:folder> …\` — copy browser-extension screenshots into
  project folders (default target \`public/screenshots\`).
- \`genie <status|kill <id>|host …>\` — control THIS Genie's terminal host from
  inside a terminal (list/kill terminals, restart the pty-host).
- \`tynn\` — the toolkit's own help; \`tynn stacks\` lists supported stacks,
  \`tynn docs\` opens the README.

Supported stacks auto-detect: Laravel, Node (Prisma / Drizzle / Knex / Sequelize
/ TypeORM), Django, Flask+Alembic, Go+Migrate. (\`resetme --seed\` is the standard
reset-and-seed for the local dev DB.)

## Local dev sites over .gen
Genie can serve a HOST's local dev site to a remote Genie through a built-in
Testing Browser at \`https://<name>.gen\`. The \`.gen\` proxy serves exactly **one
origin**, so a page opened there must reference **all** of its assets, scripts,
styles and API calls **same-origin (relative URLs)** — NOT an absolute origin
like its real \`.test\` vhost or a separate Vite dev-server port. Anything pinned to
another origin isn't covered by the \`.gen\` proxy, so it fails to load (blank
styles, dead scripts, CORS/HMR errors).

**Rule:** within a \`.gen\`-served page, every URL must be relative or resolve to
the same \`.gen\` origin — never a hardcoded absolute host/port. Concrete but
generic guidance:

- **Laravel:** keep \`asset()\` / \`url()\` producing relative or same-host URLs —
  don't pin \`APP_URL\` (or \`ASSET_URL\`) to \`https://app.test\` for dev; leave them
  unset/relative so links follow the request host.
- **Vite dev server:** either set \`server.origin\` to the \`.gen\` URL (so the asset
  + HMR URLs Vite injects point at the proxied origin) OR run \`vite build\` and
  serve the built assets statically instead of the dev server.
- **SPA build:** use \`base: '/'\` (root-relative) so bundled asset paths aren't
  tied to a dev host/port.

This is **DEV-only** config: guard it behind a dev/env check and NEVER commit an
absolute \`.gen\` origin into production config — it must not affect prod CI or
deploys.

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
export const GENIE_AGENTS_BRIEF = `You are running inside **Genie** — a desktop UX that hosts many projects at once, each with its own terminals, editors, and background processes. You are **one of several agents in different terminals, and the user is NOT watching this one.** Anything you print here — "done", a question, "I'm blocked" — goes **UNSEEN** and silently stalls the work. The local \`genie\` MCP server (a fixed URL in this workspace's \`.mcp.json\`) is your ONLY channel to the user. This protocol is **which tool to use, WHEN to reach for it, and HOW** — follow it:

- **Finished, or handing back? → \`imDone\` — ALWAYS, every time.** The instant you stop (done, blocked-and-waiting, or handing off), call it — otherwise your result sits unseen and the work stalls. Genie glows this terminal across the whole UI until the user looks. HOW: pass \`terminalId\` = your \`GENIE_TERMINAL_ID\` for exact targeting (omit it and Genie falls back to the last-active terminal). NEVER end a turn by just printing "done".
- **Need a decision, or blocked? → \`ForceTheQuestion\` — NEVER ask in plaintext and wait.** A plaintext question is invisible to the user; you'll hang forever. HOW: ONE call with 1–4 questions, each offering 2–4 options plus an always-available free-text note — **batch every open question together.** It pops an OS-level, always-on-top modal (above every app) and blocks until answered. Pass your \`terminalId\`.
  - **WRITE the question as MARKDOWN, structured.** The modal renders markdown: a short lead sentence, then blank-line paragraphs / bullet lists / **bold** for the key facts. Never one run-on paragraph.
  - **NAME THE ACTOR in every option.** The modal is read by the USER, so bare "I"/"you" invert and confuse. Convention: the agent = "Agent:"/"the agent", the user = "You:"/"you" — lead each option label with the actor (e.g. \`Agent: I create the repo and push\` vs \`You: you create the repo\`).
- **Need a long-running background process (dev server, worker, SSR)? → \`manageProcess\`.** Don't \`&\`-background it in a terminal — Genie's Processes feature owns these so they survive and stay controllable. HOW: \`list\` / \`create\` (label + command, optional repo + autostart) / \`start\` / \`stop\` / \`restart\`.
- **Need to run commands, read terminal output, or launch/drive another coding agent? → \`manageTerminals\` / \`runAgent\`.** \`manageTerminals\` spawns + drives real terminals (\`create\` / \`write\` / \`read\` / \`list\` / \`kill\`); \`runAgent\` launches + steers a coding agent (claude / codex / custom) — here or in a workspace this Ops project governs. These are **HIGH-POWER** (arbitrary code + autonomous agents): \`create\` / \`write\` / agent \`start\` / \`send\` are approval-gated by default. Use \`manageWorkspaces\` to list / open / activate / remove the workspaces you can act on.
- **Dev CLI tools (\`resetme\` / \`puse\` / \`sandbox\` / …) are ALREADY on your PATH** — in Genie terminals and system-wide (bash + PowerShell/cmd). Run them DIRECTLY in your current shell; NEVER open a new terminal or request approval just to run one. Call \`genieGuide\` for the full list.

**Automate \`imDone\`:** if your harness has an on-finish hook (Claude Code's \`Stop\` hook in \`.claude/settings.json\`; Codex's \`notify\`), wire it ONCE to POST a \`tools/call\` for \`imDone\` to \`$GENIE_MCP_URL\` (passing \`$GENIE_TERMINAL_ID\`) so the glow fires on every finish automatically. Configure this in YOUR harness yourself — Genie won't. Call \`genieGuide\` for the exact snippet.

**Engineering standard — NO BANDAIDS, EVER.** Fix the ROOT CAUSE, never paper over a symptom. Don't mask a vulnerable transitive dependency with an overrides pin when the real fix is updating the dependency that pulls it; don't swallow an error, hardcode around a bug, or weaken a test to make something pass. A bandaid is just a hidden bug — it WILL resurface. The moment a Dependabot / security alert (the sec count from checkIssues / imDone) shows up and no other work is in progress, fix it properly and ship it right away.

**The rule:** any time you'd otherwise stop, print, and wait — reach for the matching tool above instead. For full usage, call \`genieGuide\`.`;

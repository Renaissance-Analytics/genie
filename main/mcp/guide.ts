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
Genie can only infer it when the workspace has a SINGLE terminal — usually
still the right one, but passing \`GENIE_TERMINAL_ID\` is exact.

**Use these tools whenever you need the user's attention — don't just print and
wait.** Assume they can't see your terminal until you pull them to it.

## Orientation prompt (user-run, not a tool)

**\`initializeWorkspace\`** is both an agent-callable MCP tool and an MCP prompt.
Call the tool on first boot of a fresh or newly-converted Genie workspace.
Clients with prompt/slash-command UIs may invoke the prompt instead. It hands
you a MAP of the workspace — the \`.agi\` envelope, its \`.ai/knowledge\`, and
(the main resource) every repo under \`repos/\` with its path, GitHub owner/repo,
and which orientation files exist (README, AGENTS.md, CLAUDE.md, manifest) —
plus a numbered plan for learning the project. Follow that plan with your own
file tools; the repos are the primary resource.

The map also reports AgentInbox identity/session binding, Codex SessionStart
hook presence, hook-trust visibility, and the focused Genie skills installed in
the workspace.

## Focused Genie skills

Genie automatically syncs a small routing skill plus focused skills for
\`genie-orientation\`, \`genie-attention\`, \`genie-agentinbox\`,
\`genie-terminals\`, \`genie-workspaces\`, \`genie-knowledge\`, and
\`genie-issuewatch\`. Load the focused skill for the capability in use; call
\`genieGuide\` when the complete protocol is needed.

## Tools

### manageProcess
Set up and control this workspace's **background processes AND scheduled tasks**
— Genie's Processes feature. A **process** is a long-running service (dev server,
queue worker, SSR) supervised with status + crash auto-restart. A **scheduled
task** is the same registration with a \`schedule\` (a 5-field cron expression):
it runs one-shot on that cadence instead of staying up, lives on the Host so it
fires whether or not anyone has Genie open, and survives restarts. Actions
(\`action\` arg):
- \`list\` — every process + scheduled task with status (scheduled rows also
  carry \`schedule\`, \`nextRunAt\`, \`lastRunAt\`, \`lastRunStatus\`).
- \`create\` — register one. Needs \`label\`, plus \`command\` for a process;
  optional \`repo\` to run inside \`repos/<repo>\` (else the workspace root);
  optional \`autostart\` to start it now and on every launch. Add a \`schedule\`
  (cron: \`min hour day month weekday\`, e.g. \`0 3 * * *\` = daily 03:00) to make
  it a scheduled task; set \`scheduleKind: 'agent-nudge'\` (with \`prompt\` +
  \`nudgeTerminalId\`/\`nudgeAgentId\`) to deliver a prompt to an agent through
  AgentInbox on each fire instead of running a command.
- \`start\` / \`stop\` / \`restart\` — a service, by \`id\` (from a \`list\`).
- \`enable\` / \`disable\` — suspend/resume a task without deleting it.
- \`delete\`; \`run-now\` — fire a scheduled task immediately without disturbing
  its cadence.
**WHERE THEY RUN:** on the **HOST machine** (a headless terminal), NOT inside a
workspace container — so a process's \`localhost\` is the HOST. A **host-native**
\`manageSite\` site (the default) runs on the host too, so it reaches a process on
plain \`127.0.0.1:<port>\`. Only a container-recipe \`manageSite\` site is off that
network — from there, reach a host process at \`\${GENIE_HOST_GATEWAY}:<port>\`
(see \`manageSite\`), never \`127.0.0.1\`.
Creating a scheduled task is approval-gated (the modal shows the command and its
recurrence). This is for supervised COMMANDS — to HOST a repo as a real site,
reach for \`manageSite\` (below), not a hand-rolled \`manageProcess\` dev server.
Returns the resulting process list. Pass \`terminalId\` (your \`GENIE_TERMINAL_ID\`)
for exact workspace resolution; optional.

### manageSite
**Host a repo the way you DEVELOP it** — Genie's Hosting Manager. The DEFAULT is
**host-native** (story #238): Genie runs the repo's OWN dev server as a HOST
process against the LIVE source — **no container, no build** — and serves it at a
stable \`https://<name>.gen\` origin reachable whether the viewer is on this
machine or connected remotely. "Just serve the repo the site points to", the way
Herd did. A bare \`create {name}\` DETECTS the stack and runs its own dev server:
PHP/Laravel → \`php artisan serve\`; Node (Vite/Next/Nuxt) → the repo's own
\`npm run dev\`; Django → \`manage.py runserver\`; Go → \`go run .\`. Override with an
explicit \`command\` + \`port\` to run YOUR dev server, or \`hostPort\` to point
\`.gen\` at a dev server you ALREADY run (e.g. one started with \`manageProcess\`).
Docker is only for the SERVICES behind it and for the OPT-IN production build.

A **production build+serve** is OPT-IN via \`runMode:'recipe'\` — for when you want
the artifact the app actually ships: PHP → \`composer install --no-dev\` then
FrankenPHP over \`public/\`; Next → \`npm run build\` then \`next start\`; a built
front end (Vite/CRA) → nginx over \`dist/\`; Django → collectstatic then gunicorn;
FastAPI/Flask → uvicorn; Go → the compiled binary — each in a container. A repo's
own Dockerfile is \`runMode:'dockerfile'\`. Actions (\`action\`):
- \`detect\` — read a repo and return every recipe it could use (each with
  \`confident\`, and \`needs\` when it is a guess). Host-native dev needs none of it.
- \`list\` / \`status\` — every site + live state. \`state:'running'\` means the
  process/container is up; \`ready:true\` means the port actually accepted a
  connection.
- \`create\` — define one and host it: \`name\` (a DNS label) and, for the default,
  NOTHING else (host-native dev is inferred). Or an explicit \`command\` + \`port\`,
  or \`runMode:'recipe'\` for the production build. Optional \`repo\`
  (host \`repos/<repo>\`), \`image\`, \`env\`, \`exposed\`, \`kind\`.
- \`update\` — edit an existing site by \`id\`: pass only the fields to change
  (\`name\`/\`genName\`, \`port\`, \`env\`, \`command\`/\`build\`/\`serve\`, \`image\`,
  \`runMode\`, \`exposed\`, \`upstreamHost\`, \`kind\`). A RUNNING site is
  rebuilt/restarted only when the change needs it; a cosmetic edit leaves it as is.
- \`start\` / \`stop\` / \`restart\` / \`logs\` — by \`id\` (from a \`list\`). \`open\` —
  show the site in the Genie Browser for the user. \`remove\` — stop it and forget
  the definition.
READ THE RESULT: for a host-native site, \`logs\` carries the dev server's own
output AND any spawn failure (e.g. the binary not being on the host PATH — a
host-native site runs the repo's toolchain, so \`php\`/\`node\` must be installed and
resolvable). For a production recipe, a failed BUILD is the usual reason a site
does not come up, and \`buildLog\` carries it. SERVICES: a host-native dev server
runs ON THE HOST, so it reaches a \`manageProcess\` service and the managed DB/cache
on \`127.0.0.1:<published port>\` — the host-form env (\`DATABASE_URL\`, …) Genie
injects, the SAME env terminals get. (A container-recipe site instead reaches
services by engine name on the workspace network; there its \`localhost\` is the
sandbox and a host \`manageProcess\` service is at \`\${GENIE_HOST_GATEWAY}:<port>\`.)
A DATABASE OR CACHE IS NEVER EXPOSED. Only what the BROWSER connects to is exposed,
via \`exposed:[{name,port,protocol,reason}]\`; a surface that cannot say why the
browser needs it is refused. BIND the dev server to the \`port\` you give (a server
on a random port \`.gen\` can't find is the common mistake; a container-recipe
server must bind \`0.0.0.0\`). Host-native dev needs NO Docker; the OPT-IN
production recipe and services do — when neither is usable that path's result
carries the install hint. Pass \`terminalId\` for exact workspace resolution.

### manageService
**Give this workspace a backing SERVICE** — Postgres, MySQL, Redis, Meilisearch,
MinIO (S3), Mailpit, Reverb (WebSockets/broadcasting), or any image — and get
back how to connect. These are the
same engines a \`manageSite\` site runs against, so a hosted site is backed the
way production is. THE MODEL: an engine is WORKSTATION-hosted and **shared per
(engine, major version)** across every workspace that asks for it, and each
workspace gets its OWN database + role + credentials on it — one \`postgres:16\`
serves ten workspaces, and one workspace's role cannot reach another's data. The
engine starts when the first workspace acquires it and stops when the last one
releases it. Actions (\`action\`):
- \`catalog\` — every engine on offer, its versions, and how strongly each isolates.
- \`inventory\` — MACHINE-level: every engine on this workstation, whether its
  image is on disk, whether it is up, and how many workspaces hold it (and
  which). Read this BEFORE stopping/removing anything — \`stop\` is a RELEASE, and
  it only stops the container if this was the last holder.
- \`list\` / \`status\` — this workspace's services + live state.
- \`add\` — \`engine\` (+ optional \`version\`): defines it, starts the engine,
  creates this workspace's database/role/credentials, attaches the engine to the
  workspace network, and injects the connection env.
- \`start\` / \`stop\` / \`logs\` — by \`id\`. \`connection\` — the connection surface +
  the exact env keys injected. \`dedicated\` — flip one service to its own
  container. \`remove\` — release it (\`purge\` also drops the data volume).
A service is BACKEND: it is never given a browser-facing name — reach it
in-container through the injected \`envKeys\` (\`DATABASE_URL\`, …), which are also
present in a site's BUILD steps, so a \`manageSite\` app needs no \`.env\` edit.
Requires Docker or Podman. Pass \`terminalId\`.

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

### agentinbox
**Coordinate with the OTHER AI agents in this Genie** — AgentInbox, a LOCAL
inter-agent messaging network. Discover peer agents, DM them 1:1, and broadcast
on shared CHANNELS. You FETCH messages with \`receive\`; nothing is injected
MID-TURN (that would corrupt it). To wait for a reply, make **ONE blocking
\`receive\` with \`wait: true\`** — it returns the moment a message lands, so do NOT
sit in a poll loop. Actions (\`action\`):

For Codex, Genie automatically installs a SessionStart hook that sends Codex's generated session id back to Genie and rebinds the existing AgentInbox identity and history in place. Agents should not hand-edit this hook or create a second registration. Codex owns hook trust; if it reports a pending hook, review it once with \`/hooks\`. Genie cannot inspect or bypass that trust decision.

- \`list\` — discovery: your own agent info (\`self\`), the peers you can SEE
  (\`agents\`), and your \`channels\`. Each peer carries \`reachable\`: **false means
  you can see it but cannot DM it** — discover-then-ask, rather than the agent
  silently not existing. Two tiers decide this and you must clear BOTH: the
  WORKSPACE's access setting (who may reach into it at all — its channels and its
  agents) and that agent's own \`scope\`.
- \`send\` — DM a peer with \`to\` = their \`agentId\`, OR broadcast with \`channel\` =
  a purpose (\`frontend\` → your workspace's room) or \`slug:purpose\` (another
  workspace's). Needs \`text\`. Optional \`interrupt: true\` also glows a DM target's
  terminal so they notice (never injected into their pty). Optional
  \`attachments\` — a list of file paths inside **your own workspace** to send
  along. Genie READS each file and stores its BYTES, so the recipient gets a real
  copy even though it can't see your disk; one unreadable path fails the whole
  send rather than shipping a subset.
- \`receive\` — fetch NEW messages: pass a \`cursor\` from a prior receive to page
  forward; set \`wait: true\` to LONG-POLL (optional \`timeoutMs\`, default ~4min) —
  delivery WAKES the call the instant a message lands, so ONE blocking call is
  how you await a peer's reply. Only call again if it returns empty (timed out)
  and you still want to wait. Genie also PUSHES a notification to your MCP
  connection on delivery when your client supports the server-push stream — the
  blocking \`receive\` is what actually hands you the message either way. A message
  that carries files has an \`attachments\` array on it (\`id\`, \`filename\`,
  \`bytes\`, \`mime\`) — that \`id\` is what you save with.
- \`saveAttachment\` — write a received file into **your own workspace**:
  \`attachmentId\` (from a message's \`attachments\`), optional \`path\` (a folder, or
  a trailing slash, means "land in here" under the original name; omit it to save
  at your workspace root) and optional \`overwrite\` (default false — a save that
  would clobber a file fails instead). You can only save into YOUR workspace, and
  only files from a message that actually reached you: an attachment id is a
  handle, not access.
- \`receipts\` — read-receipts for the DMs YOU sent: each with a \`seen\` flag (true
  once the recipient has received it). Lets you tell 'queued' from 'seen' and decide
  whether to escalate to a nudge. Optional \`limit\` (default 20).
- \`setAccessibility\` — \`scope\`, who may **DM you**: \`self\` (your workspace only,
  the default) / \`specific\` + \`workspaces\` (a chosen set — limited to workspaces
  you govern) / \`all\` (the whole workstation) / \`none\` (nobody — but you stay
  LISTED to peers as unreachable, so they can find you and ask) / \`hidden\`
  (nobody, and you're omitted from their discovery entirely — the true opt-out).
  Your WORKSPACE's own access setting applies on top: it decides which workspaces
  may reach yours at all, and a workspace that refuses yours hides its agents from
  you completely.
  Optional \`purpose\` renames your channel. Optional \`wakeOnDm\` (default off): when
  ON, a DM that arrives while you're IDLE (turn ended, prompt empty) injects a
  one-line nudge so you start a turn and see it — instead of it sitting unread
  until you next act. Fail-safe: never fires mid-turn (any output since your last
  turn ended cancels it).
- \`join\` / \`leave\` — opt in/out of a \`channel\`.
Your identity + accessibility persist across restarts. Local-only — no relay, no
cross-host. Use it to hand a peer context, ask another agent to take a task, or
watch a shared channel while you work.
**Attachments** are byte COPIES Genie stores, never path references — so send the
file rather than telling a peer where it lives. You may only attach from your own
workspace and only save into your own; files are size-capped, and
natively-executable types (\`.exe\`, \`.msi\`, \`.bat\`, …) are refused at both ends.

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
single terminal when there is only one. It explains clearly when GitHub isn't connected,
the terminal maps to no workspace, or nothing is open. (The same per-bucket
counts are also appended to every \`imDone\` response — see below.)

### imDone
Call this the moment you **finish your work / hand back to the user** in THIS
terminal. Genie pulses the terminal's glow in the workspace rail, the flyout row,
and the panel border until the user focuses it — so they're drawn to the terminal
that needs them even from another project. Pass \`terminalId\` (your
\`GENIE_TERMINAL_ID\`) to target this exact terminal; omit it to use the
workspace's only terminal when unambiguous. Prefer this over silently ending: a
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
absolute; System-workspace agents pass an absolute/system path). A relative
\`path\` resolves against the WORKSPACE ROOT — not your shell's cwd — and keeps
its full subdirectory path (\`.ai/plans/x.md\` opens \`<workspace>/.ai/plans/x.md\`);
an absolute path inside ANOTHER Genie workspace opens in THAT workspace's editor,
and one no workspace owns opens in the System workspace. Optional \`line\`
(1-based) to reveal, and the usual \`terminalId\` (your \`GENIE_TERMINAL_ID\`) for
exact workspace resolution (required when the workspace has several terminals). Benign DISPLAY
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

## Hosting a repo at .gen (the Hosting Manager)
When you need to actually RUN a repo — preview the frontend, hit the API, hand
the user a working URL — use the **Hosting Manager** (\`manageSite\` +
\`manageService\`), **not** a hand-rolled \`manageProcess\` dev server. The DEFAULT
is **host-native** (story #238): Genie runs the repo's OWN dev server as a HOST
process against the live source — **no container, no build** — reachable at a
stable \`https://<name>.gen\` whether the viewer is local or connected remotely:

- **\`manageSite\`** runs the repo's dev server on the host — \`php artisan serve\`
  for Laravel, the repo's \`npm run dev\` for Vite/Next/Nuxt, \`manage.py runserver\`
  for Django, \`go run .\` for Go — the way Herd did. Call it with just a \`name\` to
  take the detected dev server, or pass an explicit \`command\` + \`port\`. A
  PRODUCTION build+serve (the shipped artifact — FrankenPHP over \`public/\`,
  \`next start\`, nginx over a built SPA, gunicorn/uvicorn, a compiled binary, or
  the repo's own Dockerfile) is OPT-IN via \`runMode:'recipe'\`/\`'dockerfile'\`.
  Because a host-native site runs the repo's toolchain, that toolchain
  (\`php\`/\`node\`/\`python\`/\`go\`) must be installed and on Genie's PATH — a spawn
  failure is reported in \`logs\`.
- **\`manageService\`** gives the site its backing engines (Postgres, MySQL,
  Redis, Meilisearch, MinIO, Mailpit, …), SHARED per (engine, major version)
  across the workstation, auto-injecting the connection env (\`DATABASE_URL\`, …).

**Reachability:** a host-native dev server runs ON THE HOST, so its \`localhost\`
IS the host — it reaches the workspace's managed DB/cache and any \`manageProcess\`
service on \`127.0.0.1:<published port>\` through the host-form env Genie injects
(the same env terminals get). (A container-recipe site instead reaches services
by engine name on the workspace network, with host processes at
\`\${GENIE_HOST_GATEWAY}:<port>\`.) **Backends are never exposed** — a database or
cache has no \`.gen\` name. Only BROWSER-facing surfaces are published: the site at
\`<name>.gen\`, plus anything you explicitly list in \`exposed\` with a reason the
browser needs it. BIND the dev server to the \`port\` you gave it (a container
recipe must bind \`0.0.0.0\`). One host-allowlist gotcha survives: a framework's
host check (Django's \`ALLOWED_HOSTS\`, Vite's \`allowedHosts\`) can reject the
\`.gen\` Host header — Genie's allowlist plan handles the common ones, or pass
\`upstreamHost:'localhost'\`. Host-native dev needs NO runtime; the OPT-IN
production recipe and services need Docker or Podman.

## Rule of thumb
If you would otherwise stop and wait for the user — **finished**, **blocked**, or
**need a decision** — reach for these tools first. In a multi-terminal,
multi-project workspace, an agent that waits silently is an agent that's stuck.

## Notes
- \`genieGuide\` opens with \`Genie version: <version>\` — the running Genie build.
  Call it whenever you need to know which version you're on.
- The server is reached at a fixed local URL written into this workspace's
  \`.mcp.json\`. Pass \`GENIE_TERMINAL_ID\` as \`terminalId\` for exact targeting.
- \`initializeWorkspace\` is available through both \`tools/call\` and MCP prompts
  (\`prompts/list\` / \`prompts/get\`) for client compatibility.
- Enabled **plugins** contribute additional, namespaced tools that ride the same
  \`tools/list\` after the core set (e.g. \`presentation.createDeck\`,
  \`spreadsheet.createWorkbook\`). Which ones exist depends on the plugins this
  workspace has enabled — re-read \`tools/list\` to see them.
- More tools may appear over time, some contextual to the project type. Re-read this
  guide (or \`tools/list\`) if you need the current set.
`;

/** Brief body synced into a workspace's AGENTS.md (points back to the full guide). */
export const GENIE_AGENTS_BRIEF = `You are running inside **Genie** — a desktop UX that hosts many projects at once, each with its own terminals, editors, and background processes. You are **one of several agents in different terminals, and the user is NOT watching this one.** Anything you print here — "done", a question, "I'm blocked" — goes **UNSEEN** and silently stalls the work. The local \`genie\` MCP server (a fixed URL in this workspace's \`.mcp.json\`) is your ONLY channel to the user. This protocol is **which tool to use, WHEN to reach for it, and HOW** — follow it:

- **Fresh or newly converted workspace? → \`initializeWorkspace\`.** Call it once to receive the envelope/repo map and a numbered orientation plan. It is also available as an MCP prompt in clients that expose prompt pickers.
- **Finished, or handing back? → \`imDone\` — ALWAYS, every time.** The instant you stop (done, blocked-and-waiting, or handing off), call it — otherwise your result sits unseen and the work stalls. Genie glows this terminal across the whole UI until the user looks. HOW: pass \`terminalId\` = your \`GENIE_TERMINAL_ID\` for exact targeting (required once the workspace has more than one terminal — Genie refuses to guess rather than glow the wrong one). NEVER end a turn by just printing "done".
- **Need a decision, or blocked? → \`ForceTheQuestion\` — NEVER ask in plaintext and wait.** A plaintext question is invisible to the user; you'll hang forever. HOW: ONE call with 1–4 questions, each offering 2–4 options plus an always-available free-text note — **batch every open question together.** It pops an OS-level, always-on-top modal (above every app) and blocks until answered. Pass your \`terminalId\`.
  - **WRITE the question as MARKDOWN, structured.** The modal renders markdown: a short lead sentence, then blank-line paragraphs / bullet lists / **bold** for the key facts. Never one run-on paragraph.
  - **NAME THE ACTOR in every option.** The modal is read by the USER, so bare "I"/"you" invert and confuse. Convention: the agent = "Agent:"/"the agent", the user = "You:"/"you" — lead each option label with the actor (e.g. \`Agent: I create the repo and push\` vs \`You: you create the repo\`).
- **Need to HOST a repo as a real site (build + serve at \`<name>.gen\`), or give it a database/cache? → \`manageSite\` / \`manageService\` (the Hosting Manager).** \`manageSite\` BUILDS the repo and serves it the PRODUCTION way (FrankenPHP / \`next start\` / nginx / gunicorn / a compiled binary) in the workspace's container sandbox — it is NOT a \`npm run dev\` launcher, so don't stand an app up as a raw process. \`manageService\` backs it with shared Postgres/Redis/… engines and injects the connection env. Requires Docker/Podman; the tools only appear in \`tools/list\` when a runtime is present.
- **Need a supervised background COMMAND (dev server, worker, SSR) or a cron job? → \`manageProcess\`.** Don't \`&\`-background it in a terminal — Genie's Processes feature owns these so they survive and stay controllable. HOW: \`list\` / \`create\` (label + command, optional repo + autostart; add a 5-field \`schedule\` to make it a cron task) / \`start\` / \`stop\` / \`restart\` / \`enable\` / \`disable\` / \`delete\` / \`run-now\`. To actually HOST an app, reach for \`manageSite\`, not this.
- **Need to run commands, read terminal output, or launch/drive another coding agent? → \`manageTerminals\` / \`runAgent\`.** \`manageTerminals\` spawns + drives real terminals (\`create\` / \`write\` / \`read\` / \`list\` / \`kill\`); \`runAgent\` launches + steers a coding agent (claude / codex / custom) — here or in a workspace this Ops project governs. These are **HIGH-POWER** (arbitrary code + autonomous agents): \`create\` / \`write\` / agent \`start\` / \`send\` are approval-gated by default. Use \`manageWorkspaces\` to list / open / activate / remove the workspaces you can act on.

**Automate \`imDone\`:** if your harness has an on-finish hook (Claude Code's \`Stop\` hook in \`.claude/settings.json\`; Codex's \`notify\`), wire it ONCE to POST a \`tools/call\` for \`imDone\` to \`$GENIE_MCP_URL\` (passing \`$GENIE_TERMINAL_ID\`) so the glow fires on every finish automatically. Configure this in YOUR harness yourself — Genie won't. Call \`genieGuide\` for the exact snippet.

**Engineering standard — NO BANDAIDS, EVER.** Fix the ROOT CAUSE, never paper over a symptom. Don't mask a vulnerable transitive dependency with an overrides pin when the real fix is updating the dependency that pulls it; don't swallow an error, hardcode around a bug, or weaken a test to make something pass. A bandaid is just a hidden bug — it WILL resurface. The moment a Dependabot / security alert (the sec count from checkIssues / imDone) shows up and no other work is in progress, fix it properly and ship it right away.

**The rule:** any time you'd otherwise stop, print, and wait — reach for the matching tool above instead. For full usage — and the running Genie version, which it reports first — call \`genieGuide\`.`;

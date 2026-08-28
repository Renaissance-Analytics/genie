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

## Reading a result — \`ok\` is the verdict, not \`isError\`

Every tool answers with **text plus a trailing JSON block**. No tool declares an
\`outputSchema\`, so none returns \`structuredContent\` — reading it gets you null,
and that is correct, not a fault.

**A refusal rides INSIDE the payload as \`ok: false\`, while the call itself
succeeded, so the envelope's \`isError\` stays unset.** Parse the JSON and check
\`ok\`. Treating "not \`isError\`" as success reports refusals as wins.

This is not hypothetical. A DM to an unavailable agent comes back \`ok:false\`
with the reason inside the payload. A caller checking only \`isError\` would
incorrectly report that refusal as a successful send.

When \`ok\` is false, the accompanying \`error\` says what to do next; surface it
rather than a generic failure.

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
plain \`127.0.0.1:<port>\`. Only a SANDBOX (\`runMode:'explicit'\`) \`manageSite\` site is off that
network — from there, reach a host process at \`\${GENIE_HOST_GATEWAY}:<port>\`
(see \`manageSite\`), never \`127.0.0.1\`.
Creating a scheduled task is approval-gated (the modal shows the command and its
recurrence). This is for supervised COMMANDS — to HOST a repo as a real site,
reach for \`manageSite\` (below), not a hand-rolled \`manageProcess\` dev server.
Returns the resulting process list. Pass \`terminalId\` (your \`GENIE_TERMINAL_ID\`)
for exact workspace resolution; optional.

### manageSite
**Host a repo at a stable \`https://<name>.gen\`** — Genie's Hosting Manager.

**PREFER letting GENIE SERVE the app** (\`hostServe\`). You point a site at a REPO
and a ROOT; Genie owns the web server, the port and the \`.gen\` address, and
writes the config itself — nobody hand-rolls an nginx/Caddy block. A PHP/Laravel
app points at the app root and Genie serves its \`public/\`; a built front end
points at \`dist\` (SPA-aware). No \`command\`, no \`port\`.

A php site runs on the machine's DEFAULT PHP unless it pins one
(\`hostServe.version\`, e.g. \`'8.3'\` — a version Genie manages, listed in
Settings → Toolchain). Genie spawns that install's own \`php-cgi\`, never a PATH
lookup, and a pinned version it does not manage FAILS the start naming what to
install rather than quietly serving on a different runtime.

**Running the repo's OWN dev server is the FALLBACK** — for a stack Genie cannot
serve yet, or when you specifically want HMR against live source. It is what a
bare \`create {name}\` still infers (host-native, story #238: a HOST process
against LIVE source, no container, no build — PHP/Laravel → \`php artisan serve\`;
Node → \`npm run dev\`; Django → \`manage.py runserver\`; Go → \`go run .\`), so say
what you want rather than taking the inference by accident. Override with an
explicit \`command\` + \`port\`, or \`hostPort\` to point \`.gen\` at a dev server you
ALREADY run (e.g. one started with \`manageProcess\`).
Docker is only for the SERVICES behind it.

**There is NO production build+serve here, and asking for one is REFUSED**
(genie#191). \`runMode:'recipe'\`/\`'dockerfile'\`/\`'compose'\`/\`'devcontainer'\` come
back as an error naming why: nothing in this model runs \`build\` steps or a
per-site \`image\` — a site is a command, run on the HOST (\`host\`) or in the shared
workspace sandbox (\`explicit\`) — so accepting one would record a build+serve that
never happens and report the site \`running\` regardless. \`build\` and \`image\` are
likewise recorded but never used, and the result says so. TO SERVE A BUILT
ARTIFACT: run the build yourself (a terminal, or \`manageProcess\`) and point
\`hostServe\` at the output. Actions (\`action\`):
- \`detect\` — read a repo and return every way it could run (each with
  \`confident\`, and \`needs\` when it is a guess OR when Genie cannot run that mode
  at all — READ \`needs\` before choosing). Host-native dev needs none of it.
- \`list\` / \`status\` — every site + live state. \`state:'running'\` means the
  process/container is up; \`ready:true\` means the port actually accepted a
  connection.
- \`create\` — define one and host it: \`name\` (a DNS label) and, for the default,
  NOTHING else (host-native dev is inferred). Or \`hostServe\` (Genie serves it), or
  an explicit \`command\` + \`port\`. Optional \`repo\` (host \`repos/<repo>\`), \`env\`,
  \`exposed\`, \`kind\`.
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
resolvable). \`pending:true\` means the start was ACCEPTED and is STILL RUNNING —
the call returns early rather than blow its 120s timeout on a cold image pull, so
poll \`status\` with the returned \`id\` until \`phase\` is \`ready\` or \`failed\` before
reporting the site live. SERVICES: a host-native dev server
runs ON THE HOST, so it reaches a \`manageProcess\` service and the managed DB/cache
on \`127.0.0.1:<published port>\` — the host-form env (\`DATABASE_URL\`, …) Genie
injects, and which Genie also WRITES into the repo's \`.env\` (gitignored) so anything
reading that file agrees. A TERMINAL gets only the client-tool credentials
(\`PG*\`/\`MYSQL_*\`, plus the rest under \`GENIE_\`) — read the app's own config from
\`.env\`, never from the shell. (A sandbox (\`explicit\`) site instead reaches
services by engine name on the workspace network; there its \`localhost\` is the
sandbox and a host \`manageProcess\` service is at \`\${GENIE_HOST_GATEWAY}:<port>\`.)
A DATABASE OR CACHE IS NEVER EXPOSED. Only what the BROWSER connects to is exposed,
via \`exposed:[{name,port,protocol,reason}]\`; a surface that cannot say why the
browser needs it is refused. BIND the dev server to the \`port\` you give (a server
on a random port \`.gen\` can't find is the common mistake; a sandbox
(\`explicit\`) server must bind \`0.0.0.0\`). Host-native dev needs NO Docker; a sandbox
(\`explicit\`) site and services do — when a runtime is unusable that path's result
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
  container. \`remove\` — release it (\`purge\` also drops the data volume, and is
  REFUSED while any other workspace still has a database in it — open or not).
A service is BACKEND: it is never given a browser-facing name — reach it
in-container through the injected \`envKeys\` (\`DATABASE_URL\`, …), which are also
present in a site's BUILD steps, so a \`manageSite\` app needs no \`.env\` edit.
Requires Docker or Podman. Pass \`terminalId\`.

### manageGappDev
**Build the Genie App this workspace is the home of** — the GApp Development
Workspace (GDW) tools.

A **GApp Development Workspace** is a workspace whose linked Tynn project is
marked \`is_gapp\`: the place a Genie App is **BUILT**, as opposed to the
workspaces where an installed app **RUNS**. The flag has exactly ONE home — a
human sets \`is_gapp\` on the Tynn project and Genie converges on that answer, so
there is no Genie-side setting to flip and nothing for you to toggle.

**You cannot tell you are in one by looking at the folder.** A GDW is an ordinary
project directory; what makes it a GDW lives in Tynn and on Genie's workspace
row. The user can see it — the workspace wears its own chrome — but you cannot,
so **ask**: \`manageGappDev\` with \`action:'status'\`. Every other action reports
the status too, so a single call always answers "where am I". Actions
(\`action\`):
- \`status\` — am I in a GDW; the source folder; the app the folder declares
  (name, slug, version) or that it has no \`genie-app.json\` yet; any preview
  open right now.
- \`check\` — run the **full check suite** over this folder: manifest, files,
  agent roster, services, front end. Deliberately STRICTER than the installer —
  an app that installs cleanly and then opens on an empty window is the failure
  it exists to catch, and the install gate has nothing to say about that. Every
  finding names where, what is wrong, and what to do.
- \`preview\` — open the app in a **real GApp window on the LIVE source**, under
  its own \`<slug>.preview\` identity and address, so it cannot collide with an
  installed copy. The user answers the app's permission modal the first time its
  asks change; that consent is theirs and you cannot supply it.
- \`close-preview\` — tear one down (optional \`appId\`; defaults to this
  workspace's own). Closing the window does the same thing.

No folder argument anywhere: in a GDW, Genie already knows which app you mean.
Called from a workspace that is NOT a GDW, it says so and names who sets the
flag rather than failing obscurely. Pass \`terminalId\`.

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

### registerAgent
**Register a durable workspace agent without starting its TUI.** Supply its
\`name\` and provider plus optional command, working directory, and specialized
persona. Registration creates configuration and identity only; call \`runAgent\`
with \`action:'start'\` when the agent should consume resources and begin work.

At automatic boot, Genie's harness adapter completes AgentInbox's internal
\`registerTransport\` handshake: Claude Code reports \`claude-channel\`, Codex
reports \`codex-app-server\`. Agents do not simulate this handshake and AgentInbox
messages are never delivered by typing into the terminal&apos;s user-input buffer.

### runAgent
**Start and control a coding agent** (claude / codex / a custom CLI) — your own
workspace or one you govern.

An agent is **SAVED WORKSPACE CONFIGURATION**, like a site or a service: defined
once, it persists, and it is **reopened rather than recreated**. It is still a
terminal — it lives in the workspace sidebar and the Floor UX like any other.

**Identity** is \`{provider}:{name}:{chat-id}\` — e.g. \`claude:tynn\`,
\`codex:tynn-slave\`. The \`{provider}:{name}\` half is the saved config and is
what you address it by; the chat-id is addressing only and is bound during
startup (Codex cannot know its session id until its harness is running). Show
people the provider's LOGO and the NAME, never the chat-id.

Actions (\`action\`):
- \`list\` — read-only: this workspace's saved agents, each with its \`ref\`,
  \`name\`, terminal \`id\`, and whether it is live. Start here.
- \`start\` — bring the saved agent \`name\` up. It **REATTACHES** to that agent —
  running or dormant — and does NOT create a second one. \`name\` defaults to
  \`general\` (the workspace's unnamed agent). \`agent\` only disambiguates one
  name saved under two providers; the record decides otherwise. Optional
  \`instructions\` are PRE-LOADED as the agent's opening prompt. Optional
  \`repo\`/\`cwd\`. Returns \`id\`, \`ref\`, and \`reattached\`.
- \`send\` — deliver a \`prompt\` to the running agent \`id\`. SUBMITTED by default,
  even multi-line: the prompt is wrapped in bracketed paste and the Enter is
  delivered separately (outside the paste) so the agent's TUI submits it instead
  of leaving it parked as a "[Pasted text +N lines]" buffer. Pass \`submit: false\`
  to load the prompt without sending, or \`key\` (\`enter\` | \`escape\` | \`ctrl-c\`)
  to deliver a bare keypress — e.g. a lone \`enter\` to submit or clear a stuck
  multi-line buffer.
- \`read\` — its output (\`cursor\` for new, or \`bytes\` for the last N; add
  \`strip: true\` for plain text with escape codes removed).
- \`stop\` — terminate the agent \`id\`. The SAVED agent survives; \`start\` brings
  it back, resuming its conversation.
- \`restart\` — GRACEFULLY relaunch the agent \`id\`: it resumes the SAME
  conversation (via \`--resume\`) in a fresh terminal, so its TUI reconnects to the
  current MCP rig / \`.mcp.json\` after a genie update WITHOUT losing context.
  claude-only, needs a captured session. Returns the NEW terminal \`id\`.
**Approval:** creating an agent, \`send\`, and \`restart\` are GATED the same way
(OFF runs immediately). \`list\`, \`read\`, and reattaching to an already-approved
saved agent never prompt.

### manageWorkspaces
**Manage the Genie workspaces you can act on** — your own + (for an Ops agent)
the ones you govern. Actions (\`action\`): \`list\`/\`status\` (read-only — each
workspace's id, name, path, and whether it's yours or a governed child);
\`open\` / \`activate\` (focus / surface a workspace); \`remove\` (UNREGISTER a
workspace from Genie — never deletes anything on disk). Targets are limited to
your own or a governed workspace. To CREATE missing child workspaces, use
\`provisionWorkspaces\`.

### agentinbox
**Coordinate with the OTHER AI agents in this Genie** — AgentInbox, a LOCAL,
durable 1:1 messaging network. Discover visible peers and DM them directly. To
wait for a reply, make **ONE blocking
\`receive\` with \`wait: true\`** — it returns the moment a message lands, so do NOT
sit in a poll loop. Actions (\`action\`):

For Codex, Genie automatically installs a SessionStart hook that sends Codex's generated session id back to Genie and rebinds the existing AgentInbox identity and history in place. Agents should not hand-edit this hook or create a second registration. Codex owns hook trust; if it reports a pending hook, review it once with \`/hooks\`. Genie cannot inspect or bypass that trust decision.

- \`list\` — discovery: your own agent info (\`self\`) and the peers you can SEE
  (\`agents\`). Each peer carries \`reachable\`: **false means
  you can see it but cannot DM it** — discover-then-ask, rather than the agent
  silently not existing. Two tiers decide this and you must clear BOTH: the
  WORKSPACE's access setting (who may reach into it at all — its
  agents) and that agent's own \`scope\`.
- \`send\` — DM a peer with \`to\` = their TAG (\`{provider}:{name}\`, e.g. \`claude:tynn\`;
  or \`{workspace}:{provider}:{name}\` for another workspace). That is the \`ref\`
  \`list\` prints for every peer. A raw \`agentId\` still works, but prefer the tag:
  an id lives on the TERMINAL spec, so it dies with a replaced terminal while a
  name does not. Needs \`text\`. Optional \`interrupt: true\` also glows a DM target's
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
  you govern) / \`all\` (the whole workstation) / \`none\` or \`hidden\` (private
  outside your workspace and omitted from external discovery).
  Your WORKSPACE's own access setting applies on top: it decides which workspaces
  may reach yours at all, and a workspace that refuses yours hides its agents from
  you completely.
  A private agent may initiate a DM to a visible agent; that recipient can reply
  in the durable thread without making the private sender externally discoverable.
  Optional \`wakeOnDm\` (default ON): when ON, a DM is ANNOUNCED in your chat as soon as it arrives —
  mid-turn is fine, your TUI queues it — carrying its urgency so you can decide
  whether to break off. It is held back only while the HUMAN is typing at your
  terminal or has a draft in the box. Turn it OFF to stay silent until you check
  your inbox yourself.
Your identity + accessibility persist across restarts. Local-only — no relay, no
cross-host. Use it to hand a peer context, ask another agent to take a task, or
continue a durable direct conversation while you work.
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
\`[[wikilink]]\` references in their body; each link is a graph edge.

**Every memory is one of FOUR classes** (\`class\`), because they answer four
different questions — ask with the wrong one and you get the other's answers:
- \`profile\` — what is TRUE of the user / what they prefer.
- \`episodic\` — what HAPPENED, and when.
- \`procedural\` — what was LEARNED from doing this before.
- \`knowledge\` — where this is in the DOCUMENTS. The **default**, and what every
  memory written before classes existed is.
SET \`class\` when you \`add\`, and PASS it when you \`search\`/\`list\` so you get the
kind you meant. Omitting it on a read covers every class, exactly as before.
It is still ONE graph — \`[[wikilink]]\`s cross classes freely, so a \`procedural\`
memory should cite the \`knowledge\` node it was learned from.

Actions (\`action\`):
- \`search\` — keyword retrieval (needs \`query\`; optional \`limit\`, \`class\` to
  restrict to ONE class, and \`tags\` to restrict to nodes carrying ALL those
  tags). Returns ranked hits carrying their own \`class\`. **Search FIRST** to see
  what's already known.
- \`get\` — a node by \`id\` (full body + its linked node ids).
- \`add\` — create a node: \`title\` (required), optional markdown \`body\` (put
  \`[[wikilink]]\`s to related nodes in it), optional \`class\`, optional \`tags\`,
  optional explicit \`links\` (ids/titles/slugs). Returns the new \`id\`.
- \`list\` — recent nodes (optional \`class\`, \`tag\`, \`limit\`). This is how you ask
  an EPISODIC question — "what happened recently" is ordered by recency and has
  no query string to search for.
- \`link\` — add an edge from node \`from\` to \`to\` (an id, title, or slug).
Keyword search is always available (no API key, no setup, works offline). Prefer
searching before adding a duplicate, and cross-link related memories with
\`[[wikilink]]\`s so the graph stays connected.

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

Alongside the three GitHub buckets it reports \`feedback:\` — **unresolved
project feedback recorded in Tynn**. That one is NOT a GitHub item and **not a
failure**: it is input from outside the build that nobody has triaged yet. Read
the entries with the Tynn \`feedback\` tool and convert what should become work;
whether a given piece of feedback is worth acting on stays a **human call**, so
never close entries just to bring the number down.

### thumbsUp
Call \`thumbsUp\` after startup and orientation are complete to mark the bound
workspace agent ready. This is a durable readiness acknowledgement, not task
completion; use \`imDone\` when handing control back to the user.

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
\`IssueWatch — issues:3, PR:1, sec:3, feedback:2\`, where \`sec\` is the
security-alert aggregate and \`feedback:\` is unresolved project feedback waiting
on triage in Tynn — work waiting, **not a failure**), so you see what's still
open the moment you hand back; call \`checkIssues\` for the full list.

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

### submitFeedback
**File feedback about GENIE ITSELF** into this workspace's Tynn project — a rough
edge, a confusing surface, something that behaved unexpectedly. It lands in Tynn's
feedback pipeline, where a human triages, quick-accepts or converts it to a wish.

Reach for it the MOMENT you notice something, instead of writing it into a
terminal nobody is reading. That is the same reason \`imDone\` and
\`ForceTheQuestion\` exist: a remark in a terminal the user is not watching has not
been made.

- Pass \`message\` — what happened, in your own words. Concrete beats polite: what
  you expected, what you got.
- Genie stamps the version, workspace and terminal itself, so do not describe your
  own environment; the facts Genie knows for certain are better than the ones you
  believe.

NOT for: work you are doing (a feature is a wish, a defect is a repo issue), and
NOT for asking the user something — that is \`ForceTheQuestion\`.

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
  for Django, \`go run .\` for Go — against the live source. Call it with just a
  \`name\` to take the detected dev server, or pass an explicit \`command\` + \`port\`,
  or \`hostServe\` to have Genie serve a built directory / a PHP app itself. A
  PRODUCTION build+serve (\`runMode:'recipe'\`/\`'dockerfile'\`/\`'compose'\`/
  \`'devcontainer'\`) is REFUSED with a reason — nothing here runs build steps or a
  per-site image, so build first and point \`hostServe\` at the output (genie#191).
  Because a host-native site runs the repo's toolchain, that toolchain
  (\`php\`/\`node\`/\`python\`/\`go\`) must be installed and on Genie's PATH — a spawn
  failure is reported in \`logs\`.
- **\`manageService\`** gives the site its backing engines (Postgres, MySQL,
  Redis, Meilisearch, MinIO, Mailpit, …), SHARED per (engine, major version)
  across the workstation, auto-injecting the connection env (\`DATABASE_URL\`, …).

**Reachability:** a host-native dev server runs ON THE HOST, so its \`localhost\`
IS the host — it reaches the workspace's managed DB/cache and any \`manageProcess\`
service on \`127.0.0.1:<published port>\` through the host-form env Genie injects —
the same values Genie writes into the repo's \`.env\`, which is where anything not
started by Genie reads them. (A sandbox (\`explicit\`) site instead reaches services
by engine name on the workspace network, with host processes at
\`\${GENIE_HOST_GATEWAY}:<port>\`.) **Backends are never exposed** — a database or
cache has no \`.gen\` name. Only BROWSER-facing surfaces are published: the site at
\`<name>.gen\`, plus anything you explicitly list in \`exposed\` with a reason the
browser needs it. BIND the dev server to the \`port\` you gave it (a sandbox
site must bind \`0.0.0.0\`). One host-allowlist gotcha survives: a framework's
host check (Django's \`ALLOWED_HOSTS\`, Vite's \`allowedHosts\`) can reject the
\`.gen\` Host header — Genie's allowlist plan handles the common ones, or pass
\`upstreamHost:'localhost'\`. Host-native dev needs NO runtime; a sandbox
(\`explicit\`) site and the services need Docker or Podman.

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
- **Need to HOST a repo as a real site at \`<name>.gen\`, or give it a database/cache? → \`manageSite\` / \`manageService\` (the Hosting Manager).** \`manageSite\` runs the repo's dev server on the host against the live source and fronts it at \`https://<name>.gen\` over https (or serves a built directory / PHP app itself via \`hostServe\`). To host an app, use this — not a hand-rolled \`manageProcess\` process. \`manageService\` backs it with shared Postgres/Redis/… engines and injects the connection env (Docker/Podman needed for services).
- **Need a supervised background COMMAND (dev server, worker, SSR) or a cron job? → \`manageProcess\`.** Don't \`&\`-background it in a terminal — Genie's Processes feature owns these so they survive and stay controllable. HOW: \`list\` / \`create\` (label + command, optional repo + autostart; add a 5-field \`schedule\` to make it a cron task) / \`start\` / \`stop\` / \`restart\` / \`enable\` / \`disable\` / \`delete\` / \`run-now\`. To actually HOST an app, reach for \`manageSite\`, not this.
- **Building a Genie App? → \`manageGappDev\`, and ASK it first.** A **GApp Development Workspace (GDW)** is a workspace whose linked Tynn project is marked \`is_gapp\` — where an app is BUILT, as opposed to where an installed one RUNS. **You cannot tell from the folder**, which looks like any other project; the user sees it in the workspace chrome and you do not. So call \`manageGappDev\` with \`action:'status'\` — it answers whether you are in one, names the source folder and the app's manifest, and every other action reports it too. Then \`check\` (the full suite over this folder — stricter than the installer, because an app that installs cleanly and opens on an empty window is what it exists to catch) and \`preview\` (a real GApp window on the LIVE source at \`<slug>.preview\`, so it cannot collide with an installed copy). The \`is_gapp\` flag is set by a human in Tynn; there is nothing to toggle in Genie.
- **Need to run commands, read terminal output, or start/drive another coding agent? → \`manageTerminals\` / \`runAgent\`.** \`manageTerminals\` spawns + drives real terminals (\`create\` / \`write\` / \`read\` / \`list\` / \`kill\`); \`runAgent\` starts + steers a coding agent (claude / codex / custom) — here or in a workspace this Ops project governs. An agent is **SAVED workspace configuration**, addressed as \`{provider}:{name}\` (\`claude:tynn\`): \`runAgent list\` shows them, and \`start\` **REATTACHES** to one rather than spawning another — creating a new agent needs \`create: true\`. These are **HIGH-POWER** (arbitrary code + autonomous agents): \`create\` / \`write\` / creating an agent / \`send\` are approval-gated by default. Use \`manageWorkspaces\` to list / open / activate / remove the workspaces you can act on.

**Harness-specific setup lives in \`genieGuide\`, not here.** Wiring your on-finish hook so \`imDone\` fires automatically, and anything else that differs between Claude Code and Codex, is in the guide — call it once and follow the snippet for YOUR harness. Genie won't configure it for you.

**Engineering standard — NO BANDAIDS, EVER.** Fix the ROOT CAUSE, never paper over a symptom. Don't mask a vulnerable transitive dependency with an overrides pin when the real fix is updating the dependency that pulls it; don't swallow an error, hardcode around a bug, or weaken a test to make something pass. A bandaid is just a hidden bug — it WILL resurface. The moment a Dependabot / security alert (the sec count from checkIssues / imDone) shows up and no other work is in progress, fix it properly and ship it right away.

**The rule:** any time you'd otherwise stop, print, and wait — reach for the matching tool above instead. For full usage — and the running Genie version, which it reports first — call \`genieGuide\`.`;

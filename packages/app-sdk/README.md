# `@genie/app-sdk` — build a Genie App

A **Genie App** (GApp) is a whole agentic application. It installs into Genie with
its own workspace, its own preconfigured hosting, its own window, and access to
Genie's tools under permissions the user consents to at install — like installing
an app on a phone.

This document is written to be enough on its own. If you are an agent being asked
to "fill a gap" — build a GApp for something a user needs — read it top to bottom
and you will have everything.

---

## What a GApp actually is

It is **an `.agi` envelope with a manifest**. One or more repos, a front end Genie
serves at `<slug>.gen`, optional backend services in any language, and a
declaration of what it wants to be allowed to do.

Two real ones, to calibrate:

| | shape |
|---|---|
| **AI Trader ORR Jdun** | a `python-fastapi` backend **and** a React front end, served static at `orr.gen` |
| **The Ripple Effect** | a live artboard at `ripple.gen`, pointed at a dev server on port 5273, watched by humans **and other agents** |

So: multi-repo, multi-language, and not necessarily a human-facing surface at all.

---

## The manifest — `genie-app.json`

At the root of your app's folder.

```json
{
  "id": "com.yourname.trader",
  "slug": "trader",
  "name": "Trader",
  "version": "1.0.0",
  "description": "Watches a strategy and shows what it did.",

  "frontend": {
    "repo": "desktop",
    "serve": { "mode": "static", "root": "dist", "spa": true }
  },

  "services": [
    { "name": "api", "repo": "backend", "command": ["uvicorn", "app:api"], "port": 8000 }
  ],

  "requires": [
    { "tool": "python", "version": "3.13.15" },
    { "tool": "docker", "reason": "runs the strategy sandbox" }
  ],

  "agents": [
    { "name": "Strategist", "persona": "strategist.md", "description": "Designs trades." }
  ],

  "permissions": {
    "scope": "self",
    "capabilities": ["hosting", "knowledge"]
  }
}
```

### Fields

| Field | Notes |
|---|---|
| `id` | Reverse-DNS, globally unique. Identity everywhere. |
| `slug` | A DNS label — it becomes **`<slug>.gen`**, so `my_app` and `Trader` are refused. |
| `name` | Shown everywhere. **May not claim to be Genie**, Tynn or Aionima, in any casing. |
| `frontend.serve` | `static` (a built directory Genie serves) or `proxy` (a dev server you already run — Genie fronts the port). |
| `frontend.browserExposed` | Reachable from the user's real browser, not only the Genie window. Costs a one-time admin prompt; ask for it only if you need it. |
| `services[].command` | **A literal argv array**, never a shell string. `["uvicorn", "app:api"]`, not `"uvicorn app:api"`. |
| `requires` | Runtimes you need. Genie installs what it can on this machine and shows the user, prominently, what it cannot. Always give a `reason` — "install Docker" is an instruction; "install Docker — it runs the strategy sandbox" is a decision. |
| `agents` | The agents your app ships. Each names a persona file under **`.agents/`**. Declared here, never discovered from the folder — see below. |

A missing runtime does **not** block installation. Your app lands; whatever needs
the missing tool will not start until the user provides it. Write your app so that
reads as a clear state, not a crash.

### The agents your app ships — `.agents/`

A Genie App is a `.gapp` envelope, and beside `repos/` it has an `.agents/` folder
holding the persona and config for each agent your app can run. It pairs with
`panels.agents`: the manifest says how many agent panels the window lays out,
`.agents/` says who those agents ARE.

```
trader.gapp/
├── genie-app.json
├── .agents/
│   ├── strategist.md
│   └── reviewer/persona.md
└── repos/
```

**Dropping a file in `.agents/` does not add an agent.** Only what the manifest
lists is real. That is the opposite of the convention you know from
`.claude/agents/*.md`, and it costs you something — adding an agent means adding it
in two places — so here is why:

Your agents run under the capabilities **the user granted your app**. An agent that
appeared merely by existing as a file would be an agent nobody agreed to, and the
install screen cannot describe a roster it has to go looking for. Declaring them is
what lets Genie show the user your agents *before* granting anything. It is also
what every other part of the manifest already does — `capabilities`, `panels`,
`tabs`, `services`, `requires` — so it is one rule, not two.

Genie holds both halves together: a declared agent whose persona file is missing
**fails the folder check**, in the same breath as a front end pointed at a `dist`
nobody built. `persona` is a path relative to `.agents/` and may not climb out of
it.

#### What actually happens at runtime

Each declared agent gets an agent panel in your app's Agent tab, named after it,
running a real AI coding-agent TUI in your app's workspace and briefed with its
persona file. Slots are filled in order; if you declare more panels than agents,
the roster cycles (three panels and one agent means three sessions of that agent).
A `files` or `editor` slot is the code surface and never runs an agent, so the
roster skips it.

**You do not choose which TUI.** Claude Code, Codex or a custom command is the
user's **GApp AI Provider**, set once per workstation in Genie's Settings. Your
app is asking for someone else's machine and someone else's subscription, so it
says that it needs an agent and the workstation decides what that agent is. Write
personas that do not assume a particular harness.

Agents you declare count against the user's **agent-terminal limit**, like every
other agent on the machine. If the workspace has no room for your whole roster,
Genie starts **none** of it and tells the user why — you never silently get fewer
agents than the install screen named.

---

## Permissions — ask for the least that works

`capabilities` is what your app may DO. Each one is a line the user reads at
install, and every one you add is a reason to say no.

| Capability | What it grants | |
|---|---|---|
| `terminals` | Run any command on the machine, as the user | ⚠ high |
| `agents` | Launch and steer autonomous coding agents | ⚠ high |
| `processes` | Background processes and cron jobs | ⚠ high |
| `secrets` | Read/write environment variables (API keys, tokens) | ⚠ high |
| `ask` | Raise an always-on-top question and block until answered | ⚠ high |
| `hosting` | Serve sites at `.gen`; run databases and caches | |
| `workspaces` | List, open and create workspaces | |
| `knowledge` | Read and write Genie's knowledge graph | |
| `issues` | Open issues, PRs and security alerts | |
| `files` | Surface a file in Genie's editor for the user | |
| `notify` | Signal completion; message through the Agent Inbox | |

`scope` is what your app may reach:

- **`self`** — its own workspace. The default, and right for almost everything.
- **`workspaces`** — a named allow-list, which you must provide.
- **`workstation`** — every workspace on the machine. Ask only if the app's whole
  purpose is cross-project, and expect to justify it.

The user grants a **subset** of what you declare, and can change it afterwards.
Your app must work with less than it asked for.

---

## Using Genie from your app

```ts
import { useGenie, GenieCallError } from '@genie/app-sdk';

const genie = useGenie();

// Who am I, and what did the user actually give me?
const me = await genie.me();   // { id, name, workspaceId, scope, capabilities }

// Ask BEFORE you offer the feature.
if (await genie.can('hosting')) {
    const sites = await genie.call('manageSite', { action: 'list' });
}

// Refusals arrive as an error carrying the reason, in words for a person.
try {
    await genie.call('manageTerminals', { action: 'create', label: 'build' });
} catch (e) {
    if (e instanceof GenieCallError) showBanner(e.message);
}
```

### The rule that matters

**Hide what you were not granted.** A button that always fails teaches the user
your app is broken; a button that is not there, with one line explaining which
permission would bring it back, teaches them it is restricted. That distinction is
the difference between an app people trust and one they uninstall.

### Targeting another workspace

Only meaningful if you were granted `workspaces` or `workstation` scope:

```ts
await genie.call('manageSite', { action: 'list' }, { workspaceId: someOtherWorkspace });
```

Genie resolves the target itself. Whatever you pass is checked against your grant,
and a workspace you were not given is refused with a reason — it is never silently
retargeted to your own.

---

## What your app CANNOT do

Not restrictions to work around — they are the reason a user can install a GApp at
all:

- **No `window.genie`.** Your window has no Node, no filesystem and no Electron
  API. `window.genieApp` — two calls — is the entire surface.
- **No drawing Genie's consent UI.** Every permission prompt is an OS-level modal
  drawn by Genie *outside* your window. You cannot render, fake or intercept one.
- **No impersonating Genie.** Reserved names are refused at install, whatever the
  casing or spacing.
- **No speaking as the user.** `submitFeedback` posts to their Tynn project in
  their name; it is unavailable to every app, at every permission level.
- **No navigating out of your own origin.** Same-origin in-window; an external
  link opens in the user's real browser instead.
- **No browser permission prompts.** Camera, microphone, screen capture and
  location are refused wholesale — ask Genie through the bridge, where there is a
  grant to check.
- **Anything the user says you may see.** They can revoke any capability, at any
  time, and the next call fails closed.

---

## Building one — the short version

All of it lives in **Settings → Genie Apps**.

1. **Start a new app.** Genie writes a valid manifest, a front end and a README
   into a folder you pick. It starts with **no permissions at all** — add them as
   you need them, and be ready to say why.
2. Build your front end to a directory (`dist`), or run a dev server and use
   `serve: { mode: "proxy", hostPort: … }`.
3. **Check a folder** validates it *without installing*: schema problems, files
   the manifest points at that are not there, and — listed separately — the
   things that will work but are worth a second thought. This is the loop to work
   in: change, check, fix.
4. **Preview an app…** opens the **real app window** over your folder, without
   installing anything. A check tells you the manifest is coherent; a preview is
   the only thing that answers what your users will actually see.

   It is not a mock-up. Same window, same tab strip, same Agent tab laying out
   the panels your `panels.agents` declares, same embedded views under the same
   sandbox and the same two-call bridge — because a previewer that showed you
   something your users do not get would be worse than none at all.

   What it does *not* do is install: no entry in your apps, no tray pill, nothing
   to uninstall. **Closing the window is the whole cleanup.** It runs at its own
   address and in its own storage, so previewing an app you already have
   installed cannot read or corrupt the installed copy's data.

   It asks what to allow the first time you preview a folder, and again whenever
   you change what your manifest asks for — the moments the screen has something
   new to say. Your background **services** are not started; a preview is about
   the window, and a supervised process would outlive it.
5. **Install for development** runs it from *your* folder rather than a copy, so
   an edit shows up on reload instead of needing a reinstall, and opens its window
   with dev tools. It still asks what to allow — building an app is not a reason
   to grant it anything, and a developer who never sees their own consent screen
   never finds out how it reads. Nothing else is relaxed: same sandbox, same
   isolation, same bridge.
5. **Install an app…** for the real thing, and answer the consent prompt. Genie creates the
   workspace, copies the source in, serves it at `<slug>.gen`, and starts your
   declared services beside it.
6. Open it. Your front end renders in its own window with `window.genieApp` wired.

If a service does not come up, the install still **succeeds** and says what did
not start — an app with a broken part is not an app that failed to install.
Runtimes Genie cannot provide on this machine are listed on the app's card, and
stop being listed once you install them.

## Sharing it

Push it to GitHub, and anyone can install it with **Install from GitHub**. Genie
fetches the repository and shows them a review *before* anything is installed:

- the exact **commit** it is about to install, not just the branch,
- **every command your app will run on their machine** — your `services[].command`
  argv, listed first, because no permission covers code execution,
- the high-risk permissions you ask for, spelled out,
- anything that widens your reach past your own workspace.

Then they have to type your app's slug, and then answer the permission prompt.
Three deliberate acts, none of which can be automated away.

Design for that review. An app whose review reads well — one obvious command, two
explained permissions, a `reason` on every requirement — is one people install.

Reinstalling lands on the same workspace, and asks about permissions again — a new
version can want more than the last one did, and nobody should be escalated
silently.

---

## Filling a gap — how to decide what to build

Before writing a GApp, check that a GApp is the right shape at all:

- **A Genie feature** — if it belongs to everyone and everything builds on it (the
  knowledge graph, MCP, the permission kernel), it belongs in Genie, not in an app.
- **A plugin** — if it extends *Genie's own* surfaces (a tool, an editor mode, a
  panel), write a plugin. It runs under the plugin ABI and mounts inside Genie's
  UI.
- **A GApp** — if it is a whole application: its own runtime, its own hosting, its
  own interface. That is this.

Then, when you write it: declare the fewest capabilities that let it work, give a
`reason` for every requirement, and make every refusal something the user can read
and act on. An app that asks for little and explains itself is one people keep.

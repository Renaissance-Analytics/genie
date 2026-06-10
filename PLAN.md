# Genie — desktop companion for Tynn

> Tray-resident Nextron app. Manages local project workspaces for
> Tynn-managed projects, supports both simple repo layouts and the
> preferred Aionima `{slug}.agi` envelope format.

This is the planning artifact. Stories live in Tynn under the
**v0.7.0 — Genie desktop companion** version (created and updated
from this side via MCP — the operator does not paste anything by
hand).

---

## 1. What Genie is for

A Tynn user has multiple projects in flight. The web app is where
they think and plan. Genie is where they execute:

1. **Quick capture** — global hotkey pops a tiny window, types a
   thought, posts as a Wish on the current project. No tab needed.
2. **Workspace switching** — one click in the tray opens the right
   editor at the right folder with the right env loaded.
3. **Awareness** — tray badge + native notifications for things
   that need the user's attention (assigned wishes, blocked tasks,
   shipped releases).

Free for every Tynn tier. There is no FMS gate.

---

## 2. Identity

Genie users **sign in with their Tynn account.** Same email +
password as `tynn.ai`, or SSO via the same Socialite providers
(Google, GitHub, Facebook, Discord) already wired in `_app/`.

There is no Agent pairing. Genie holds a normal session token
issued by `_app` and acts as the user, the same way a browser tab
would. When session expires the user signs in again.

Reasons we are explicitly NOT using the Agent system:

- Agents are for *automated* clients (Claude Code, Cursor, custom
  MCP scripts). Genie is a human's desktop, not an autonomous one.
- A device key tied to an Agent would create a permission gap
  whenever the user wants to do something only their own role
  allows (delete a project, change billing, change visibility).
- One identity per user is simpler to reason about for audit.

A future BYOA (bring your own agent) mode might attach Agents
*through* Genie — i.e. Genie helps the user mint and rotate keys
for the agents they run locally — but Genie itself stays signed in
as the user.

---

## 3. Project workspace shapes

Genie supports two shapes. The user picks one when registering a
workspace; both have first-class support but the Aionima envelope
is the preferred long-term path.

### Shape A — Simple repo / monorepo

Point Genie at a folder that already exists on disk. It can be:

- A single git repo (`~/code/my-thing/`)
- A monorepo (`~/code/big-thing/` with `apps/`, `packages/`, etc.)
- Or even a non-git folder — workspace registration doesn't
  require git, only file system access.

The folder is treated as an opaque path: Genie launches the user's
editor at the path, opens a terminal at the path, loads the env
file from the path. Nothing more.

### Shape B — Aionima envelope (`{slug}.agi`) — **preferred**

Project lives at `<workspace_root>/<slug>/` and uses the layout
from `.ai/_discovery/project-agi-repo-prompt.md`:

```
<slug>/
├── project.json            ← shared config; both Genie and AGI gateway read/write
├── .gitmodules             ← submodule registry
├── repos/                  ← each subfolder is a git submodule of <slug>.agi
│   └── <repo>/
├── .ai/                    ← knowledge: plans, knowledge, pm, chat, memory, issues
│   ├── plans/              ← (renamed from k/ in v0.7 for cross-tool compat)
│   ├── knowledge/
│   ├── pm/
│   ├── chat/
│   ├── memory/
│   └── issues/
├── sandbox/                ← agent scratch space, kept out of repos/
└── .trash/                 ← soft-delete buffer
```

Properties:

- The envelope itself is a git repo. Its GitHub remote name is
  hard-conventioned to `{slug}.agi` — the `.agi` suffix is
  load-bearing because it tells anyone looking at the remote list
  that this is an envelope, not a project repo.
- Each `repos/<name>/` is a git submodule.
- `.ai/`, `sandbox/`, `.trash/` are tracked directly in the envelope
  (not submoduled). The legacy `k/` name is still accepted on import
  (the Interactive Upgrade scanner classifies it as a knowledge root
  and spreads its contents into `.ai/`); new envelopes always use
  `.ai/`.
- `project.json` is the shared config Genie + the AGI gateway both
  read and write. Unknown fields preserved on write.

Genie's responsibility for `.agi` envelopes:

- **Detect** — when a user opens a folder, decide whether it's a
  `.agi` envelope, a plain repo, or pre-init (see detection rules
  in the discovery doc).
- **Create new** — scaffold the skeleton, `git init`, write
  `project.json`, initial commit. Offer to push to
  `github.com/<owner>/<slug>.agi`.
- **Import existing** — walk `repos/` for git folders, add them
  as submodules, generate `project.json` from what's discovered.
- **Open** — `git submodule update --init --recursive` if the
  user just cloned a `.agi` repo and the `repos/` are empty.

Genie does not invent the Aionima layout; it implements the
contract from `project-agi-repo-prompt.md` so that either Genie or
the AGI gateway can open / create / work with a project folder
with no migration step in between.

---

## 4. Primary workspace + arbitrary locations

The user can configure a **primary workspace** path in Settings —
say `~/_projects/` — which becomes the default location when
Genie **creates** a new project (envelope or simple). Genie writes
to `~/_projects/<slug>/` unless the user overrides.

Beyond that, **projects can live anywhere on disk.** When the user
**adds** an existing workspace, Genie just accepts the path:

- `/Users/Glenn/work/clientA/repo-x` — fine.
- `D:\code\internal\stuff` — fine.
- `~/_projects/...` (primary) — fine.

Critically:

- **No auto-scanning.** Genie does not crawl the file system to
  discover projects. Every registered workspace was either created
  by Genie or added explicitly by the user (file picker or paste).
- Each workspace row stores its own absolute path. The primary
  workspace is just a default destination, not a constraint.

---

## 5. Architecture

### Stack

| Layer       | Choice                            | Why                                              |
| ----------- | --------------------------------- | ------------------------------------------------ |
| Shell       | Electron (via Nextron)            | Tray, global shortcuts, native notifications.    |
| Renderer    | Next.js 15 (export mode)          | Reuse the React stack from `_app/`.              |
| Local store | better-sqlite3                    | Single-file db for workspaces + sync state.      |
| HTTP        | fetch                             | Same-origin to `tynn.ai`, session-based.         |
| Git ops     | `simple-git` (or shell-out)       | Init, submodule add, remote push.                |
| Updates     | electron-updater                  | Standard.                                        |
| Packaging   | electron-builder                  | Signed MSI (Win) + notarised DMG (macOS).        |

### Process model

```
┌─ Electron main ─────────────────────────────────┐
│ tray icon, global shortcuts, BrowserWindow mgmt │
│ IPC router (typed contextBridge)                │
│ sqlite + filesystem ops + git ops               │
│ tynn-api client (session cookie via Electron's  │
│ default session)                                │
└─────────────────────────────────────────────────┘
       ↑
       │ typed IPC
       ↓
┌─ Renderer (Next.js) ─────────────────────────────┐
│ tray-window UI (project list + status)          │
│ settings window                                  │
│ quick-capture popup (frameless, always-on-top)   │
│ new-workspace wizard (simple vs `.agi`)          │
└──────────────────────────────────────────────────┘
```

Renderer is read-only across IPC for everything sensitive — file
system, git, sub-process spawning all live in main. Everything is
exposed via typed channels (`workspaces:list`, `workspaces:open`,
`workspaces:create`, `wishes:capture`, `auth:sign-in`, etc.).

### Auth

- First-run: a "Sign in to Tynn" window opens
  `https://tynn.ai/login?return=genie://oauth/callback`. The user
  signs in normally (password or SSO). On success the web app
  redirects to the Genie protocol; Electron picks it up, extracts
  the session token, and stores it.
- Session cookie persists in Electron's default `session`. All
  outbound calls to `tynn.ai` carry it automatically.
- Sign-out clears the cookie + any cached project list.
- On 401, Genie re-prompts the sign-in window.

### Workspace registry (local SQLite)

One row per registered workspace:

```jsonc
{
  "id": "01k7…",                  // matches Tynn project id
  "tynn_project_id": "01k7…",
  "tynn_project_name": "Brain v2",
  "shape": "agi",                  // "agi" | "simple"
  "path": "/Users/Glenn/_projects/brain", // absolute, anywhere
  "editor": "cursor",              // "cursor" | "vscode" | "custom"
  "editor_cmd": "cursor",          // resolved at register time
  "start_cmd": "npm run dev",      // optional
  "env_file": ".env",              // path relative to workspace
  "last_opened_at": "…",
  "created_by_genie": true         // true if Genie scaffolded; false if user imported
}
```

---

## 6. Folder layout (this repo)

```
genie/
├── PLAN.md                        # this file
├── README.md                      # short pitch + dev quickstart
├── package.json                   # nextron + electron
├── electron-builder.yml           # packaging
├── tsconfig.json
├── main/                          # Electron main
│   ├── background.ts              # lifecycle: tray init, window mgmt
│   ├── tray.ts                    # tray menu + click handlers
│   ├── shortcuts.ts               # global hotkeys
│   ├── ipc.ts                     # typed channel defs
│   ├── db.ts                      # sqlite wrapper
│   ├── tynn-api.ts                # HTTP client → tynn.ai
│   ├── auth.ts                    # sign-in flow, session storage
│   ├── notifications.ts           # native toasts
│   ├── workspace/
│   │   ├── open.ts                # launch editor + terminal + env
│   │   ├── create-simple.ts       # scaffold simple workspace
│   │   ├── create-agi.ts          # scaffold {slug}.agi envelope
│   │   ├── detect.ts              # envelope vs plain vs pre-init
│   │   └── project-json.ts        # read/write/merge project.json
│   └── git/
│       ├── init.ts                # git init + initial commit
│       ├── submodule.ts           # add / update --init --recursive
│       └── remote.ts              # create / set {slug}.agi remote
├── renderer/                      # Next.js renderer
│   ├── pages/
│   │   ├── tray.tsx               # main tray window
│   │   ├── settings.tsx           # primary workspace, hotkeys, etc.
│   │   ├── capture.tsx            # quick-capture popup
│   │   └── new-workspace/
│   │       ├── index.tsx          # shape picker (simple vs .agi)
│   │       ├── simple.tsx         # wizard for shape A
│   │       └── agi.tsx            # wizard for shape B
│   ├── components/
│   ├── lib/                       # IPC wrappers
│   └── styles/
└── resources/                     # tray icons, installer art
```

---

## 7. Decisions locked

| #  | Decision                                    | Choice                                                |
| -- | ------------------------------------------- | ----------------------------------------------------- |
| 1  | OSes                                        | Windows + macOS day-one. Linux later.                 |
| 2  | Auto-update                                 | On by default, user-confirmable.                      |
| 3  | Identity                                    | Tynn account (session cookie). NO agents.             |
| 4  | Free tier?                                  | YES — free on all Tynn tiers.                         |
| 5  | Primary workspace                           | Settable in Settings; default for new projects.       |
| 6  | Auto-scan disk?                             | NO. Every workspace is user-added or Genie-created.   |
| 7  | Project location                            | Anywhere on disk.                                     |
| 8  | Workspace shapes                            | Simple repo / monorepo OR `.agi` envelope (preferred).|
| 9  | Code signing                                | EV cert (Win) + Developer ID (macOS) day-one.         |

---

## 8. Story breakdown — v0.7.0

Stories are created in Tynn from this side. The summaries below
mirror what's been pushed; the actual Tynn entries are the canon.

### Story 1 · Scaffold Nextron + tray

Runnable shell on both OSes. `npx create-nextron-app genie`, prune
to the folder layout above, hello-world tray icon that opens a
BrowserWindow with the rendered Next.js page. README with
`npm run dev` / `npm run build`.

### Story 2 · Tynn account sign-in

OAuth-style flow opening the user's default browser at
`https://tynn.ai/login?return=genie://oauth/callback`. Web app
redirects to the Genie protocol; Electron picks it up, stores the
session in its default `session`. Sign-out clears the cookie.
401 re-prompts.

`_app/` work: add a `/genie/callback` view that finalises the
return-URL handoff. Honour the `return` param only for the
registered Genie protocol.

### Story 3 · Settings + primary workspace

UI for primary workspace path (file picker), default editor (drop-
down with auto-detected Cursor / VS Code / Code Insiders +
"custom"), default start command, default env file name, global
hotkey. Persist in SQLite.

### Story 4 · Workspace registry — SQLite + IPC

`main/db.ts` with the schema in Section 5. IPC channels:
`workspaces:list`, `workspaces:add`, `workspaces:update`,
`workspaces:remove`. Renderer table view.

### Story 5 · Add workspace (shape picker)

Two-shape wizard at the entry point:

- **Simple** — file picker → optional editor/start overrides →
  save row. No git interaction.
- **`.agi` envelope** — sub-wizard delegated to Story 6.

### Story 6 · Create `.agi` envelope

Implements the Aionima contract from
`.ai/_discovery/project-agi-repo-prompt.md`:

- Detection — given a folder path: empty / simple repo / pre-init
  (`repos/<name>/.git` but no root `.git`) / full `.agi` envelope.
- Auto-create — scaffold skeleton (`project.json`, `repos/`, `.ai/*`,
  `sandbox/`, `.trash/`), `git init`, initial commit. Offer to
  create `github.com/<owner>/<slug>.agi` remote via the user's
  GitHub credentials (if connected) or accept a manual paste URL.
- Import — walk `repos/`, register each git subfolder as a
  submodule, write `project.json` with discovered repos, commit.
- Open existing — `git submodule update --init --recursive` if
  `repos/` is empty after fresh clone.

`project.json` writes preserve unknown fields verbatim so the AGI
gateway and Genie can coexist.

### Story 7 · Open a workspace

Headline. One click on a workspace row spawns, in order:

1. Editor at the workspace path (`spawn(editor_cmd, [path])`).
2. Terminal at the workspace path (`wt`, `Terminal.app`,
   `gnome-terminal`) with the env file sourced.
3. (`.agi` shape only) — ensure `git submodule update --init` ran
   so `repos/` is populated before the editor sees an empty tree.

### Story 8 · Quick capture

Default hotkey `Ctrl+Shift+W`. Frameless 480×120 always-on-top
window with textarea + project picker (defaults to last-opened
workspace, then to primary). Enter posts to `/api/v1/wishes` via
the Tynn session; vanishes. Esc cancels.

### Story 9 · Tray awareness — badge + notifications

Tray badge count = wishes assigned to me + blocked tasks I own.
Native notifications for wish-created (others), task assigned,
story moved to QA, version released. Click → opens relevant Tynn
URL.

### Story 10 · Auto-update + signed installers

`electron-updater` wired to GitHub releases. `electron-builder`
config producing a signed MSI on Windows and a notarised DMG on
macOS. Release flow documented.

---

## 9. Cross-cutting

### Telemetry

Off by default. If on, three things ship: Genie version + OS,
daily counts of `wishes:captured` / `workspaces:opened`, crash
reports (paths + content scrubbed). Policy stated in Settings.

### Privacy

Workspace paths and editor configs stay on the device. Only Tynn
domain IDs leave the box.

### Cross-platform parity

- Windows: MSI installer, ICO tray icon, deep link via installer's
  protocol registration.
- macOS: DMG, ICNS icons (template variant for menu bar), deep
  link via `CFBundleURLTypes`.
- Linux: AppImage, deferred until Win + Mac are stable.

---

## 10. What does NOT belong in Genie

- A bundled IDE (Genie launches yours).
- A chat client (Tynn Chat in the web app stays canonical).
- Direct GitHub / Linear / Slack integration (Tynn talks to those).
- Agent pairing (this is Section 2 — Genie is the user, not an
  agent).
- An MCP server (the web app owns `/mcp/tynn`).

---

## 11. Out-of-scope future ideas

Filed as wishes on the Tynn side, not built in v0.7:

- Mobile companion (Genie Mini) using the same web-login flow.
- Per-project "do not disturb" hours.
- Genie renders the project's Lore feed as a morning digest.
- Workspace templates: a recipe that scaffolds repo + initial Tynn
  stories from a known template.
- Tray icon morphs into VIP red when any project has an active VIP.
- Genie helps the user mint + rotate Agent keys for the agents
  they run locally (this is the BYOA bridge — Genie itself stays
  human-identity).

# Settings

Open Settings from the **gear** icon in the title bar (or via the tray). The
Settings window is organised into sections.

## Primary workspace

The **default destination for new projects** created from Genie. Existing
projects can live anywhere — this is a default, not a constraint. Use **Browse**
to pick a folder.

## Default editor

The editor Genie opens files with externally. Genie auto-detects installed
editors (**Cursor**, **VS Code**, **VS Code Insiders**); pick one from the
dropdown, or choose **Custom executable** and point it at a binary (placeholder:
`cursor / code / path/to/binary`). **Browse** opens a file picker.

## Default terminal

The **shell** used when a terminal panel doesn't specify one. Genie detects the
shells on your machine; pick one, or choose **Custom executable** and supply a
full command line.

- **Executable line** (custom only): the full command, with paths quoted if they
  contain spaces — e.g. `"C:\Program Files\Git\bin\bash.exe" --login -i`
  (placeholder: `pwsh -NoLogo`).

Each terminal panel can still switch shells from its own toolbar.

### Keep terminals running after quit

A toggle: **"Keep terminals running after quit"** (default **off**). When on,
Genie runs terminals in a **detached background process** so dev servers and
shells **survive a full quit** and reattach on next launch.

> Experimental. If the background process can't start, Genie falls back to
> in-process terminals — which still restore from a snapshot, but don't survive
> a full quit. See **[Terminal session persistence](05-session-persistence.md)**.

## Specialized terminals

The launch command and always-on flags for each AI-agent terminal type:

- **Claude Code command** / **Codex command** / **Custom agent command** — the
  command run when you add a terminal of that type. Blank uses the built-in
  default (`claude`, `codex`).
- **Claude Code extra flags** / **Codex extra flags** — flags always appended
  when launching that agent (for example `--dangerously-skip-permissions`),
  before Genie's own `--session-id`.

See **[Terminals → Terminal types](04-terminals.md)**.

## Agent MCP server

A small **loopback MCP server** that lets agents in your terminals reach you —
glow the sidebar when done (`imDone`), pop a question (`ForceTheQuestion`),
manage processes, and more (see **[Agents & the Genie MCP](12-agents-and-mcp.md)**).
The section shows the live server status (running / port conflict / not running)
and offers:

- **Server port** — a fixed, obscure loopback port baked into each workspace's
  `.mcp.json` (e.g. `51717`). Changing it needs a restart; open terminals keep
  their old endpoint until recreated.
- **Restart MCP server** — rebinds on the configured port and rewrites the
  enabled workspaces' configs.
- **Config sync** — keep the Genie endpoint written into your agent configs:
  **Claude** (`.mcp.json`), **Cursor** (`.cursor/mcp.json`), and **AGENTS.md**
  (the Genie brief block). Unchecking one leaves that file alone.

## Workspace layout — Max views

**Max views** — the maximum number of panels visible at once *per workspace*
(default **4**, range **1–9**). Reaching the limit disables the Add Terminal /
Add Files buttons until you raise it or close a view.

## Defaults for new workspaces

- **Start command** — a default start command for new workspaces.
- **Env file name** — the default env-file name for new workspaces.

## Quick capture hotkey

**Accelerator** — a global hotkey to pop the quick-capture window, given as an
Electron accelerator string, e.g. `CommandOrControl+Shift+W`. See
**[Sign in & integrations → Quick capture](10-sign-in-and-integrations.md)**.

## Startup

**Launch at sign-in** — a toggle. When on, Genie starts hidden in the tray every
time you sign in; click the tray icon to open the window. It's backed by your
OS's native mechanism:

- macOS — login items
- Windows — a Run-at-startup registry entry
- Linux — `~/.config/autostart/genie.desktop`

> Dev builds can't register a stable autostart path — install the packaged
> release to use this.

## Serve local dev sites (.gen)

- **Serve local dev sites** — a master toggle (off by default). Lets this host
  expose its loopback dev sites (e.g. `tynn.test`, served by Herd/Valet) to a
  remote Genie as `*.gen`. A separate opt-in from remote control.
- **.gen Sites** — per workspace, choose which of this machine's loopback dev
  sites are served, each with a `.gen` name and scheme/port. Nothing is
  tunnelled until you enable a site here. See
  **[.gen dev sites & the Testing Browser](18-dev-sites.md)**.

## Integrations & more

The Settings window also hosts the **Tynn**, **Aionima**, and **GitHub** sign-in
sections, the **Updater** configuration, and more — covered on their own pages:

- **[Sign in & integrations](10-sign-in-and-integrations.md)** — Tynn, Aionima,
  GitHub, and quick capture.
- **[Updates](09-updates.md)** — the Updater section.
- **[Plugins & marketplaces](11-plugins.md)** — the **Plugins** section
  (installed plugins, capability grants, the Official + Marketplaces tabs, and
  Developer Mode).
- **[Agents & the Genie MCP](12-agents-and-mcp.md)**,
  **[Hosts & Genie Cloud Workstations](17-hosts-and-workstations.md)** — remote
  control and cloud settings live alongside these features.

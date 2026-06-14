# Workspaces

A **workspace** is a folder you work in. Each workspace owns its own terminals
and editors, and Genie keeps them organised in the left sidebar (the
**chooser**).

## The sidebar: icon rail + flyout

The sidebar has two parts:

- **Icon rail** (always visible, narrow): one icon per workspace, plus a pin
  toggle at the top and an **Add workspace…** (`+`) button at the bottom. The
  icon reflects the workspace type:
  - **Box** icon — an `.agi` envelope.
  - **CPU** icon — an Aionima-backed workspace.
  - **Globe** icon — a plain / desktop / Tynn workspace.
  - A small **green badge** with a count appears when a workspace has live
    terminals running.
- **Flyout panel** (the "Terminals" panel): titled *"Terminals — Pick from any
  project"*. It lists each workspace as a collapsible group with its terminals,
  a search box, and **Add Terminal…** / **Add Editor…** buttons per workspace.

## Adding a workspace

Click **Add workspace…** in the icon rail (or in the flyout), then pick a
folder. Genie analyses the folder and registers it. The folder on disk is never
modified just by adding it.

## Switching the active workspace

Click a workspace icon in the rail, or its name in the flyout, to make it the
**active workspace**. The toolbar shows the active workspace name with a green
dot (or *"No active workspace"* when none is active).

Switching the active workspace re-selects that workspace's enabled terminals
into the view grid.

> **Off-workspace terminals keep running.** When you switch away, the previous
> workspace's terminals are not killed — they're kept mounted but hidden, so
> their processes (dev servers, watchers, etc.) keep running in the background.
> Switch back and they're exactly where you left them.

## Pinning the tree (flyout)

The chooser flyout can be **pinned** (always open) or **unpinned** (hovers on
demand and closes when you click away or press Escape).

- Toggle with the pin button at the top of the sidebar.
- Or press **⌘/Ctrl + \\** to toggle pin from anywhere.

Titles: *"Pin terminals panel"* / *"Unpin terminals panel"*.

## `.agi` envelopes — detect, create, convert, import

Genie has first-class support for **Aionima-format `.agi` envelopes** —
project folders structured with `README.md`, `AGENTS.md`, `CLAUDE.md`, a
`project.json`, and (often) git submodules under `repos/`.

- **Detect.** When you add a folder, Genie detects whether it's already an `.agi`
  envelope and shows the box icon if so.
- **Create.** Genie can scaffold a brand-new `.agi` envelope (this is where a
  connected GitHub account is used to create the backing repository).
- **Convert.** An existing plain folder can be converted into an `.agi` envelope.
  Genie first runs an analysis pass and shows a plan before changing anything.
- **Import.** An existing `.agi` repository can be imported as a workspace.

### Envelope health

For `.agi` workspaces, the chooser may show an **amber alert dot** when the
envelope is missing standard docs or its MCP config needs consolidating. The
alert popover offers one-click fixes:

- **Add docs, commit & push** — scaffolds the missing `README.md` / `AGENTS.md`
  / `CLAUDE.md` and pushes them.
- **Consolidate MCP config** — tidies the envelope's MCP configuration.

These are conveniences for keeping an envelope tidy; they only touch the
envelope's own metadata files.

## Workspace context menu

**Right-click a workspace** header in the flyout for project actions:

- **Open in Stage** — pops the workspace out into its own dedicated window.
- **Add Terminal** — adds a terminal to this workspace.
- **Open project in browser** — opens the project's dashboard in your browser
  (uses the workspace's backend).
- **Remove from Genie** — removes the workspace from Genie. *The folder on disk
  is not touched.* Any terminal specs attached to it become unattached.

## Removing a workspace

Use **Remove from Genie** in the workspace context menu. You'll get a
confirmation: *"The folder on disk is not touched. Any terminal specs attached
to it will become unattached."* Removing is safe — it only forgets the folder
inside Genie.

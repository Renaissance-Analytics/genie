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

## Workspace layout — Max views

**Max views** — the maximum number of panels visible at once *per workspace*
(default **4**, range **1–9**). Reaching the limit disables the Add Terminal /
Add Editor buttons until you raise it or close a view.

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

## Integrations

The Settings window also hosts the **Tynn**, **Aionima**, and **GitHub** sign-in
sections, and the **Updater** configuration. Those are covered on their own
pages:

- **[Sign in & integrations](10-sign-in-and-integrations.md)**
- **[Updates](09-updates.md)**
- **[Plugins & marketplaces](11-plugins.md)** — the **Plugins** section
  (installed plugins, capability grants, the Official + Marketplaces tabs, and
  Developer Mode).

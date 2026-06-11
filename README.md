# Genie

The Tynn desktop companion. A tray-resident workspace + terminal
manager for projects you track in [Tynn](https://tynn.ai) and (later)
sessions you run against an [Aionima](https://github.com/Civicognita/agi)
local AGI gateway.

> **Status:** alpha. Public so developers can audit what the binary
> does on their machine and contribute back. Expect rapid iteration.

## What Genie is

- **TheFloor** — a cross-project window with a tree of every terminal
  you've defined, organised by workspace, with adaptive grid layouts
  (1 = full, 2 = split, 3 = focus-stack, 4 = grid). Terminals are real
  PTYs (xterm.js + node-pty), so they run TUI apps like `claude code`,
  `vim`, `htop` cleanly.
- **Stage windows** — satellite workspace windows pinned to a single
  project, sharing live PTYs with TheFloor so you can mirror a running
  shell to a second monitor.
- **Workspace upgrades** — wrap an existing folder (or a folder full
  of sub-repos) as an Aionima `{slug}.agi` envelope: each sub-repo
  becomes a git submodule under `repos/`; loose knowledge folders
  (`plans/`, `docs/`, `k/`, etc.) migrate into `.ai/`.
- **GitHub Device Flow** — connect a GitHub account once, then create
  `.agi` envelopes directly on GitHub under your user or any org you
  belong to. No client secret stored anywhere — Device Flow + OS
  keychain (`safeStorage`).

## Install

### End-user install (signed installers)

Download the installer for your platform from
[Releases](https://github.com/Renaissance-Analytics/genie/releases):

- **Windows:** `Genie-Setup-<version>.exe`
- **macOS:** `Genie-<version>.dmg` (signed + notarised)
- **Linux:** `Genie-<version>.AppImage`

Auto-update is handled by `electron-updater` — once installed, Genie
polls Releases on launch and prompts you when a newer build is
available.

> Installers are produced by [CI](.github/workflows/release.yml) on
> every `v*` tag. If a release doesn't have signed installers yet,
> you can either wait for the next signed cut or fall back to the
> developer install below.

### Developer install

You need **Node.js ≥ 20**, **npm**, and **git**.

```bash
git clone https://github.com/renaissance-analytics/genie.git
cd genie
npm install
npm run dev
```

On Windows, native modules (`node-pty`, `better-sqlite3`) ship with
prebuilt binaries for common Electron ABIs. If `npm install` complains
about Visual Studio Build Tools, the prebuilds are usually still
enough for development — install Build Tools only if you need to
package a release locally.

In dev mode the updater path is the **Phase 1 git-pull-and-rebuild**
flow (Settings → Updates), which runs `git fetch && git checkout
<tag> && npm install && npm run build` in-place.

## Project layout

```
genie/
├── main/                  ← Electron main process
│   ├── background.ts      ← boot, window factory
│   ├── terminal/          ← PTY manager (multi-attach, scrollback)
│   ├── workspace/         ← .agi envelope create / convert / analyse
│   ├── github/            ← Device Flow OAuth + repo API
│   └── updater/           ← git-pull-and-rebuild updater
├── renderer/              ← Next.js 15 renderer
│   ├── pages/master.tsx   ← TheFloor
│   ├── components/Master/ ← chooser, grid, panels, context menus
│   └── components/Terminal/XTerm.tsx
├── docs/
│   └── agi-format.md      ← public `.agi` envelope contract
└── test/                  ← Vitest unit tests
```

## How updates work

Genie picks the right updater path automatically:

### Packaged installs → `electron-updater` (Phase 2)

When you run a signed installer from Releases, the running Genie polls
its publish provider (GitHub Releases) for newer versions, downloads
the new installer in the background, verifies the SHA-512 checksum
recorded in `latest.yml`, and prompts you to restart. The restart
swaps the binary atomically via the installer's own mechanism.

### Developer installs → git-pull + rebuild (Phase 1)

When you ran `git clone && npm install && npm run dev`, the updater
detects you're not a packaged build and switches to the Phase 1 flow.
Settings → Updates shows the same UI but executes:

```
git fetch origin --tags
git checkout <new-tag>
npm install
npm run build
```

Output streams into the Updates panel; on success you're prompted to
restart. On failure the previous `HEAD` is restored.

The same Settings panel UI handles both — the backend is selected by
`app.isPackaged`.

## Architecture notes

- **TheFloor is a single window.** What looked like separate "tray
  window / settings / workspace" surfaces in the early scaffold all
  collapse into TheFloor's sidebar + Settings modal. Stage windows are
  the only multi-window path, and they share PTYs with TheFloor via a
  multi-attach pty manager.
- **Multi-attach PTYs.** The `TerminalManager` lets a single pty be
  rendered in N windows simultaneously. A scrollback buffer (1 MB cap)
  replays history to a late-joining window so a Stage that opens a
  terminal already running in TheFloor catches up instantly.
- **Persistent terminal specs.** Each terminal is a row in SQLite
  (`terminal_specs` table). Specs survive restart; the PTY itself does
  not (we re-spawn from the spec when you reopen).
- **Native deps are prebuilt-first.** `node-pty` and `better-sqlite3`
  ship Windows + macOS prebuilds. `postinstall` runs
  `electron-builder install-app-deps || echo "skipped"` so a dev
  install on a machine without compilers still works.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). PRs welcome — anything from
shell-detection fixes to new layout modes to TUI compatibility bug
reports.

## Security

If you find something that looks like a security issue,
**don't open a public issue**. See [SECURITY.md](SECURITY.md) for the
private disclosure path.

## Licence

[MIT](LICENSE).

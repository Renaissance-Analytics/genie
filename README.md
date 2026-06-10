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

You need: **Node.js ≥ 20**, **npm**, **git**.

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
package a release.

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

## How updates work (Phase 1)

Genie polls the GitHub Releases / Tags API on the configured repo. When
a newer tag is available, you see a small indicator in TheFloor's title
bar. Click **Update now** in Settings → Updates and Genie runs:

```
git fetch origin --tags
git checkout <new-tag>
npm install
npm run build
```

Output streams into the Updates panel so you can watch it. On success
you're prompted to restart Genie. On failure the old version stays
intact and the error is shown.

Phase 2 (planned): swap to `electron-updater` with signed installers
distributed via GitHub Releases. The Phase 1 git-rebuild updater
remains useful for tracking trunk if you want to live on tip.

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

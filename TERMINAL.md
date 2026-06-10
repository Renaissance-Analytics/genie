# Genie multi-terminal — design + scaffolding state

Genie hosts an embedded terminal subsystem capable of running TUI apps
(Claude Code, vim, fzf, htop, anything ANSI-aware) inside its own
window. Each terminal is a real pseudo-terminal owned by Genie's main
process, rendered by `xterm.js` in the renderer, with I/O bridged via
IPC.

This doc covers what's already scaffolded and the open UX questions
that need to land before the feature can ship to users.

## What's wired today

### Main process
- `main/terminal/manager.ts` — `TerminalManager` singleton. Owns every
  active pty in a `Map<id, IPty>`. Emits `data` and `exit` events
  scoped by id. Methods: `create`, `write`, `resize`, `kill`,
  `killAll`, `list`. Default shell is `COMSPEC` on Windows, `$SHELL`
  on POSIX; sets `TERM=xterm-256color` on every spawn so TUI apps
  pick the rich path.
- `main/terminal/ipc.ts` — IPC bridge. Channels:
  - `terminal:create(opts) → TerminalInfo`
  - `terminal:write(id, data) → boolean`
  - `terminal:resize(id, cols, rows) → boolean`
  - `terminal:kill(id) → boolean`
  - `terminal:list() → TerminalInfo[]`
  - Push events: `terminal:data {id, data}`, `terminal:exit {id, exitCode, signal}`
  Ownership tracked per `webContents`; if the owning frame is
  destroyed, every pty it created is killed automatically.
  `app.on('before-quit', stopAllTerminals)` reaps anything still
  alive on shutdown.

### Preload bridge
- `genie.terminal.{create, write, resize, kill, list}` — typed.
- `genie.on.terminalData(cb)` / `genie.on.terminalExit(cb)` — subscribe
  to data/exit events, returns an unsubscribe.

### Renderer
- `renderer/components/Terminal/XTerm.tsx` — one component per pty.
  Wires xterm.js (with FitAddon + WebLinksAddon) to the IPC bridge.
  Resize is driven by `ResizeObserver` on the host element, so
  whatever container the component sits in dictates the terminal
  dimensions. Cleanup on unmount: kills the pty and disposes the
  xterm instance.
- `renderer/pages/terminal.tsx` — **developer-only smoke route**.
  Opens a single terminal at the user's home directory. Hit
  `/terminal` while Genie is running in dev to verify the pipeline
  end-to-end. Not linked from any user-facing menu yet.

### Dependencies
- `node-pty` — Windows + macOS prebuilds ship with the npm package;
  Linux either picks up a prebuild or rebuilds via `node-gyp`.
- `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`.
- `electron-builder install-app-deps` is now non-fatal in
  `postinstall` so installs still work on Windows without VS Build
  Tools (the prebuilds carry us through dev). Release builds with
  signed installers will still need a build environment with a real
  compiler.

## Open UX questions

These haven't been resolved and they all gate user-facing shipping.
Each option is reversible later — pick whichever is closer to "ship a
slice today."

### Q1. Where does the terminal live?
Three reasonable layouts:

- **Per-workspace window** — clicking Open on a workspace row spawns
  a new BrowserWindow that contains the terminal(s) for that
  workspace. Tray window stays small. Pros: clean separation, easy
  to close one workspace without touching others. Cons: more chrome,
  alt-tab between projects.
- **Tabs inside the main tray window** — tray window expands to show
  tabs for each open workspace, terminals inside each tab. Pros: one
  window, less OS clutter. Cons: tray window is currently 480x640;
  needs a real resize first.
- **Hybrid** — small tray window stays as launcher; click Open →
  spawns a dedicated workspace window with terminals + editor
  integration. Closest to what people expect from VS Code.

### Q2. Multiple terminals per workspace?
- One pty per workspace, full stop (simplest)
- Tabs of terminals inside a workspace (`Ctrl+Shift+T` style)
- Split panes (one terminal running `claude code`, another running
  `npm run dev`, etc.)

`xterm.js` supports any of these — it's purely a layout question.

### Q3. Does Genie launch the external editor too?
Today's openWorkspace launches VS Code + an external `wt` terminal.
With embedded terminals, options:

- **Keep external editor, embed terminal** — Genie acts as the
  terminal multiplexer for a workspace, editor still runs in its own
  process. Lightest change.
- **Embed both** — Genie hosts the editor too (e.g. Monaco). Big
  scope expansion.
- **Embed only** — drop the editor launch entirely; Genie is a
  terminal-only workspace shell. Wrong for most users.

### Q4. Persistence
Should terminals survive Genie restart?

- **No** — ptys die with main process, restart spawns fresh. Simplest.
- **Yes (rehydrate)** — keep scrollback buffers + spawn args in
  SQLite, re-spawn on next launch. Real shells can't truly be
  resumed (the running process is gone) but recently-typed commands
  + cwd can be remembered.
- **Yes via mux** — wrap each pty in `tmux` / `zellij` so detach +
  reattach is free. Adds an OS dep (tmux).

### Q5. Claude Code specifically
Anything special needed? `claude` is just a TUI binary — it should
work in any xterm-256color pty with no special handling. Worth
confirming once the smoke route runs end to end.

## What to do next session

1. Run `npm run dev` in `genie/` and navigate to `/terminal` (the
   dev server picks it up automatically since it's a Next.js page).
   Verify a real shell prompt appears, `cd`/`ls` work, ANSI colors
   render. Try `claude code` if you have it on `PATH` — that's the
   acceptance test.
2. Pick answers for Q1–Q4.
3. Either:
   - Build the workspace window per Q1's answer and wire `XTerm`
     into it, OR
   - Replace the `wt`-launch path in `openWorkspace` with an
     in-Genie terminal (depending on Q3).

## Files touched in this scaffolding pass

```
genie/main/terminal/manager.ts                          (new)
genie/main/terminal/ipc.ts                              (new)
genie/main/terminal/__tests__/manager.test.ts           (new)
genie/main/background.ts                                (register IPC + kill on quit)
genie/main/preload.ts                                   (expose terminal + terminalData/Exit)
genie/renderer/components/Terminal/XTerm.tsx            (new)
genie/renderer/pages/terminal.tsx                       (new, dev smoke route)
genie/renderer/lib/genie.ts                             (typed bridge entries)
genie/scripts/pty-smoke.mjs                             (standalone PTY check)
genie/package.json                                      (deps + non-fatal postinstall)
genie/TERMINAL.md                                       (this file)
```

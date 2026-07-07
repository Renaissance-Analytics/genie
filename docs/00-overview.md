# Welcome to Genie

Genie is a **backend-agnostic desktop companion for agentic engineering** — a
tray-resident window that gives every project you work on its own set of live
terminals, coding agents, and file editors, all in one place. It signs in to
your work backend (Tynn or Aionima) so you can jump from a shell straight to
your project management.

## What Genie is for

- **One window, many workspaces.** Add the folders you work in as *workspaces*.
  Each workspace gets its own terminals and editors; switch between them from
  the sidebar without losing anything that's running.
- **A home for agents.** Launch Claude Code, Codex, or your own agent right in a
  terminal, give each one a purpose, and let them talk to each other and reach
  *you* through Genie — glowing the sidebar when they're done or popping a
  question when they're blocked.
- **Terminals that survive.** Genie keeps your shells alive across workspace
  switches, and (optionally) across a full quit of the app. Dev servers and
  long-running tasks don't get killed just because you closed the window.
- **A built-in editor.** Browse and edit files in any workspace with a fast
  tree + code editor, complete with git-status colouring — no need to alt-tab
  to a separate IDE for a quick change.
- **Reach beyond this machine.** Connect to another machine's Genie over your
  tailnet, or to a Genie Cloud Workstation, and drive its terminals and files as
  if they were local.
- **Signed in to your work.** Connect Tynn or Aionima to capture wishes and
  reach your projects, and connect GitHub to create `.agi` repositories and
  watch their issues, PRs, and Dependabot alerts.

## The big picture

```
Tray icon  ──►  Genie window
                 ├── Sidebar (the "chooser")   pick / add workspaces + terminals
                 ├── View grid                 terminals + agents + Files, tiled
                 ├── Toolbar                    layout, add views, active workspace
                 └── Title bar                  Knowledge Graph · WhisperChat ·
                                                Task Manager · Issue Watch ·
                                                .gen sites · Hosts · update pill ·
                                                Docs · Settings
```

Genie lives in your system tray. Closing the window **hides** it rather than
quitting — click the tray icon to bring it back. To actually quit, use the
tray menu or the app menu's Quit.

## Where to go next

- **[Getting started](01-getting-started.md)** — add your first workspace and
  open a terminal.
- **[Workspaces](02-workspaces.md)** — the sidebar, switching, `.agi` envelopes.
- **[Terminals](04-terminals.md)** — plain shells and agent terminals (Claude
  Code, Codex, Custom).
- **[Agents & the Genie MCP](12-agents-and-mcp.md)** — how your agents reach you.
- **[Keyboard shortcuts](07-keyboard-shortcuts.md)** — the handful of keys that
  make Genie fast.

> This documentation describes the actual current behaviour of the app. If
> something here doesn't match what you see, you may be on a newer or older
> build — check **Help → Genie vX.Y.Z** for your version.

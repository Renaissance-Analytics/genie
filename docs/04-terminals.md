# Terminals

Genie terminals are real shells (PTYs) running in your workspace folder. This
page covers creating, focusing, closing, and **suspending** a terminal. For how
terminals survive a quit or an update, see
**[Terminal session persistence](05-session-persistence.md)**.

## Creating a terminal

Any of these create a terminal in the active (or chosen) workspace:

- **Add Terminal** in the toolbar split button.
- The **Add Terminal** tile in an empty grid.
- **Add Terminal…** under a workspace in the chooser flyout.
- **Add Terminal** in a workspace's right-click context menu.

Each terminal gets an auto-generated label (e.g. `myproject`, `myproject-1`)
and opens rooted at the workspace folder.

## Terminal types (specialized terminals)

The **Add Terminal** button's chevron opens a menu of terminal types. The main
button repeats the **last type you used**, so the common case is one click.

| Type | What it launches |
|------|------------------|
| **Terminal** | A plain shell. |
| **Claude Code** | The Claude Code TUI (a coding agent). |
| **Codex** | The Codex TUI (a coding agent). |
| **Custom agent** | Your own agent command. |

Picking a plain **Terminal** creates it immediately. Picking an agent type opens
a short form first:

- **Purpose** — a few words describing what this agent is for (e.g. `frontend`).
  Genie kebab-cases it and uses it to name the agent's chat channel, shown live
  as `‹workspace›:‹purpose›`. Agents talk to each other on these channels — see
  **[WhisperChat](13-whisperchat.md)**.
- **Who can reach this agent** — the agent's discoverability for WhisperChat:
  - **None — hidden** — no other agent can find or message it.
  - **This workspace (default)** — agents in the same workspace can reach it.
  - **Specific workspaces** — the ones you tick, plus its own.
  - **All — whole workstation** — every agent on this machine.
- **Command** — *(Custom agent only)* the command to run, e.g.
  `my-agent --interactive`.

Click **Create** to launch. Agent terminals otherwise behave exactly like plain
ones — same focus, hide, suspend, close, and session-restore behaviour below.

> **Command & extra flags.** Each agent type's launch command and its
> **always-on extra flags** (for example `--dangerously-skip-permissions`) are
> set once in **Settings → Specialized terminals** — they apply to every terminal
> of that type. A **Custom agent**'s command can still be overridden per terminal
> in the create form above.

## Shells

A terminal uses your **default shell** unless it specifies its own. Set the
default in **Settings → Default terminal** (a detected shell, or a custom
command line). See **[Settings](08-settings.md)**.

When more than one shell is available, a **shell bar** appears in the terminal
so you can switch shells per panel. Switching shells kills the old shell and
starts the chosen one; the choice is remembered on that terminal.

## Focusing a terminal

**Click a panel** to focus it — keyboard input then goes to that terminal. Genie
doesn't bind a keyboard shortcut for panel focus, because a focused terminal
(shell or agent TUI) would swallow it. See
**[Keyboard shortcuts](07-keyboard-shortcuts.md)**.

## Hide from grid (keeps the terminal running)

Each terminal's row in the chooser has an **eye toggle** on the left:

- **Eye open** (*"Hide from grid"*) — the terminal is showing in the grid. Click
  to **hide** it: the panel leaves the grid but **the shell and any agent keep
  running**. The row stays in the chooser with the eye now closed.
- **Eye closed** (*"Show in grid"*) — click to bring the panel back.

Hiding is the safe way to declutter the grid without losing anything: an agent
you've hidden **keeps working**. (Clicking a hidden terminal's row also shows it
again.)

## Closing a terminal

Click the **✕** button in the panel header (*"Close panel"*). Closing removes the
panel from the grid and detaches it. When the last window holding that terminal
detaches, the shell is shut down — **unless** the terminal is suspended or
detached (see below and **[session persistence](05-session-persistence.md)**).

> **Hide vs close.** *Hiding* (the eye toggle) keeps the terminal and its agent
> alive; *closing* (the ✕) tears the panel down and, on the last detach, ends the
> shell. Reach for **hide** when you just want it out of sight.

To delete a terminal entirely (remove its saved spec and kill the shell),
right-click it in the chooser and choose **Delete terminal**.

## Suspend / re-enable (Tier 2)

**Suspending** hides a terminal's panel but **keeps its shell alive and
running** in the background while Genie is open. It's the right move for a dev
server you don't need to watch but don't want to kill.

- **Suspend:** click the **pause** button in the panel header
  (*"Suspend — keep running, hide panel"*) or the pause icon on the terminal's
  row in the chooser. The panel disappears from the grid.
- The terminal's row in the chooser shows a **Suspended** badge
  (*"Suspended — pty still running"*) instead of its host badge, and the pause
  icon becomes a **play** icon.
- **Re-enable / resume:** click the **play** button on the row
  (*"Resume — reattach to the live session"*). The panel comes back and
  reattaches to the **live** shell — your running process and scrollback are
  intact. If the suspended terminal belongs to a different workspace, resuming
  switches to that workspace.

### The suspend cap

There's a limit on how many terminals can be kept running while suspended
(retained). If you try to suspend past the cap, Genie refuses and tells you to
re-enable or delete one first. Resuming is also blocked if it would exceed your
**Max Views** limit for the workspace — you'll see
*"Max views reached (N) — raise it in Settings"*.

## Terminal context menu

**Right-click a terminal** row in the chooser for:

- **Add to view / Remove from view** — toggle it in the grid.
- **Open in new window** — pop the terminal into its own window.
- **Rename…** — give it a friendlier name.
- **Duplicate** — make a copy (`<name>-copy`).
- **Move to project** / **Detach (no project)** — re-home the terminal.
- **Delete terminal** — *"Its saved spec is removed and any running shell is
  killed."*

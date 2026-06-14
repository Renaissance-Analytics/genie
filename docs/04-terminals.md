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

## Shells

A terminal uses your **default shell** unless it specifies its own. Set the
default in **Settings → Default terminal** (a detected shell, or a custom
command line). See **[Settings](08-settings.md)**.

When more than one shell is available, a **shell bar** appears in the terminal
so you can switch shells per panel. Switching shells kills the old shell and
starts the chosen one; the choice is remembered on that terminal.

## Focusing a terminal

Click a panel to focus it, or press **⌘/Ctrl + 1…9** to focus panel *N*.
Keyboard input goes to the focused terminal. (Genie's global shortcuts are
careful not to steal keystrokes from an active terminal — see
**[Keyboard shortcuts](07-keyboard-shortcuts.md)**.)

## Closing a terminal

- Click the **✕** button in the panel header (*"Close panel"*), or
- Press **⌘/Ctrl + W** with the panel focused.

Closing removes the panel from the grid and detaches it. When the last window
holding that terminal detaches, the shell is shut down — **unless** the terminal
is suspended or detached (see below and
**[session persistence](05-session-persistence.md)**).

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

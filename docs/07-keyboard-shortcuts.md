# Keyboard Shortcuts

Genie keeps a **deliberately small** set of keyboard shortcuts. Most of your
keystrokes belong to whatever is running *inside* a terminal — a shell, an
editor, or a coding agent's TUI — and Genie is careful not to steal them. So
rather than a long list of chords that a focused terminal would swallow anyway,
Genie wires only the few keys that are safe and useful everywhere.

On macOS use **⌘ (Command)**; on Windows and Linux use **Ctrl**.

| Shortcut | Where it works | Action |
|----------|----------------|--------|
| **⌘/Ctrl + ,** | Anywhere in the window | Open **Settings**. Works even while a terminal is focused. |
| **⌘/Ctrl + S** | A focused **Files** panel | Save the active file (or plugin tab). |
| **Quick-capture hotkey** | System-wide (global) | Pop the **Capture a wish** window. Default **Ctrl + Shift + W** (⌘ + Shift + W on macOS); change it in Settings. |
| **Esc** | An open flyout / dialog | Close the flyout (Docs, AgentInbox, Task Manager, Issue Watch…) or dismiss the current dialog. |

## The quick-capture hotkey

The one **global** shortcut — it works even when Genie is hidden in the tray. It
opens a small always-on-top window to jot a wish into a project without switching
context. Inside that window:

- **Enter** sends the wish (**Shift + Enter** for a newline).
- **Esc** cancels and hides the window.

Set the accelerator in **Settings → Quick capture hotkey** (an Electron
accelerator string such as `CommandOrControl+Shift+W`). See
**[Sign in & integrations](10-sign-in-and-integrations.md)**.

## Saving files

**⌘/Ctrl + S** saves the file in the **focused Files panel** — the same as
clicking the panel's **Save** button. It works for plain text tabs and for
plugin editor tabs (Sheets, Slides, Document) alike. See the
**[Files panel](06-files.md)**.

## Why so few?

Genie is a home for **live terminals and agents**. A focused terminal (a shell,
`vim`, or a Claude Code / Codex TUI) legitimately claims almost every key combo,
so a window-level shortcut layered on top would be unreliable — it might fire, or
the terminal might eat it first. Genie therefore avoids advertising shortcuts it
can't honour.

> **Note for long-time users:** earlier builds showed panel shortcuts
> (⌘/Ctrl + 1–9 to focus a panel, ⌘/Ctrl + \\ to pin the tree, ⌘/Ctrl + W to
> close a panel) and a status-bar hint for them. Those were **removed** — a
> focused terminal swallowed them, so they misled more than they helped. Use the
> mouse for those actions instead: click a panel to focus it, click the pin
> button to pin the sidebar, and click a panel's **✕** to close it. See
> **[Views & layouts](03-views-and-layouts.md)** and **[Terminals](04-terminals.md)**.

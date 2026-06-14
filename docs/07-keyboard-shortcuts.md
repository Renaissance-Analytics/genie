# Keyboard Shortcuts

Genie has a small, focused set of global shortcuts. On macOS use **⌘
(Command)**; on Windows and Linux use **Ctrl**.

| Shortcut | Action |
|----------|--------|
| **⌘/Ctrl + 1 … 9** | Focus panel **1–9** in the active workspace grid. No-op if that panel doesn't exist. |
| **⌘/Ctrl + \\** | Pin / unpin the terminals tree (the chooser flyout). |
| **⌘/Ctrl + S** | Save the file in the focused **Editor**. |
| **⌘/Ctrl + W** | Close (deselect) the focused panel. No-op if nothing is focused. |

You'll also see these hints in the status bar at the bottom of the window:
*"⌘1–9 focus · ⌘\\ pin tree · ⌘W close panel"* (Ctrl on Windows).

## How the shortcuts behave around text

The focus / pin / close shortcuts are deliberately polite:

- They require **exactly one** of Ctrl or Cmd (never with **Alt**), and they
  **ignore Shift** — so combinations like Ctrl+Shift+1 won't trigger them.
- They **don't fire** while you're typing in a real text field (an `<input>`,
  `<textarea>`, or contenteditable) — so they won't hijack your typing.
- They **do** work while a terminal is focused: the terminal's own input area is
  exempted from the "text entry" guard, so ⌘/Ctrl + 1–9, ⌘/Ctrl + \\, and
  ⌘/Ctrl + W still reach Genie even with a terminal active.

## A note on ⌘/Ctrl + W

Genie hands **⌘/Ctrl + W** to the renderer so it **closes the focused panel**,
not the whole window. The app menu's **Window → Close Window** item exists but
has *no* keyboard accelerator, precisely so it doesn't steal **W** from the
panel-close behaviour. To close the window itself, use that menu item (or the
window's own close control — which hides Genie to the tray).

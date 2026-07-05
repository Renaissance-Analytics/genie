# Getting Started

This page walks you from a fresh launch to your first running terminal and
editor.

## 1. Open Genie

Genie runs in your system tray. Click the tray icon to open the main window.
If the window is already open, the tray icon brings it to the front.

> Closing the window doesn't quit Genie — it just hides it back to the tray.
> Your terminals keep running.

## 2. Add a workspace

A *workspace* is just a folder you work in. To add one:

1. In the left **icon rail**, click the **Add workspace…** button (the `+` at
   the bottom of the rail). You can also open the chooser flyout and click
   **Add workspace…** there.
2. Pick the folder for your project.

Genie inspects the folder. If it's an **`.agi` envelope** (an Aionima-format
project), Genie recognises it and shows the envelope (box) icon. Otherwise it's
treated as a plain folder. See **[Workspaces](02-workspaces.md)** for the full
story on `.agi` detect / create / convert / import.

Once added, the workspace becomes the **active workspace** and its icon appears
in the icon rail.

## 3. Open a terminal

With a workspace active, you have several ways to open a terminal:

- Click **Add Terminal** in the toolbar (the split button on the right).
- Click an **Add Terminal** tile in the empty view grid — *"a live shell in
  this workspace"*.
- In the chooser flyout, click **Add Terminal…** under the workspace.

The terminal opens rooted at the workspace folder, using your default shell
(configurable in **[Settings](08-settings.md)**).

## 4. Open the Files panel

To browse and edit files instead, open a **Files** panel:

- In the toolbar, click the chevron next to **Add Terminal** and choose **Add
  Files**.
- Or click the **Add Files** tile in the empty grid — *"browse + edit files in
  this workspace"*.
- Or use **Add Files…** under the workspace in the chooser.

The panel shows a file tree on the left; click a file to open it. See the
**[Files panel](06-files.md)** page for saving, live refresh, locking to a
folder, and the tree context menu.

## 5. Sign in (optional, but recommended)

To capture wishes and reach your projects, sign in to Tynn or Aionima from
**Settings** (the gear in the title bar). To create `.agi` repositories, connect
GitHub. See **[Sign in & integrations](10-sign-in-and-integrations.md)**.

## You're set

From here:

- Add more views and arrange them — **[Views & layouts](03-views-and-layouts.md)**.
- Learn the keys that make this fast — **[Keyboard shortcuts](07-keyboard-shortcuts.md)**.
- Decide how terminals should behave when you quit —
  **[Terminal session persistence](05-session-persistence.md)**.

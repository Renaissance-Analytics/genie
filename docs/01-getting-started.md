# Getting Started

On first launch, the built-in **Genie workstation operator** opens and owns the
setup conversation. Tynn sign-in comes first; Genie then helps verify a model
provider and toolchain, connect GitHub when wanted, prepare its private Genie OS
workspace and memory, and add a workspace. Setup is complete only after the
operator has booted, oriented itself, verified its native transport and called
Genie's readiness acknowledgement.

## 1. Open Genie

Genie runs in your system tray. Click the tray icon to open the main window.
If the window is already open, the tray icon brings it to the front.

> Closing the window doesn't quit Genie — it just hides it back to the tray.
> Your terminals keep running.

## 2. Add a workspace

A workspace follows Genie's `.agi` protocol; single-repository workspace mode is
no longer created. Choose **New**, **Import from Tynn**, or **Import from Git**.
Every route is inspected before registration. Open-world sources such as a local
folder or Git repository always go through the interactive wizard, which detects
an existing AGI/GApp envelope or proposes the conversion before writing anything.

1. In the left **icon rail**, click the **Add workspace…** button (the `+` at
   the bottom of the rail). You can also open the chooser flyout and click
   **Add workspace…** there.
2. Choose the source. **New** can start empty, create a GApp Development
   Workspace, or place an existing project folder inside a new envelope.

Genie scans first and shows the exact plan. It does not silently reshape a
folder. See **[Workspaces](02-workspaces.md)** for create, import, and conversion.

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

## 5. Return to the workstation operator

The Genie button in the header opens the workstation operator over the current
Floor. It has its own private workspace and memory and never appears as a project
in the workspace sidebar. Click outside the flyout to slide it away.

## You're set

From here:

- Add more views and arrange them — **[Views & layouts](03-views-and-layouts.md)**.
- Learn the keys that make this fast — **[Keyboard shortcuts](07-keyboard-shortcuts.md)**.
- Decide how terminals should behave when you quit —
  **[Terminal session persistence](05-session-persistence.md)**.

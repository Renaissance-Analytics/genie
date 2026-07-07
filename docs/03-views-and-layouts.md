# Views & Layouts

A **view** is a tile in the grid. There are two kinds:

- **Terminal** — a live shell in the workspace (optionally a coding agent — see
  **[Terminals](04-terminals.md)**).
- **Files** — a file tree + code editor for the workspace.

This page covers adding views, the **Max Views** cap, the four layout modes,
maximising, and resizable splits.

## Adding views

### The split "Add Terminal" button (toolbar)

On the right of the toolbar is a split button:

- The **primary** part is **Add Terminal** — click it to add a terminal to the
  active workspace (it repeats the last terminal type you chose).
- The **chevron** opens a menu to pick a **terminal type** (Terminal, Claude
  Code, Codex, Custom agent — see **[Terminals](04-terminals.md)**) and an
  **Add Files…** entry for a file editor.

When the **Max Views** limit is reached, the whole button disables and shows a
tooltip: *"Max views reached (N) — raise it in Settings"*.

### Per-workspace add rows (chooser)

In the flyout, each workspace group has **Add Terminal…** and **Add Files…**
buttons. These add a view to *that* workspace specifically.

### Empty-grid tiles

When a workspace has no views selected, the grid shows two large tiles:

- **Add Terminal** — *"a live shell in this workspace"*.
- **Add Files** — *"browse + edit files in this workspace"*.

In the **2×2** layout, when fewer than four panels are filled, a smaller **Add
Terminal** tile appears in the empty cell — *"from any project — pick on the
left"*.

## Max Views

**Max Views** caps how many panels are visible at once *per workspace*
(default **4**, range 1–9). When you hit the cap, every "Add" affordance
disables until you close a view or raise the limit. Change it in
**Settings → Workspace layout → Max views**. See **[Settings](08-settings.md)**.

## Layout modes

Pick a layout from the segment control in the centre of the toolbar:

| Mode | Toolbar label | What it does |
|------|---------------|--------------|
| Auto | **Auto layout** | Chooses for you based on panel count: 1 → single, 2 → side-by-side, 3 → focus + stack, 4+ → 2×2. |
| Focus + stack | **Focus + stack** | One large focused panel on the left, the rest stacked in a column on the right. |
| 2×2 | **2×2 grid** | A two-by-two grid (up to four panels). |
| Columns | **3 columns** | Three equal columns. |

In **Auto**, the grid re-arranges itself as you add or remove panels.

### Focusing a panel

In **Focus + stack**, the focused panel is the big one on the left. **Click a
panel** to focus it. (Genie doesn't bind a keyboard shortcut for panel focus —
a focused terminal would swallow it. See
**[Keyboard shortcuts](07-keyboard-shortcuts.md)**.)

## Maximise a panel

Each panel header has a **maximise** button:

- Click it to fill the grid with that one panel (title: *"Maximize panel"*).
- Click again to return to the tiled view (*"Restore tiled view"*).

In **Focus + stack**, the main panel also has a **Send to side stack** button
to push it back into the right-hand stack.

## Resizable splits

The dividers between panels (**gutters**) are draggable:

- **Drag** a gutter to resize the panels on either side. Panels won't shrink
  below a sensible minimum.
- **Double-click** a gutter to reset that axis to an even split.

Tooltip on a gutter: *"Drag to resize · double-click to reset"*.

Genie remembers your split sizes **per workspace and per layout arrangement**,
so each workspace keeps its own proportions for each layout.

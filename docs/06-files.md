# Files panel

The **Files panel** lets you browse and edit files in a workspace without
leaving Genie. It's a file tree plus a syntax-highlighted editor.

Open one from the toolbar's **Add Files** (chevron menu), an empty-grid **Add
Files** tile, or **Add Files…** in the chooser.

## Opening, editing, saving

- **Open a file:** click it in the file tree. The tree auto-hides once a file is
  open so the editor gets the full width; toggle the tree back with the tree
  button in the panel header (*"Show file tree"* / *"Hide file tree"*).
- **Edit:** type in the editor. An unsaved file shows a **`*`** marker next to
  its name in the tree.
- **Save:** press **⌘/Ctrl + S**, or click the **Save** button in the header.
  The button reads *"Save (Ctrl/Cmd+S)"* while there are unsaved changes and
  *"Saved"* once clean; it's disabled when there's nothing to save.

When no file is open the panel shows: *"Pick a file from the tree to start
editing."*

File types claimed by an enabled **plugin** (`.xlsx`, `.pptx`, `.md`, `.docx`
with the bundled plugins) open as a tab in this same panel, rendered by the
plugin's editor instead of the text editor — see
**[Plugins & marketplaces](11-plugins.md)**.

## Live refresh — files reload when they change on disk

The Files panel **watches the workspace on disk**. When a file changes outside
Genie — an agent edits it, a `git checkout`, a build tool, or a plugin writes it
— the panel reloads automatically:

- **The tree** re-lists, so created / renamed / deleted files appear without a
  manual refresh.
- **Open tabs** reload from disk — text tabs and plugin tabs alike — so you're
  never looking at a stale copy. (Older builds required closing and reopening
  the file; that's no longer needed.)

A tab with **unsaved edits is never overwritten**: while a tab is dirty its
on-disk changes are held back so your work isn't clobbered. Save (or discard)
and the next external change reloads it as normal.

## Lock the Files panel to a folder

By default the panel is rooted at the workspace folder. You can **lock** it to
a specific subfolder so it always reopens rooted there:

1. **Right-click a folder** in the tree.
2. Choose **Lock Files panel to this folder**.

The tree now shows only that folder's contents, and the panel header shows a
**lock badge** (*"Locked to &lt;folder&gt;"*). The lock persists across restarts.

To unlock, click the lock icon in the header (*"Unlock — restore workspace
root"*) or choose **Unlock** from the tree context menu. Clicking the lock icon
when unlocked locks to the workspace root.

## Git-status colours

If the workspace is a git repository, file names in the tree are tinted by their
git status:

| Status | Colour | Notes |
|--------|--------|-------|
| Untracked | green | new, not yet added |
| Added (staged) | green | staged new file |
| Modified | amber | changed (staged or in the working tree) |
| Renamed | amber | shown on the new path |
| Deleted | red | with a strikethrough |
| Ignored | dim grey | only shown when ignored files are included |

These update as you change files, so the tree doubles as a quick `git status`.

## Tree context menu

**Right-click** a node (or empty tree space) for file operations:

- **New file** — create an empty file (inside a folder, beside a file, or at the
  root).
- **New folder** — create a folder in the same positions.
- **Copy relative path** — copy the file's workspace-relative path.
- **Rename** — rename the file or folder.
- **Duplicate** — make a `-copy` sibling of a file (auto-numbered `-copy-2`,
  etc. on collision). Files only.
- **Delete** — remove a file or folder (with a confirmation). The workspace root
  can't be deleted.
- **Lock Files panel to this folder** / **Unlock** — see above (folders only).

> Right-clicking empty tree space offers just **New file** and **New folder** —
> the node-specific items are hidden.

## Open in an external editor

If you'd rather edit in Cursor, VS Code, or VS Code Insiders, set your **default
editor** in **[Settings](08-settings.md)**. Genie auto-detects installed editors
and you can also point it at a custom executable.

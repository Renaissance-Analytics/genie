# Plugins & marketplaces

Plugins extend Genie with **new document editors** and **new agent tools**
without touching Genie itself. A plugin declares what it adds in a signed
manifest; Genie runs its code in an isolated worker with only the capabilities
you granted.

Genie ships with three first-party plugins in the box:

| Plugin | What it adds |
| --- | --- |
| **Presentation** | A Slides editor for `.pptx`/`.odp`, a full-screen Present mode, and a `presentation.createDeck` agent tool that generates decks. |
| **Spreadsheet** | A Sheets editor for `.xlsx`/`.csv`/`.ods` and a `spreadsheet.createWorkbook` agent tool that generates workbooks. |
| **Document** | A WYSIWYG editor for Markdown (`.md`) and Word (`.docx`) files. Markdown round-trips exactly; `.docx` opens and saves with document-level fidelity (headings, lists, formatting, links, tables, embedded images) — Word-only features like tracked changes don't survive a save. |

## Installing plugins

Everything lives in **Settings → Plugins**.

- **Official tab** — the bundled first-party plugins plus (when published)
  curated plugins from Genie's signed registry. One click installs; plugins you
  already have are hidden here and managed under *Installed plugins* instead.
- **Marketplaces tab** — third-party plugin collections you add by URL. A
  marketplace is just a git repo whose `genie-marketplace.json` indexes its
  plugins; paste its URL, then install members individually. *Refresh* re-reads
  the index; *Remove* forgets the marketplace (installed plugins stay).
- **From a repo URL / from a folder** — install a single plugin directly, for
  plugins that aren't in any marketplace (or your own, while developing).

After installing, **enable** the plugin in the *Installed plugins* list. The
first enable shows exactly which capabilities the plugin asked for (for
example: read/write `.pptx` files inside the workspace it runs in) — nothing is
granted silently, and you can revoke any grant later from the same list.

## Using plugin editors

A file type claimed by an enabled plugin opens **as a tab in the Editor
panel**, right next to your text tabs — click a `.xlsx`, `.pptx`, `.md`, or
`.docx` in the file tree and it opens where you clicked it, with the same
dirty-dot, **Ctrl/Cmd+S** save, close confirmation, and session restore as any
other tab. Unsaved plugin-tab edits survive switching tabs.

Plugin editors read and write files through a **capability-scoped bridge**: a
plugin can only touch the file types it declared, inside the workspace it was
granted, and only while it's enabled.

## Agent tools from plugins

A plugin's `mcpTools` become part of Genie's agent-facing MCP surface, named
`namespace.tool` (for example `presentation.createDeck`). Agents in your
terminals can call them like any other Genie tool; the tool code runs in the
plugin's isolated worker, never in Genie's main process.

## Trust & signing

Official plugins are **Ed25519-signed** and verified against Genie's built-in
trust root at install time — a tampered manifest or bundle refuses to install.
Unsigned plugins are refused by default.

**Developer Mode** (Settings → Plugins → Developer Mode) is for plugin authors:
it lets you run UNSIGNED plugins (restricted — no network) after an explicit
warning, and lets you trust additional signing keys of your own.

## Extending Genie — writing your own plugin

A plugin is a tiny npm-shaped package: a `genie-plugin.json` manifest plus a
`tools.cjs` module. The developer guides live in the repo:

- **[Writing a Genie plugin](plugin-authoring.md)** — the manifest format, the
  worker contract, capabilities, and a complete minimal example
  (`hello-world`) you can copy as a starting point.
- **[Plugin signing](plugin-signing.md)** — how official signing works in CI,
  and how to sign your own plugins for distribution.

Publish a plugin by putting its folder in a git repo (installable by URL), or
index several in a repo with a `genie-marketplace.json` to make your own
marketplace.

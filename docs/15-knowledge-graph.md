# Knowledge Graph

The **Knowledge Graph** is your workstation's shared memory store — a local,
cross-workspace collection of small markdown notes ("memories") that link to each
other. It's where durable, reusable context lives, so it doesn't have to be
copied into every project's `AGENTS.md` / `CLAUDE.md`.

Open it from the title bar button: **"Knowledge Graph — your workstation memory
store"**. It opens in its own window.

## What's in it

Each **memory** is a markdown document with a **title**, a **body**, and
**tags**. Memories link to each other with `[[wikilinks]]` in the body — a link
resolves to another memory by its title, forming a graph you can walk.

The store is **workstation-wide**, not per-workspace: one shared brain across
every project you open in Genie.

## The window

- **Left pane** — a **search box** (keyword search over titles and bodies,
  ranked, with snippets and tags) and a toggle between a **list view** of your
  memories and a **graph view** that draws the nodes and their links.
- **Right pane** — the selected memory:
  - **View** renders it as markdown; click a `[[wikilink]]` to jump to the linked
    memory and walk the graph.
  - **Edit** opens a WYSIWYG document editor (markdown in / markdown out).
  - **Create** adds a new memory with a title, body, and tags.

The window refreshes live, so memories an agent writes appear as they land.

## Who writes to it

Two paths, and both show up in the same graph:

- **You** — create and edit memories directly in the window.
- **Agents** — through the `knowledge` MCP tool (see
  **[Agents & the Genie MCP](12-agents-and-mcp.md)**), an agent can `search`,
  `get`, `add`, `list`, and `link` memories. Agents stash durable context here
  (conventions, gotchas, decisions) so the next agent — in any workspace — can
  find it instead of relearning it.

> Each memory records whether it came from **you** or an **agent**, so you can
> tell your own notes from what the agents have learned.

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

Each memory also says **which kind** it is and **whose reasoning it belongs in**.

**Kind** (four, because they answer four different questions):

| kind | answers |
|---|---|
| `knowledge` | where this is in the documents — the default |
| `profile` | what is true of you / what you prefer |
| `episodic` | what happened, and when |
| `procedural` | what was learned from doing this before |

**Scope** (three):

| scope | belongs to |
|---|---|
| `system` | the whole workstation — every agent, every workspace |
| `workspace` | the one workspace it was written in |
| `gapp` | one Genie App, internally |

An agent's memories default to **its own workspace**, and reading defaults to
**system plus its own workspace** — so an agent working in one project is not
handed everything every other project has ever learned. Memories you write in the
window default to **system**, because this window is your view of the whole
machine.

> **Scope is noise reduction, not a lock.** Any agent can ask for every scope and
> will get it — scope keeps irrelevant knowledge out of an agent's reasoning, and
> nothing more. Don't put anything in here that has to be kept **from** an agent.

## The window

- **Left pane** — a **search box** (keyword search over titles and bodies,
  ranked, with snippets and tags), **kind** and **scope** filters, and a toggle
  between a **list view** of your memories and a **graph view** that draws the
  nodes and their links. Every row carries its scope and kind, plus the pack it
  came from when it came from one.
- **Right pane** — the selected memory:
  - **View** renders it as markdown; click a `[[wikilink]]` to jump to the linked
    memory and walk the graph.
  - **Edit** opens a WYSIWYG document editor (markdown in / markdown out), with
    the memory's kind and scope beside the title.
  - **Create** adds a new memory with a title, body, tags, kind and scope.

### Links that don't resolve

A `[[wikilink]]` matches another memory by title. When **several** memories share
that title the link resolves to **none of them** rather than guessing, and the
memory shows a notice naming each such link. Link by the memory's **id** to say
which one you meant. A link to a title that doesn't exist yet is not an error — it
connects itself the moment you write that memory.

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

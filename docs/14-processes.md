# Processes & the Task Manager

Some things you run aren't interactive shells — they're **background services**:
a dev server, a file watcher, an SSR process. Genie manages these as
**Processes**, separate from terminals, and gives them a supervisor that can
**restart** them when they crash.

## Processes vs terminals

- A **Terminal** is an interactive shell (or agent TUI) you type into. It can be
  hidden, suspended, or closed — but not "restarted".
- A **Process** is a supervised background command (label + command line). It has
  a lifecycle you control — **start / stop / restart** — and Genie keeps an eye
  on it.

Processes are typically created **by an agent** through the `manageProcess` MCP
tool (see **[Agents & the Genie MCP](12-agents-and-mcp.md)**) — an agent can
`create` a process with a label and command (optionally set to autostart), then
`start` / `stop` / `restart` it. That keeps a dev server owned by Genie's
supervisor instead of buried in a terminal that might get closed.

## The Task Manager

The title bar's **"Task Manager — every background process"** button opens a
drawer that lists **everything running across every workspace** — both processes
and terminals — so you have one place to see and stop it all.

Each row shows a **status dot** (running / stopped / crashed / restarting /
failed), an icon marking it as a **Process** or a **Terminal**, its label, and
the workspace that spawned it. The controls depend on the kind:

- **Processes:** **Stop** (while running), **Start** (while stopped),
  **Restart**.
- **Terminals:** **Kill terminal** (terminals can't be restarted — only ended).

The header has **Refresh** and **Close Task Manager**. When nothing is running
you'll see *"Nothing running — no processes or terminals across any workspace."*

> The Task Manager is a cross-workspace view over the same supervisor the
> per-workspace Processes feature uses — stopping something here stops it
> everywhere.

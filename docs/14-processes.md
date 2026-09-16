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

## What "running" means

A process's status is what Genie has **observed**, not what it intended. It is
written when the process is spawned and when its pty exits — so anything that
takes a process away *without* an exit (a pty-host loss takes every one of them
at once) would leave it remembered as running, with its queue unclaimed and no
signal anywhere.

Genie therefore re-checks the processes it believes are running against the pty
backend, every half minute and after any pty-host recovery. A process that is
gone is treated as a crash: it is reported as such, a line saying so is written
into its log, and — unless you stopped it, or turned its restart off — it is
started again with the usual backoff. A process that is *alive* but that this
Genie never started (a host that survived a restart) is adopted rather than
reported stopped.

## Reading why a process stopped

Genie keeps the tail of every process's output. Hover a process in the
Processes panel for its log, or ask for it from an agent:

```
manageProcess { action: "logs", id: "<id from list>" }
```

Read that before restarting anything — a crash says why in its last few lines,
and "restart it and see" throws that evidence away.

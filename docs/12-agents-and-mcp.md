# Agents & the Genie MCP

Genie is built for working *with* coding agents. You launch an agent in a
terminal (Claude Code, Codex, or your own — see
**[Terminals → Terminal types](04-terminals.md)**), and Genie gives it a way to
reach back out to *you* and to act on your workspace: a small **local MCP
server**.

## Why agents need to reach you

When you're running several agents across several workspaces, you're not
watching any one terminal. An agent that just prints "done" or "which option?"
and waits would stall silently. So Genie exposes tools an agent calls instead of
printing-and-waiting — they pull your attention to the right terminal, or ask a
real question.

The two you'll notice most:

- **`imDone` — the sidebar glow.** When an agent finishes (or is blocked and
  waiting), it calls `imDone` and Genie **glows that terminal** across the whole
  UI until you look at it. No more hunting for which terminal needs you.
- **`ForceTheQuestion` — a real prompt.** When an agent needs a decision, it
  raises an **OS-level, always-on-top modal** (above every app) with a few
  options and a free-text box, and waits for your answer. You can't miss it, and
  the agent doesn't guess.

## What the server lets agents do

The MCP server is enabled per workspace and runs on a fixed loopback port (see
**[Settings → Agent MCP server](08-settings.md)**). Once wired into a workspace's
`.mcp.json`, agents in that workspace can call:

| Tool | What it does for you |
|------|----------------------|
| **imDone** | Glows this terminal in the sidebar when the agent is done or waiting. |
| **ForceTheQuestion** | Pops an always-on-top modal to ask you 1–4 questions; blocks until you answer. |
| **manageProcess** | Runs and supervises background processes (dev servers, workers) — see **[Processes](14-processes.md)**. |
| **manageTerminals** | Spawns and drives other terminals. *High-power — approval-gated by default.* |
| **runAgent** | Launches and steers another coding agent. *High-power — approval-gated by default.* |
| **manageWorkspaces** | Lists / opens / activates / removes workspaces. |
| **whisper** | Talks to other agents — see **[WhisperChat](13-whisperchat.md)**. |
| **knowledge** | Reads and writes your **[Knowledge Graph](15-knowledge-graph.md)**. |
| **checkIssues** | Reads the workspace's open GitHub issues, PRs, and security alerts — see **[Issue Watch](16-issue-watch.md)**. |
| **openFileForUser** | Opens a file in Genie's built-in **[Files](06-files.md)** editor for you. |
| **setEnv / checkEnv** | Reads or upserts a key in a workspace `.env` (preserving comments). |
| **genieGuide** | Returns the full usage guide, so the agent knows when and how to use all of the above. |

## Approvals — you stay in control

The **high-power** tools (`manageTerminals`, `runAgent`, and creating a process)
can run arbitrary code or launch autonomous agents. Genie **gates these behind
your approval by default** — an agent can ask to spawn a terminal or another
agent, but you decide whether it happens. Read-only tools (like `checkIssues`)
and attention tools (`imDone`, `ForceTheQuestion`) run freely.

> The MCP server is auto-wired into each enabled workspace at a fixed loopback
> URL. Claude Code reads it from `.mcp.json`, Cursor reads `.cursor/mcp.json`,
> and Codex Agent Terminals launched by Genie receive equivalent project-scoped
> `-c mcp_servers...` overrides because Codex does not currently read a
> workspace-local MCP config file. Turn it on and set the port in
> **[Settings → Agent MCP server](08-settings.md)**.

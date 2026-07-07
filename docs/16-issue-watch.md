# Issue Watch

**Issue Watch** keeps an eye on the GitHub repositories behind your workspace and
surfaces their open **issues**, **pull requests**, and **security alerts**
(Dependabot, code scanning, secret scanning) in one feed — without leaving Genie.

Open it from the title bar button: **"Issue Watch — GitHub issues, PRs &
Dependabot"** (it shows an unread badge).

## What you see

- **Repos** — the GitHub repositories detected in the workspace (from git remotes
  pointing at github.com), each with a **watch toggle** and an unread count. For a
  fork, both **This repo** and its **Upstream** are shown.
- **Activity** — the feed, newest first. Each item carries a **kind** badge
  (Issue / PR / Dependabot / Code scan / Secret) with its title, repo, number,
  and severity.

## Connecting GitHub

Issue Watch reads through your GitHub connection (the **"Genie IDE" GitHub App**;
see **[Sign in & integrations](10-sign-in-and-integrations.md)**). Genie tells
you exactly what's missing when it can't read:

- Not connected → *"Connect GitHub in Settings → Connections to watch issues,
  PRs, and Dependabot alerts."*
- No GitHub repo in the workspace → *"No GitHub repos detected in this workspace
  (no git remote pointing at github.com)."*
- Session expired → *"GitHub session expired — reconnect to restore Issue
  Watch."*
- Missing App permissions → a note listing the missing capabilities and a
  **Resolve…** button.

When everything's connected and nothing is open, it reads *"Nothing open on the
watched repos."*

## For agents

The same data is available to agents through the `checkIssues` MCP tool (see
**[Agents & the Genie MCP](12-agents-and-mcp.md)**), and a concise count line
(e.g. `issues:3, PR:1, sec:3`) is appended to every `imDone` — so an agent that
just finished can immediately flag a new Dependabot alert. This is why fixing
security alerts promptly is a first-class Genie habit.

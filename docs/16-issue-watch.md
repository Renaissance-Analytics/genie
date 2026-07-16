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

## Connecting Tynn

Issue Watch is a Tynn service. Tynn polls each registered workspace repository
once with its GitHub App installation token, caches the result, and pushes
deltas to Genie. Genie's optional GitHub device-flow connection is used for
repository operations and is never required for Issue Watch.

Genie reports the Tynn service state directly:

- Signed out → sign in to Tynn in Genie.
- Feature disabled → enable IssueWatch for the Tynn account.
- Connecting/disconnected → the panel says the Tynn IssueWatch stream is not
  connected; it never asks you to reconnect Genie's GitHub account.
- Missing Tynn GitHub App permissions → review the installation permissions from
  Tynn's GitHub integration UI.

When everything's connected and nothing is open, it reads *"Nothing open on the
watched repos."*

## For agents

The same data is available to agents through the `checkIssues` MCP tool (see
**[Agents & the Genie MCP](12-agents-and-mcp.md)**), and a concise count line
(e.g. `issues:3, PR:1, sec:3`) is appended to every `imDone` — so an agent that
just finished can immediately flag a new Dependabot alert. This is why fixing
security alerts promptly is a first-class Genie habit.

# Updates

Genie keeps itself current. How it updates depends on whether you're running an
**installed (packaged)** build or a **git checkout** — Genie detects which and
behaves accordingly. You configure and drive updates from the **Updater**
section of **Settings**.

## What you'll see

When an update is available, an **update pill** appears in the title bar and the
tray icon picks up an amber badge. The pill steps through states as you click it:

- **Install update** → **Installing… *X*%** → **Restart to update**

Hovering the pill shows a small popover with the version and a note. You also
get a one-time native notification per new version; clicking it opens Settings.

## Installed builds (signed installer)

Packaged Genie updates via the standard auto-updater:

- It checks shortly after launch and then on a poll interval.
- The installer is **downloaded and checksum-verified** before applying.
- When you apply, Genie downloads the update, then **restarts** to let the
  installer swap in the new version.

## Git checkouts (developer builds)

If you're running Genie from a git checkout, it updates by **pulling and
rebuilding**:

- It checks the GitHub repository's latest release/tag.
- Applying runs the equivalent of *fetch → checkout the new tag → install →
  build*, streaming the log into the Settings panel.
- If the build fails, Genie **rolls back** to the previous commit automatically.
- On success it reaches **"Ready — restart to load"**; you restart Genie
  yourself to load the new build.

### Updater configuration (git checkouts)

- **Source repository** — the GitHub `owner/repo` to track (default
  `renaissance-analytics/genie`; change only if you track a fork). Empty
  **disables** the updater.
- **Poll every (hours)** — how often Genie checks automatically (default **6**;
  `0` disables automatic polling).

## The background-terminals (pty-host) restart warning

If you've enabled **"Keep terminals running after quit"** (detached terminals,
Tier 3), applying an update has to **restart the background terminal process** —
the running app binary is held open by that process, and the installer can't
replace a file that's in use.

So when an update will restart the host, Genie warns you, e.g.:

> *"Applying this update restarts your background terminals…"*

You won't lose your sessions: Genie **snapshots** each terminal before the
restart and **replays the history** afterwards (Tier 1). The processes restart,
but your scrollback and working directories come back. See
**[Terminal session persistence](05-session-persistence.md)**.

## Draining agents before an upgrade

If agents are running when you apply an update, Genie does not just close their
terminals. It **drains** them first.

1. Every live agent is sent one message: stop work, write a handoff, then call
   `thumbsUp`.
2. A **"waiting on" roster** appears under the title bar — one row per agent,
   with an empty thumb while it is still working and a **green** one the moment
   its answer lands.
3. When every row is green, Genie installs the update and restarts.

### An agent that stops answering

A row that has gone quiet for a few minutes says **"not responding"** and turns
amber, so a wedged agent is never mistaken for a slow one. When that happens,
close that agent yourself and then **press the thumb on its row**. That counts
as satisfied, and the upgrade goes ahead. Nothing waits indefinitely on one
stuck agent, and **Cancel the upgrade** always abandons the whole thing rather
than installing anyway.

### Everything comes back, a few seconds apart

Genie records what was running when the drain started — agents, hosted sites and
background processes — and brings **that** back after the restart. Each agent
picks up the handoff its previous run wrote.

Two things about the restore are deliberate:

- **Starts are spaced at least three seconds apart.** A dozen cold starts at
  once, on a machine that has just finished an upgrade, is how ports collide and
  startups crawl.
- **Anything *you* stopped stays stopped.** A site you stopped or a process you
  paused is not resurrected by an upgrade you did not choose. Genie restores what
  *it* stopped; it never restarts what *you* stopped.

## Buttons in the Updater section

- **Check for updates** — check now.
- **Update now (vX.Y.Z)** / **Download vX.Y.Z** — apply / download the update.
- **Restart Genie now** — appears when an update is staged and ready.

A scrollable **log panel** shows progress while applying or downloading.

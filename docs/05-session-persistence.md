# Terminal Session Persistence

One of Genie's defining features is that your terminals don't vanish the moment
you stop looking at them. There are **three tiers** of persistence, each
covering a different situation. You don't have to think about most of this — it
just works — but here's the full picture.

## The three tiers, in plain terms

### Tier 1 — Snapshots replay history after a full quit (always on)

Genie periodically **snapshots** each terminal's scrollback (and again right
before you quit). On the next launch, a fresh shell opens with that history
restored above a screen-clear divider, marked **— previous session —**.

This means: even after a complete quit and relaunch, you reopen a terminal and
**see what was there before**. The shell itself is new (the old process ended
when the app quit), but the history is back, and it reopens in the same
directory you left it in (see *cwd resume* below).

Tier 1 is always active and needs no configuration.

### Tier 2 — Disabling keeps a process running while the app is open

When you **suspend** a terminal (the pause button), Genie hides its panel but
**keeps the shell process alive** in the background — for as long as Genie is
running. Re-enable it and you reattach to the *live* session, process and all.

This is the "I don't need to watch my dev server right now, but don't kill it"
tier. It only lasts while Genie is open. There's a cap on how many terminals can
be kept this way. See **[Terminals → Suspend / re-enable](04-terminals.md)**.

### Tier 3 — Detached terminals survive a full quit

With **"Keep terminals running after quit"** turned on (Settings → Default
terminal), Genie runs your terminals in a **separate background process** that
keeps living even after you fully quit Genie. On the next launch, Genie
**reattaches** to those still-running sessions — your dev server never stopped.

This tier is **experimental** and **off by default**. If the background process
can't start, Genie falls back to in-process terminals (which still restore from
a Tier 1 snapshot, but don't survive a full quit).

## The quit confirmation

When detached terminals (Tier 3) are on and you have live background terminals
*and* a window open, **manually quitting** Genie pops a confirmation so you can
decide, per terminal, **which to keep running and which to shut down**.

- Tick the terminals you want to **keep running** after Genie quits; the rest
  are shut down cleanly.
- **Cancel** aborts the quit — Genie stays open.
- If you don't respond, Genie does the **safe thing**: it keeps everything
  running and proceeds to quit.

## The update warning

Applying an update has to restart the background terminal process (the running
app binary is "pinned" by the host, and the installer can't replace a file
that's in use). So when an update is about to apply, Genie warns you:

> *"Applying this update restarts your background terminals…"*

Your sessions aren't lost — Genie **snapshots them first** (Tier 1) and replays
the history after the update relaunches. The processes themselves restart, but
your scrollback and working directory come back.

## cwd resume — terminals reopen where you left off

Genie tracks each terminal's **current working directory** as you `cd` around.
When a terminal is restored (after a quit, or after an update), it reopens in
the **last directory you were in**, not just the workspace root. Combined with
Tier 1's history replay, a restored terminal feels like you never left.

## Quick reference

| Situation | What persists | Tier |
|-----------|---------------|------|
| Switch active workspace | The process keeps running, hidden | (keep-alive) |
| Suspend a terminal | The process keeps running, app must stay open | Tier 2 |
| Fully quit, default settings | History (snapshot) is replayed on relaunch | Tier 1 |
| Fully quit, "keep running" on | The process itself survives and reattaches | Tier 3 |
| Apply an update | Process restarts; history replayed from snapshot | Tier 1 + warning |

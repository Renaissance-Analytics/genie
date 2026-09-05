# Flows

A **Flow** is Genie's automation unit:

> **Flow = Recipe (what runs) + Triggers (when) + Scope (who it touches)**

Something happens on your machine — a file lands in a workspace, say — and a
Flow that was watching for it runs a recipe. Open the **Flow Manager** from the
title-bar button (two boxes joined by an elbow) to make one, to see every Flow,
arm and disarm them, run one by hand, and find out what happened last time.

> Not the same thing as a **Genie App's flow canvas**, which is a node graph
> owned by one GApp and edited inside it. Flows here are your machine's, and
> they are what this page is about.

## Creating a Flow

Press **+** in the Flow Manager. A Flow is four decisions:

**What it does.** Pick a body. Genie states what arming it will do the moment
you choose it — *"Moves files out of your workspace into an untracked folder,
without asking again"* — because that is the decision, not the name you give it
afterwards.

**When it runs.** Add as many triggers as you like. *When you run it* makes the
Flow manual; anything else is an event, and each event can be narrowed with
conditions built from the things that event actually reports. A file event knows
its size, its extension and where it landed, so *size in bytes is over 5,242,880*
is a condition you pick rather than type. Several conditions on one trigger read
as **must** (all of them), **or** (any of them) and **must not**.

**Where it applies.** The whole machine, one workspace, or an installed Genie
App. A workspace-scoped Flow only ever sees that workspace's events, so it
cannot act on another project's files.

**Settings.** Whatever the body needs that its triggers do not already supply.
The file mover needs to know which folder to move things into; it does *not* ask
which file, because the event it fires on already says.

You can edit any of it later, and delete a Flow from its row.

### A new Flow is switched off

Every Flow you create arrives **off**. Turning it on is the separate act
described above, with Genie stating what the body does first. Creating a Flow
and arming one are different decisions, and the editor only makes the first.

The same applies to editing: if you change **what an armed Flow does** or
**where it may act**, Genie switches it off and tells you. What you agreed to
was that body, in that place — change either and the agreement no longer
describes the Flow. Renaming it, adding a note or adjusting its conditions
leaves it armed.

### Genie refuses a Flow that could never work

Some Flows are broken in a way no list would ever show: they sit there enabled,
correctly spelled, and do nothing forever. Genie refuses to save them, and says
which part is wrong:

- **A condition on something the event does not report.** `sizeBtyes` is a typo
  you can fix in the second you made it, or a silent night nobody can explain.
- **A body with nothing to work on.** The file mover reads the file from the
  event that started it. A Flow you can only run by hand supplies no event — so
  either give it the values as settings, or trigger it on an event that carries
  them.
- **A body Genie may not run unattended.** Anything that runs a shell command,
  or asks a person a question, needs someone present. On an event trigger it
  would be refused every time it fired, so it is refused when you save it
  instead.

Every reason at once, not one at a time.

## The button animates while a Flow is running

The Flows icon pulses whenever a Flow's body is executing — and only then. It
is driven by the automation runtime itself, so the movement means work is
genuinely happening on this machine right now. A Flow that was held back,
refused, or is simply waiting for its trigger does not move it.

## What a row tells you

| | |
|---|---|
| **Scope** | Who the Flow belongs to: the **whole machine**, one **workspace** (named), or a **GApp**. A workspace-scoped Flow only ever sees that workspace's events, so it cannot act on another project's files. |
| **Triggers** | When it fires — **When you run it** for a manual Flow, or the event it watches, with the number of conditions narrowing it. Expand the row to read the conditions in words. |
| **Enabled** | The switch arms and disarms it. Disarming also releases any filesystem watchers the Flow was holding, so a disabled Flow really stops rather than quietly still watching. |
| **Edit / Delete** | Change any part of it, or remove it. Deleting takes its run history with it. |
| **Last run** | The outcome, and when. |

## Turning a Flow on

Turning one **off** is one click — the machine does less, which cannot surprise
you.

Turning one **on** asks first, when the Flow's body has consequences worth
stating. Genie shows you what it will do in the recipe's own words — *"Moves
files out of your workspace into an untracked folder, without asking again"* —
before it is armed, because that is what arming means: standing permission to
act unattended, without checking with you each time. A Flow that is off says the
same sentence on its row, so the switch beside it is a decision rather than a
guess.

You can turn it off again at any time.

## Outcomes

Only two of these mean a Flow's body actually ran:

| Outcome | What happened |
|---|---|
| **Ran** | The body ran to completion. |
| **Failed** | The body started and a step failed. The reason is on the run. |
| **Held back** | The loop-prevention guard stopped it — usually because the Flow's own effect would have re-triggered it. |
| **Refused** | It could not run: its recipe is not installed, or its body is not one an unattended run is allowed to execute. |
| **Needs you** | It has steps only the recipe wizard can run, so it is waiting for a person. |
| **Misconfigured** | Something about the Flow itself is wrong — a condition that cannot be evaluated. |
| **Running** | The body is executing right now. |
| **Interrupted** | Genie stopped while the run was in progress. The Flow did not fail — it never got to finish. |

A refusal is kept in the history exactly like a success. A Flow that quietly
does nothing is the hardest thing about any automation system to debug, so
**"held back"** and **"refused"** are answers rather than silence.

## "This Flow is on but nothing can start it"

Sometimes a Flow looks completely healthy — titled, enabled, sitting in the
list — and can never run again. Two ways that happens:

- **Its trigger event no longer has a producer.** Genie refuses to *save* a Flow
  watching for something nothing emits, but a Flow can go dead later, when
  whatever used to emit that event goes away.
- **Its workspace was removed.** A workspace-scoped Flow only sees its own
  workspace's events, and a workspace that no longer exists emits none.

The manager says so on the row, with the specific reason. Nothing else in Genie
would tell you.

## Run history

Expand a row for its recent runs — the outcome, when, the event that triggered
it, and the reason where there is one. Genie keeps the last 50 runs per Flow.

A run is recorded when it **starts**, not only when it ends, so a run that was
still going when Genie quit or crashed is still in the history. Genie marks
those **Interrupted** the next time it starts. Nothing is ever left showing as
running: the animated header icon is rebuilt from scratch on every launch, so it
can only ever reflect work happening now.

## See also

- **[Genie Apps](19-genie-apps.md)** — a GApp's own flow canvas is a different
  surface at a different scope.
- **[Processes & the Task Manager](14-processes.md)** — for supervised
  background services, which are scheduled rather than triggered.

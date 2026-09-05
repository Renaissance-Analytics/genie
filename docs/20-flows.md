# Flows

A **Flow** is Genie's automation unit:

> **Flow = Recipe (what runs) + Triggers (when) + Scope (who it touches)**

Something happens on your machine — a file lands in a workspace, say — and a
Flow that was watching for it runs a recipe. Open the **Flow Manager** from the
title-bar button (two boxes joined by an elbow) to see every Flow, arm and
disarm them, run one by hand, and find out what happened last time.

> Not the same thing as a **Genie App's flow canvas**, which is a node graph
> owned by one GApp and edited inside it. Flows here are your machine's, and
> they are what this page is about.

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
| **Last run** | The outcome, and when. |

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

## Creating a Flow

Not yet. Genie ships with no Flows, and authoring one — choosing a recipe,
its triggers, its conditions and its scope — arrives in a later release. Until
then the manager shows what is there, which on a fresh machine is nothing, and
says so.

## See also

- **[Genie Apps](19-genie-apps.md)** — a GApp's own flow canvas is a different
  surface at a different scope.
- **[Processes & the Task Manager](14-processes.md)** — for supervised
  background services, which are scheduled rather than triggered.

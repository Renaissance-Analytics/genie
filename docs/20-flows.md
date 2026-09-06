# Flows

A **Flow** is a diagram of steps and what starts them.

> **Flow = a graph (what runs) + a scope (who it belongs to)**

You draw it on a canvas: boxes for the steps, lines between them, and a trigger
box that says when it goes. Genie runs it — on a schedule, when something
happens on your machine, or when you press Run.

Open the **Flow Manager** from the title-bar button (two boxes joined by an
elbow) to make one, to see every flow, arm and disarm them, run one by hand, and
find out what happened last time.

## The canvas

Press **+** in the Flow Manager. A new flow opens on the canvas with one box —
**Manual**, meaning "when you run it" — and nothing else.

Drag steps in from the palette on the left, and join them by dragging from one
box's dot to another's. Clicking a box opens its settings on the right.

There are two families of step.

**Genie's own.** Terminals, agents, workspaces, hosted sites, services, issues,
knowledge, files, and asking you a question. These are the same things an agent
can do through Genie, and each one shows exactly the settings that action takes.

**Logic.** Branch, Switch, Merge, Wait, Transform, Variable, Log, Output. These
decide the shape of the flow rather than doing anything to your machine.

A **Branch** is how a flow makes a decision — *is this file over 5 MB?* — and it
has two exits, `true` and `false`, so the drawing shows both paths.

Some steps Genie deliberately will not run, and it says so on the canvas rather
than at three in the morning: anything that makes arbitrary web requests, calls
a model directly, or writes to a store Genie has not decided the rules for yet.

## When it runs

Every flow starts from a **trigger** box, and a flow can have more than one.

| Trigger | When it fires |
|---|---|
| **Manual** | When you press Run. |
| **Schedule** | On a repeating time you set. |
| **When something happens** | When Genie reports the event you choose — a file landing in a workspace, for instance. |
| **Webhook** | Not yet. Genie has nowhere for an inbound request to land, and says so on the box rather than looking armed. |

Only the branch below the trigger that actually fired runs. A flow with a
Schedule box and a Manual box beside it does not run both halves every night.

There is no separate list of conditions. If you want *"a file was added, and it
is over 5 MB"*, that is an event trigger joined to a Branch — visible on the
canvas, and the run afterwards shows which way it went.

## Where it applies

Every flow belongs to one of three places, and this decides both who sees it and
what it may touch:

| Scope | Sees | May act on |
|---|---|---|
| **This machine** | everything | anywhere |
| **One workspace** | that workspace's events, and nothing else | that workspace only |
| **A Genie App** | its own | exactly what that app was granted — no more |

A workspace flow that names a different workspace is **refused**, not quietly
redirected: a flow must not do something other than what you drew.

A Genie App's flows appear in that app's own Flows tab and nowhere else. They
are ordinary flows — same canvas, same steps — bounded by the permissions you
gave the app when you installed it. A flow can do less than its app, never more.

## Turning a flow on

Every flow you create arrives **off**.

Turning one **off** is one click — the machine does less, which cannot surprise
you.

Turning one **on** asks first, and tells you what it will be able to do, taken
from the steps you actually drew: *"It will be able to use: Terminals, Hosted
site."* That is what arming means — standing permission to act unattended,
without checking with you each time. A flow that is off says the same thing on
its row, so the switch beside it is a decision rather than a guess.

Change **what a flow does** or **where it applies**, and Genie switches it off
and tells you. What you agreed to was those steps, in that place. Renaming it or
moving boxes around leaves it armed.

You can run a flow **by hand while it is off**. That is how you try one before
letting it act on its own.

## Genie says when a flow cannot fire

Some flows are broken in a way no list would ever show: they sit there enabled,
correctly spelled, and do nothing forever. The row says so:

- **a schedule with no time set**;
- **a trigger with no event chosen** — which is not a wildcard, it is unfinished;
- **an event nothing emits any more**, because whatever used to report it is
  gone. This can only happen after the fact, so it is checked every time the
  list is drawn rather than once when you saved.

While you are drawing, the canvas tells you the other half: any step that would
be turned away when the flow runs is named as you draw it, with the reason.

## The button animates while a flow is running

The Flows icon pulses whenever a flow is executing — and only then. It is driven
by the runner itself, so the movement means work is genuinely happening on this
machine right now. A flow that was held back, refused, or is simply waiting for
its trigger does not move it.

## What a row tells you

| | |
|---|---|
| **Scope** | Where it belongs — this machine, a workspace, or a Genie App. |
| **Triggers** | Every trigger on the canvas, in words. Orange means that one cannot fire. |
| **Enabled** | The switch arms and disarms it. Disarming also releases any filesystem watchers the flow was holding, so a disabled flow really stops rather than quietly still watching. |
| **Edit / Delete** | Open the canvas, or remove it. Deleting takes its run history with it. |
| **Last run** | The outcome, and when. |

## Outcomes

Only one of these means a flow did its job:

| Outcome | What happened |
|---|---|
| **Ran** | Every step completed. |
| **Failed** | A step failed. The reason is on the run. |
| **Held back** | The loop-prevention guard stopped it — usually because the flow's own effect would have re-triggered it. |
| **Refused** | A step reached past what this flow is allowed to do. The steps that would be turned away are named. |
| **Needs you** | It is waiting on a question. |
| **Misconfigured** | Something about the flow itself is wrong. |
| **Running** | It is executing right now. |
| **Interrupted** | Genie stopped while the run was in progress. The flow did not fail — it never got to finish. |

A refusal is kept in the history exactly like a success. A flow that quietly
does nothing is the failure this whole surface exists to make visible, so
nothing that did not happen is hidden.

Expand a row to read its recent runs.

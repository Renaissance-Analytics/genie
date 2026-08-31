# Genie Apps (GApps) and GApp Development Workspaces

A **Genie App** — a **GApp** — is a whole agentic application that installs into
Genie. It brings its own workspace, its own preconfigured hosting, its own
window, and access to Genie's tools under permissions you consent to at install.
The closest comparison is installing an app on a phone: it arrives whole, it asks
for what it needs, and you say yes or no.

A GApp is not a plugin. A **[plugin](11-plugins.md)** extends Genie's own
surfaces — panels, flyouts, wizards — inside Genie's window. A GApp is an
application in its own right that Genie hosts and serves.

## What a GApp actually is

An **[`.agi` envelope](02-workspaces.md) with a manifest**: one or more repos, a
front end Genie serves at its own address, optional backend services in any
language, and a declaration of what it wants to be allowed to do.

Two real ones, to calibrate:

| | shape |
|---|---|
| **AI Trader ORR Jdun** | a Python/FastAPI backend **and** a React front end, served static |
| **The Ripple Effect** | a live artboard pointed at a dev server, watched by humans **and other agents** |

### The manifest — `gapp.json`

The developer-owned manifest is **`gapp.json`**, pinned to the shared
`gapp.schema.json`. Alongside it, `project.json` is the *managed* workspace file
Genie maintains.

Older apps used `genie-app.json`. That name is retired: an app is migrated by
validating first and renaming after, never by teaching Genie to read both.

Two parts of the manifest are worth knowing about before you read the SDK:

- **`contributes`** — tools this app offers to *other* agents. A GApp can extend
  what every agent on the machine can do, not just what you can click.
- **`.agents/`** — the agents the app ships with. An app can arrive with its own
  agents already designed, the same way it arrives with its own front end.

### Where it is served

Genie serves an installed app's front end at its own **`.gen`** address, through
the same [Hosting Manager](18-dev-sites.md) that serves any other site — visible
in the Genie Browser, on this machine or on a
[host](17-hosts-and-workstations.md) you are driving.

## Permissions

A GApp declares the permissions it wants, and **you consent at install** — before
anything of it runs. The guidance to app authors is to ask for the least that
works, because every permission is one more thing you are being asked to agree
to on a screen you will read once.

An app cannot quietly widen this later. A permission it did not ask for at
install is a permission it does not have.

## GApp Development Workspaces

A **GApp Development Workspace** (GDW) is a workspace where you are *building* an
app rather than running an installed one.

A workspace becomes a GDW when **its linked Tynn project is marked as a Genie
App**. That mark is deliberately **human-only** — an agent cannot promote a
workspace into a GDW on its own, because doing so changes what the workspace *is*
and what tooling points at it.

A GDW is drawn differently in the sidebar, on purpose: it is a different **kind**
of workspace, not merely a workspace with an extra setting, and at a glance you
should be able to tell which of your workspaces builds an app. Its row also
carries a **launcher** — the only workspace kind that does — which opens the app
straight from its live source.

### The two tools you actually use

Both live in **Workspace settings** on a GDW, and both point at that folder
automatically — there is no folder to pick.

- **Check this app** — runs the full check suite over the folder: manifest,
  files, agents, services, and the front end. This is the same suite as the CLI
  and the same one an agent runs; there is not a second, friendlier version that
  might disagree with it.
- **Preview it** — opens the app in a **throwaway window on the live source**,
  with its own identity and address so it cannot collide with an installed copy
  of the same app. Preview raises the OS permission prompt itself, and that
  consent is yours to give — previewing is not a way around it.

Run **Check** before **Preview**. Preview on an app that does not pass check
mostly teaches you things check would have told you faster.

### Doing it from an agent

Agents reach the same tools through the **`manageGappDev`** MCP tool
(`status`, `check`, `preview`) — see
**[Agents & the Genie MCP](12-agents-and-mcp.md)**. Start with `status`: the
filesystem alone cannot tell an agent whether a folder is a GDW.

`check` and `preview` run the *same* code as the buttons above, deliberately.
What the tool removes is the clicking, not the consent — a human still cannot see
an agent's terminal, which is the whole reason an agent needs its own path to
these tools.

A headless [host](17-hosts-and-workstations.md) has no desktop window, so
`preview` reports that it is unavailable there and names the host as the reason,
rather than failing in a way that reads like a bug.

## Building one

The full developer guide ships with Genie as **`@genie/app-sdk`** — the manifest
reference, the permission model, what an app can and cannot do, how to offer
tools to other agents, and how to check and share the result. It is written to be
read start to finish by a person *or* an agent asked to build an app.

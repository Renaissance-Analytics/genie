<!-- Generated from src/core/catalog.ts by `npm run docs:sdk`. Do not edit by hand: change the schema and regenerate. -->

# Genie SDK: the catalog

Everything Genie is made of — a tool, a panel, an editor, a recipe, a flow node — is one **definition** in Genie's catalog, whoever contributes it: Genie itself, a plugin or a GApp. Each definition is the same [envelope](envelope.md) around a **payload** of its family's own fields.

genie-host validates every definition against the schemas these pages are generated from, and registers a package's definitions together, or none of them.

Catalog schema version: 1.

A package is signed over every file in it: [the package format](packages.md) (`genie-package/1`).

## Contribution families

| Family | Status | Side | What it is |
|---|---|---|---|
| [tool](kinds/tool.md) | active | host | An MCP tool agents call. The host runs it with the handler the payload names; it appears in every agent's tool list under its id. |
| [panel](kinds/panel.md) | active | client or both | A panel in the workspace grid. It mounts one vetted Fancy component, drawn by Genie's own compiled adapter: a package ships no UI code. |
| [editor](kinds/editor.md) | active | both | Opens files of the extensions it claims in one vetted Fancy editor. Genie's own editor wins a claim by default; another is offered in Open with. |
| [recipe](kinds/recipe.md) | active | per definition | A guided sequence of steps the person walks through. |
| [flow-node](kinds/flow-node.md) | active | per definition | A node in the Flows palette. The executor the payload names runs it. |
| [host-service](kinds/host-service.md) | active | host or both | A service genie-host runs and keeps running with no window open (remote access, a relay). On both sides it has a client part, and its reach.link says how the two talk. |
| [app](kinds/app.md) | active | both | A GApp: a UI that runs in its own window and talks to Genie only through the host, over the bridge, within what the person granted it. Its window draws it; its grant, storage and calls live in genie-host. |
| [page](kinds/page.md) | active | per definition | A family a package may contribute. It has no fixed payload fields yet: its payload is any JSON object, and the Genie release that runs it adds them here. |
| [overlay](kinds/overlay.md) | active | per definition | A family a package may contribute. It has no fixed payload fields yet: its payload is any JSON object, and the Genie release that runs it adds them here. |
| [provider](kinds/provider.md) | active | per definition | A family a package may contribute. It has no fixed payload fields yet: its payload is any JSON object, and the Genie release that runs it adds them here. |
| [service-engine](kinds/service-engine.md) | active | per definition | A family a package may contribute. It has no fixed payload fields yet: its payload is any JSON object, and the Genie release that runs it adds them here. |
| [flyout](kinds/flyout.md) | reserved | per definition | Reserved: accepted and registered, so a package that declares one loads, and nothing runs it yet. A later Genie release makes it run and adds its fields here. |
| [modal](kinds/modal.md) | reserved | per definition | Reserved: accepted and registered, so a package that declares one loads, and nothing runs it yet. A later Genie release makes it run and adds its fields here. |
| [wizard](kinds/wizard.md) | reserved | per definition | Reserved: accepted and registered, so a package that declares one loads, and nothing runs it yet. A later Genie release makes it run and adds its fields here. |
| [workstation-page](kinds/workstation-page.md) | reserved | per definition | Reserved: accepted and registered, so a package that declares one loads, and nothing runs it yet. A later Genie release makes it run and adds its fields here. |
| [workspace-settings-page](kinds/workspace-settings-page.md) | reserved | per definition | Reserved: accepted and registered, so a package that declares one loads, and nothing runs it yet. A later Genie release makes it run and adds its fields here. |

**Side** is where an element runs: on the **host** (genie-host, which owns the work and keeps running with no window open), on a **client** (a Genie window, on this machine or another, which draws), or **both**. A family Genie runs today allows only the sides it can run on; the others leave it to each definition's `reach.side`.

**Active** families are run by Genie. **Reserved** families are accepted and registered, so a package that declares one loads, and nothing runs them yet; a later Genie release makes each one run.

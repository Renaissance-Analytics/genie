<!-- Generated from src/core/catalog.ts by `npm run docs:sdk`. Do not edit by hand: change the schema and regenerate. -->

# The definition envelope

Every definition, of every family and from every source, has these fields. A key not listed here is refused. Defaults are filled in when the field is left out.

| Field | Type | Required | Default | What it is |
|---|---|---|---|---|
| `id` | dotted name | yes | — | Unique in the catalog, like `ai.genie.spreadsheet.createWorkbook`. A tool is offered to agents under it. |
| `kind` | one of tool, panel, editor, recipe, flow-node, page, overlay, provider, service-engine, flyout, modal, wizard, workstation-page, workspace-settings-page | yes | — | Its contribution family: what its payload holds. |
| `version` | semver | yes | — | Its own version, like `1.2.0`. |
| `packageId` | reverse-DNS | yes | — | The package that contributes it: every definition of a package registers together, or none does. |
| `source` | one of builtin, plugin, gapp | yes | — | Who contributes it. An installed package never replaces one of Genie's own. |
| `docs` | object | yes | — | What people and agents read about it. |
| `docs.name` | string | yes | — | Its name. |
| `docs.description` | string | yes | — | What it does. |
| `docs.guide` | string | no | — | How an agent should use it. |
| `reach` | object | yes | — | Where it runs and who may reach it. |
| `reach.scopes` | one or more of workspace, workstation | yes | — | Whether it acts in a workspace, on the workstation, or both. |
| `reach.side` | one of host, client, both | yes | — | Whether genie-host runs it, a client draws it, or it has a part on each side. |
| `reach.link` | object | no | — | How its two sides talk, required when `reach.side` is `both` and refused otherwise: the only channel between its halves. |
| `reach.link.calls` | list of host method names | yes | — | The host methods its client side calls. |
| `reach.link.events` | list of host event names | yes | — | The host events its client side follows. Calls and events together name at least one. |
| `reach.requiresWindow` | boolean | yes | — | Whether it needs a Genie window open. |
| `reach.remote` | one of allowed, owner, local | yes | — | Who may reach it from another machine: anyone the host lets in, only its owner, or only this machine's own window. |
| `permissions` | object | yes | — | What it asks for. Registering is not a grant: the host decides at install and at each call. |
| `permissions.capabilities` | list of names | yes | — | The Genie capabilities it asks for; `[]` for none. |
| `permissions.network` | list of hosts | no | `[]` | The hosts it may reach; none unless listed. |
| `payload` | object | yes | — | Its family's own fields: see each family's page. |

The `payload` holds the family's own fields: see [the families](README.md#contribution-families).

## Side

**Side** is where an element runs: on the **host** (genie-host, which owns the work and keeps running with no window open), on a **client** (a Genie window, on this machine or another, which draws), or **both**. A family Genie runs today allows only the sides it can run on; the others leave it to each definition's `reach.side`.

An element on **both** sides declares `reach.link`, how its halves talk: the host methods its client side calls (`calls`) and the host events it follows (`events`). That is the only channel between them. One side alone has no link.

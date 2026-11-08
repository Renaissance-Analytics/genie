<!-- Generated from src/core/catalog.ts by `npm run docs:sdk`. Do not edit by hand: change the schema and regenerate. -->

# panel

Status: **active**.

Side: **client** or **both**: a client (a Genie window, on this machine or another) draws it; or a client draws it and its work is done on the host, over its `reach.link`. A definition on any other side is refused. On both, it declares `reach.link`.

A panel in the workspace grid. It mounts one vetted Fancy component, drawn by Genie's own compiled adapter: a package ships no UI code.

## Payload fields

| Field | Type | Required | Default | What it is |
|---|---|---|---|---|
| `fancyComponent` | one of ContentRenderer, JsonEditor, Callout, RepoChangesPanel, ArtBoardPanel | yes | — | The vetted Fancy component the panel mounts. |
| `title` | string | no | — | The panel's title. |
| `props` | object | no | `{}` | The component's props, as plain JSON. |

## Example payload

```json
{
  "title": "Notes",
  "fancyComponent": "ContentRenderer",
  "props": {}
}
```

Every definition also carries the [envelope](../envelope.md).

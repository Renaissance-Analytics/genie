<!-- Generated from src/core/catalog.ts by `npm run docs:sdk`. Do not edit by hand: change the schema and regenerate. -->

# app

Status: **active**.

Side: **both**: a client draws it and its work is done on the host, over its `reach.link`. A definition on any other side is refused. On both, it declares `reach.link`.

Its `reach.link` is exactly its bridge, no more and no fewer: calls `app.me`, `app.call`, `app.storage.get`, `app.storage.set`, `app.storage.delete`, `app.storage.list`; events `app.grantChanged`, `app.catalogChanged`. A definition that names anything else, or leaves one out, is refused.

A GApp: a UI that runs in its own window and talks to Genie only through the host, over the bridge, within what the person granted it. Its window draws it; its grant, storage and calls live in genie-host.

## Payload fields

| Field | Type | Required | Default | What it is |
|---|---|---|---|---|
| `entry` | path inside the package, like `app/index.html` | yes | — | The app's first page, one of the package's own signed files. |
| `window` | `{ width?, height?, minWidth?, minHeight?, resizable? }` | no | `{"width":1024,"height":720,"resizable":true}` | How its window opens. |
| `uses` | list of element ids | no | `[]` | The catalog elements it may call. Each is a grant the person sees at install, by its catalog name. |
| `storage` | `"none"` or `"app"` | no | `"app"` | Whether it keeps data in its own isolated store (50 MB). |
| `grantable` | boolean | no | `true` | Whether a GApp may be granted it. `false` for what only the person may do: an app that lists it is refused at install. |

## Example payload

```json
{
  "entry": "app/index.html",
  "window": {
    "width": 1024,
    "height": 720
  },
  "uses": [
    "com.example.notes.append"
  ],
  "storage": "app"
}
```

Every definition also carries the [envelope](../envelope.md).

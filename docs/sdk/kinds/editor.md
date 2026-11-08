<!-- Generated from src/core/catalog.ts by `npm run docs:sdk`. Do not edit by hand: change the schema and regenerate. -->

# editor

Status: **active**.

Side: **both**: a client draws it and its work is done on the host, over its `reach.link`. A definition on any other side is refused. On both, it declares `reach.link`.

Opens files of the extensions it claims in one vetted Fancy editor. Genie's own editor wins a claim by default; another is offered in Open with.

## Payload fields

| Field | Type | Required | Default | What it is |
|---|---|---|---|---|
| `extensions` | list of extensions, like `".md"` | yes | — | The file types it opens: a dot, then letters or digits. |
| `fancyEditor` | one of Editor, SheetWorkbook, DeckEditor | yes | — | The vetted Fancy editor that opens them. |
| `title` | string | no | — | The editor's name in Open with. |

## Example payload

```json
{
  "title": "Notes",
  "extensions": [
    ".md"
  ],
  "fancyEditor": "Editor"
}
```

Every definition also carries the [envelope](../envelope.md).

<!-- Generated from src/core/catalog.ts by `npm run docs:sdk`. Do not edit by hand: change the schema and regenerate. -->

# recipe

Status: **active**.

Side: set by each definition's `reach.side` (host or client).

A guided sequence of steps the person walks through.

## Payload fields

| Field | Type | Required | Default | What it is |
|---|---|---|---|---|
| `steps` | non-empty list of step objects | yes | — | The steps, in order. |

## Example payload

```json
{
  "steps": [
    {
      "tool": "com.example.notes.append"
    }
  ]
}
```

Every definition also carries the [envelope](../envelope.md).

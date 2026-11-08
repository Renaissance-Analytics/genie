<!-- Generated from src/core/catalog.ts by `npm run docs:sdk`. Do not edit by hand: change the schema and regenerate. -->

# flow-node

Status: **active**.

Side: set by each definition's `reach.side` (host, client or both).

A node in the Flows palette. The executor the payload names runs it.

## Payload fields

| Field | Type | Required | Default | What it is |
|---|---|---|---|---|
| `executor` | string | yes | — | What runs the node. |
| `inputs` | list of port names | no | `[]` | Its input ports. |
| `outputs` | list of port names | no | `[]` | Its output ports. |
| `grantable` | boolean | no | `true` | Whether a GApp may be granted it. `false` for what only the person may do: an app that lists it is refused at install. |

## Example payload

```json
{
  "executor": "com.example.notes.append",
  "inputs": [
    "text"
  ],
  "outputs": [
    "path"
  ]
}
```

Every definition also carries the [envelope](../envelope.md).

<!-- Generated from src/core/catalog.ts by `npm run docs:sdk`. Do not edit by hand: change the schema and regenerate. -->

# tool

Status: **active**.

Side: **host**: genie-host runs it. A definition on any other side is refused.

An MCP tool agents call. The host runs it with the handler the payload names; it appears in every agent's tool list under its id.

## Payload fields

| Field | Type | Required | Default | What it is |
|---|---|---|---|---|
| `handler` | string | yes | — | The host handler that runs the tool. |
| `inputSchema` | JSON Schema, `type: "object"` | yes | — | The tool's arguments. |
| `outputSchema` | JSON Schema object | no | — | What the tool answers, when it declares it. |
| `annotations` | object | no | — | MCP tool annotations (read-only, destructive…) passed to agents as declared. |
| `process` | `"worker"` or `"subprocess"` | no | `"worker"` | A plugin tool: where its handler runs, isolated from Genie. |
| `gated` | boolean | no | `false` | Each call waits for the person's approval first. |
| `grantable` | boolean | no | `true` | Whether a GApp may be granted it. `false` for what only the person may do: an app that lists it is refused at install. |

## Example payload

```json
{
  "handler": "com.example.notes.append",
  "inputSchema": {
    "type": "object",
    "properties": {
      "text": {
        "type": "string"
      }
    },
    "required": [
      "text"
    ]
  },
  "process": "worker",
  "gated": false
}
```

Every definition also carries the [envelope](../envelope.md).

<!-- Generated from src/core/catalog.ts by `npm run docs:sdk`. Do not edit by hand: change the schema and regenerate. -->

# workspace-settings-page

Status: **reserved**. Accepted and registered; nothing runs it yet.

Side: set by each definition's `reach.side` (host, client or both).

Reserved: accepted and registered, so a package that declares one loads, and nothing runs it yet. A later Genie release makes it run and adds its fields here.

## Payload fields

This family has no fixed payload fields of its own yet: its payload is any JSON object. Like every element, it may say:

| Field | Type | Required | Default | What it is |
|---|---|---|---|---|
| `grantable` | boolean | no | `true` | Whether a GApp may be granted it. `false` for what only the person may do: an app that lists it is refused at install. |

## Example payload

```json
{}
```

Every definition also carries the [envelope](../envelope.md).

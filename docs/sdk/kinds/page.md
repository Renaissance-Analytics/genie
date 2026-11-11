<!-- Generated from src/core/catalog.ts by `npm run docs:sdk`. Do not edit by hand: change the schema and regenerate. -->

# page

Status: **active**.

Side: set by each definition's `reach.side` (host, client or both).

A family a package may contribute. It has no fixed payload fields yet: its payload is any JSON object, and the Genie release that runs it adds them here.

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

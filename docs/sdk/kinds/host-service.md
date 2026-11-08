<!-- Generated from src/core/catalog.ts by `npm run docs:sdk`. Do not edit by hand: change the schema and regenerate. -->

# host-service

Status: **active**.

Side: **host** or **both**: genie-host runs it; or a client draws it and its work is done on the host, over its `reach.link`. A definition on any other side is refused. On both, it declares `reach.link`.

A service genie-host runs and keeps running with no window open (remote access, a relay). On both sides it has a client part, and its reach.link says how the two talk.

## Payload fields

| Field | Type | Required | Default | What it is |
|---|---|---|---|---|
| `start` | string | yes | — | The host handler that starts it. |
| `stop` | string | yes | — | The host handler that stops it. |
| `health` | string | yes | — | The host handler that answers whether it is healthy, and why not. |
| `settingsSection` | string | yes | — | The settings section it owns: its switches live there and nowhere else. |

## Example payload

```json
{
  "start": "com.example.relay.start",
  "stop": "com.example.relay.stop",
  "health": "com.example.relay.health",
  "settingsSection": "relay"
}
```

Every definition also carries the [envelope](../envelope.md).

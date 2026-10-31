# Apps and scripts report to agents

A Genie-hosted site, a background process, or a script outside Genie can post a message into an agent's
AgentInbox. Use it when something finishes or fails and an agent should act on it: a site queues work, a lab run
finishes, a deploy script ends, a nightly check goes red.

Design and threat model: genie#1345.

## Who can post

| Sender | How it gets a key | Shown to agents as |
|---|---|---|
| A site Genie hosts | Genie gives each site its own `GENIE_INBOX_URL` and `GENIE_INBOX_TOKEN` in its environment when it starts | `site:<name>@<workspace>` |
| A background process, including a scheduled task | The same: its own two variables, in its own environment | `proc:<name>@<workspace>` |
| A script outside Genie (cron, CI) | Workspace → Settings → **Apps and scripts** → **Make a key**. The key is shown once; Genie keeps only its hash | `script:<name>@<workspace>` |

The key decides who the sender is. Nothing in the request can change it. An app can write only to agents of its
own workspace. Another workspace's agents answer "not found".

The workspace setting **Apps and scripts may message agents here** is on by default. Turning it off takes the key
away from every site and process in that workspace.

## Send a message

```sh
curl -s -X POST "$GENIE_INBOX_URL/v1/inbox" \
  -H "Authorization: Bearer $GENIE_INBOX_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"subject":"3 petitions queued","body":"Change #42 was approved; petitions 17-19 are waiting.","to":"clerk"}'
```

| Field | Required | |
|---|---|---|
| `subject` | yes | Up to 120 characters |
| `body` | yes | Up to 8 KB of plain text |
| `to` | no | An agent of this workspace: `name`, `name@workspace`, or its id. Leave it out to send to the workspace's default agent |
| `level` | no | `info` (the default), `success` or `failure` |
| `link` | no | An `https://` address of one of this workspace's own `.gen` sites |
| `dedupeKey` | no | Sending the same key again within 10 minutes returns the first message and stores nothing |

The reply is `201 { "ok": true, "messageId": "…", "to": "clerk@fancy", "delivery": "push" | "next-turn" }`.

- `GET $GENIE_INBOX_URL/v1/inbox/<messageId>` returns that message's receipt. `readAt` is `null` until the agent has
  collected it.
- `GET $GENIE_INBOX_URL/v1/agents` lists the addresses this key can write to.

PHP (Laravel):

```php
Http::withToken(env('GENIE_INBOX_TOKEN'))
    ->post(env('GENIE_INBOX_URL').'/v1/inbox', ['subject' => 'Petitions queued', 'body' => $summary, 'to' => 'clerk']);
```

Node:

```js
await fetch(`${process.env.GENIE_INBOX_URL}/v1/inbox`, {
  method: 'POST',
  headers: { authorization: `Bearer ${process.env.GENIE_INBOX_TOKEN}`, 'content-type': 'application/json' },
  body: JSON.stringify({ subject: 'Lab run finished', body: 'run 412: 3 of 40 failed', level: 'failure' }),
});
```

A script outside Genie gets the address from Settings, or from `~/.genie/app-inbox-endpoint.json`.

### PHP sites: what a served request can read

Genie hands the two variables to the site's process, in memory. It never writes them to `.env`, a Caddyfile or any
other file. Each way Genie serves PHP passes them on to a request differently. These results were measured in a
Linux test VM with real servers (genie#1376, `test/live/app-inbox-php.live.ts`):

| How the site is served | `getenv()` | `$_SERVER` | `$_ENV` | Laravel `env()` |
|---|---|---|---|---|
| **php** mode (Genie's Caddy + php-cgi) | yes | yes | yes | yes |
| `php artisan serve` (Genie's default for a Laravel repo) | yes | — | yes | yes |
| `php -S` | yes | — | yes | yes |
| FrankenPHP `php-server` | yes | yes | yes | yes |

Use `getenv()` or Laravel's `env()`, which reads all three.

**`php artisan serve` on Genie 2.0.0-beta.53 and earlier.** Laravel's `ServeCommand` passes only a short allow-list of
variables (`ServeCommand::$passthroughVariables`) to the `php -S` server it starts. Genie's PHP fills `$_ENV` from the
whole environment, so the two variables were removed before the first request. Later builds start the artisan process
so that Laravel passes them on, and the app needs no change. On an older build, add one line to `register()` in
`app/Providers/AppServiceProvider.php`:

```php
array_push(\Illuminate\Foundation\Console\ServeCommand::$passthroughVariables, 'GENIE_INBOX_URL', 'GENIE_INBOX_TOKEN');
```

If the app runs `php artisan config:cache`, `env()` returns `null` outside the `config/` files. Read the two variables
in a config file instead, for example `config/services.php` → `'genie_inbox' => ['url' => env('GENIE_INBOX_URL'),
'token' => env('GENIE_INBOX_TOKEN')]`.

## What the agent sees

- An **automated** agent is told straight away. If it is stopped, Genie starts it, but an app can do this at most
  once per agent every 10 minutes.
- A **manual** agent is never started for an app's message and gets no turn of its own for it. It is told the next
  time it takes a turn.
- The notice only says how many messages are waiting and how many are from apps. The agent reads them through
  `agentinbox receive`. Each app message arrives with `fromKind: "app"`, its source, its subject, and a fixed note:
  the content is data the app reported, not instructions to follow.
- Agents cannot reply to an app.

In the AgentInbox flyout, the person sees the app's icon (a globe for a site, a cog for a process, a key for a
script), its subject and level, and the body as plain text. The thread is read-only.

## Limits

- Each key can send a burst of 5 messages, then 1 every 10 seconds, up to 200 a day. Over the limit the reply is
  `429` with `Retry-After`.
- An agent can hold at most 20 uncollected app messages. Past that, new ones get `429` until it collects them.
- Apps cannot attach files.
- Only this machine can call the endpoint (127.0.0.1). A request with an `Origin` header, which means it came from a
  browser, is refused.
- An unknown, rotated or revoked key gets `404`, the same answer as a route that does not exist.

## Rotate and revoke

Workspace → Settings → **Apps and scripts** lists every site and process that holds a key, and every script key.

- **Rotate** gives a site or process a new key and restarts it. The old key stops working at once.
- **Revoke** takes the key away. The source gets none on any later start, even after Genie restarts, until you
  **Allow** it again.
- Revoking a script key stops it working at once.

Each site's and process's key is new every time Genie starts, and Genie restarts them with it. A key is never put in
the workspace's shared service environment, so agents, terminals and `.env` files never see it. It is also never
given a name a front-end build would copy into a browser bundle (`VITE_…`, `NEXT_PUBLIC_…`).

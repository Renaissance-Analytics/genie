# Writing a Genie plugin

A Genie plugin is a small **npm-shaped package** with a `genie-plugin.json`
manifest at its root. The manifest declares the **MCP tools** the plugin adds to
Genie's agent-facing surface (and, optionally, **editor mappings** for file
types), plus the **capabilities** it needs. Genie loads the tool code in an
isolated worker and exposes each tool to agents as `${namespace}.${tool}`.

This page walks the **minimal loader-seam example** — `hello-world`, a plugin
with a single `greet` tool and no capabilities. It's the smallest thing that
proves the loader end-to-end: manifest → worker → tool result. Copy it as the
starting point for a real plugin.

> Signing/trust is covered in [plugin-signing.md](plugin-signing.md) — official
> plugins are Ed25519-signed **in CI**; you never handle the private key.

## Layout

```
my-plugin/
  ├── genie-plugin.json    the manifest (id, namespace, mcpTools, editors, capabilities)
  └── tools.cjs            the tools module — runs in the Genie plugin worker
```

## Example: `hello-world`

The two files below are the complete, verbatim source of the bundled example
(`main/plugins/examples/hello-world/`). Nothing else is required for a working
plugin.

### `genie-plugin.json`

```json
{
  "id": "ai.genie.hello-world",
  "namespace": "hello",
  "name": "Hello World",
  "version": "0.1.0",
  "description": "A trivial dev plugin that registers a single greeting tool — proves the Genie plugin loader seam end-to-end.",
  "publisher": { "name": "Genie", "url": "https://github.com/Renaissance-Analytics/genie" },
  "engines": { "genie": ">=0.7.0" },
  "entry": { "tools": "tools.cjs" },
  "agent": {
    "guide": "Use hello.greet when the user asks for a greeting or when verifying the Genie plugin MCP seam."
  },
  "mcpTools": [
    {
      "name": "greet",
      "description": "Return a friendly greeting. Pass an optional `name` to personalise it.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "name": { "type": "string", "description": "Who to greet (defaults to \"world\")." }
        },
        "additionalProperties": false
      },
      "run": "tools",
      "process": "worker",
      "gated": false
    }
  ],
  "editors": [],
  "capabilities": {
    "fs": { "scope": "none" },
    "network": { "hosts": [] },
    "genieApi": []
  }
}
```

### `tools.cjs`

```js
'use strict';

/**
 * Hello World plugin — tools module.
 *
 * Runs inside the Genie plugin WORKER (a utilityProcess). Each export named to
 * match a manifest `mcpTools[].name` is a handler `(args, bridge) => result`.
 * The `bridge` is the capability-scoped API (fs/net/log); this trivial tool
 * needs none. Return an MCP `{ content: [...] }` result, or a bare string that
 * the worker wraps into one.
 */

module.exports = {
    async greet(args) {
        const who = args && typeof args.name === 'string' && args.name.trim() ? args.name.trim() : 'world';
        return {
            content: [{ type: 'text', text: `Hello, ${who}! — from the Genie Hello World plugin.` }],
        };
    },
};
```

## Manifest fields

The manifest is validated **strictly** at install (`validatePluginManifest` in
`main/plugins/manifest.ts`) — a bad manifest is rejected loudly with an itemised
list of problems, never half-loaded. The key fields:

- **`id`** — reverse-DNS, globally unique (e.g. `ai.genie.hello-world`). When a
  plugin is listed by a marketplace, this must match the marketplace entry's id.
- **`namespace`** — a lowercase slug (`[a-z0-9]` with dashes). Every tool is
  exposed to agents as `${namespace}.${tool}` — here `hello.greet` — so the
  namespace keeps tool names from colliding across plugins.
- **`name`, `version`, `description`** — display name, semver, and a one-liner.
- **`engines.genie`** — the minimum Genie API version the plugin needs
  (semver range).
- **`entry`** — named entry modules keyed by a tool's `run`. `entry.tools`
  points at the module that exports the tool handlers (`tools.cjs` here).
- **`mcpTools[]`** — the tools the plugin contributes. Each entry:
  - `name` — the bare tool slug (namespaced at runtime).
  - `description` — what the tool does (agents read this to decide when to call it).
  - `inputSchema` — a JSON Schema **object** describing the arguments.
  - `run` — which `entry` module exports the handler (defaults to `tools`).
  - `process` — isolation for this tool: `worker` (the secure default, a Genie
    utilityProcess) or `subprocess`.
  - `gated` — when `true`, each call is routed through install/per-call consent.
- **`agent`** — required whenever `mcpTools` is non-empty. A plugin must ship
  an `agent.guide`: concise Markdown describing WHEN to reach for the plugin and
  what workflow its tools fit into. It is delivered two ways:
  - **In every contributed tool description** — the portable fallback, so any MCP
    client discovers the workflow with no extra support.
  - **As a repo-scoped agent skill**, written into the workspace whenever Genie
    syncs its MCP registration: `.agents/skills/genie-plugin-<namespace>/SKILL.md`
    for Codex and `.claude/skills/genie-plugin-<namespace>/SKILL.md` for Claude
    Code. Skills load on demand rather than sitting in context permanently, so
    this is the better home for a longer guide. Genie also writes its own
    `genie` skill alongside them.

  Everything under a skills root prefixed `genie-plugin-` is Genie-managed: it is
  rewritten on sync and removed when the plugin is disabled or uninstalled, so a
  stale skill never advertises tools that no longer resolve. Anything else in
  those directories is yours and is never touched.
- **`editors[]`** — optional. A plugin can **declare** (never ship) a first-party
  Fancy editor for a set of file extensions — a `package@version` + `export`
  that Genie loads from a vetted, integrity-pinned Fancy source. `hello-world`
  ships no editor, so this is `[]`. See the Slides/Sheets plugins in the
  marketplace for editor-mapping examples.
- **`capabilities`** — the grants the plugin needs, declared granularly and
  fail-closed:
  - `fs` — `{ "scope": "workspace" | "none", "extensions"?: [".pptx", …] }`.
    `none` (as here) means no filesystem access.
  - `network` — `{ "hosts": [...] }`. An empty list means no network.
  - `genieApi` — the explicit list of Genie APIs the plugin may call.

  Each grant is independent and user-toggleable; a tool that isn't granted a
  capability can't use it.

The handler module is plain CommonJS (`.cjs`): export one async function per
tool `name`. It receives `(args, bridge)` — `args` validated against
`inputSchema`, `bridge` the capability-scoped API — and returns an MCP result
(`{ content: [...] }`) or a bare string the worker wraps into one.

## Signing & trust

Genie treats a plugin as **official/trusted** only when its `genie-plugin.json`
carries a valid **Ed25519 signature** from a key in Genie's bundled trust root,
over an untampered code bundle. The private key never lives in a repo or on a
laptop — official plugins are signed **in CI** with the
`GENIE_PLUGIN_SIGNING_KEY` org secret, which writes `publisher.keyId`,
`integrity` (a hash of every code file), and a detached `signature` into the
manifest. Genie recomputes the integrity from the on-disk bundle and verifies
the signature at install/enable; a tampered file, tampered manifest, or unknown
key resolves to `untrusted` and is refused.

For **unofficial / developer** plugins you don't need the official key: sign with
your own keypair and add its public key under **Settings → Plugins → Developer
Mode**, or install unsigned in Developer Mode (which runs the plugin
network-restricted).

Full setup — minting the key, wiring the reusable signer Action, and the
commit-or-release-asset publish flow — is in
[plugin-signing.md](plugin-signing.md).

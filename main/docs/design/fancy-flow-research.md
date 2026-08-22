# fancy-flow — what it is, and what it would mean for Genie

Research note, 2026-08-22. Owner-requested 2026-08-21; see
`.ai/plans/genie-apps-tray-and-store.md` → "Later additions" → fancy-flow.

Nothing here is a design. This is what the registry, the published package and
Genie's own adjacent machinery actually say, written down before deciding
anything — because the standing rule is never to hand-roll what Fancy ships, and
that rule is only obeyable if you first know what it ships.

## 1. It exists, and it is a whole subsystem

`@particle-academy/fancy-flow`, **v0.48.0**, npm-installable, 16.8 MB unpacked.
The Fancy MCP lists it as a package with its own components:

| Component | What it is |
|---|---|
| `FlowEditor` | React canvas for authoring a graph (react-flow, bundled) |
| `FlowViewer` | Read-only by construction — canvas *or* list variant; renders run statuses |
| `runFlow` | Headless topological runner (`/engine`) |
| `useFlowRun`, `useFlowState` | Executor + controlled-state hooks |
| `FlowRunnerUx` | Flow→UX bridge — host effects become flow nodes (`/ux`) |

There is a PHP twin (`particle-academy/fancy-flow-php`) that runs the **same
`WorkflowSchema` JSON**. Genie does not need it, but its existence is why the
data model is strictly serializable — that matters below.

### Export map (v0.48.0)

`.`, `./runtime`, `./registry`, `./connectors`, `./schema`, `./layout`,
`./engine`, `./durable`, `./ux`, `./styles.css`, `./rich-input`,
`./llm/vercel-ai`, `./llm/prism`, `./fields/react-fancy`, `./screens`.

### Dependencies — Genie-relevant

- `dependencies`: `@particle-academy/fancy-auto-common` only.
- `peerDependencies`: `react` / `react-dom` `^19` (**required**), plus
  `@particle-academy/react-fancy >=3`, `@particle-academy/fancy-screens`,
  `@particle-academy/fancy-cms-ui`, `ai >=5` — **all four marked optional** in
  `peerDependenciesMeta`.

Genie already has `react ^19`, `react-dom ^19`, `react-fancy ^4.16.0`. So
`npm install @particle-academy/fancy-flow` is clean here: no new optional peers
need satisfying, and the required ones are already present.

## 2. The engine API — the part Genie would actually run

```ts
runFlow(
  graph: FlowGraph,                    // { nodes, edges } — serializable
  executors: ExecutorRegistry,         // Partial<Record<kind, NodeExecutor>>
  onEvent?: (e: RunEvent) => void,
  options?: RunOptions,
): Promise<RunResult>
```

The shape that decides everything downstream:

```ts
type ExecutorRegistry = Partial<Record<FlowNodeKind | string, NodeExecutor>>;

type NodeExecutor = (ctx: {
  node: FlowNode;
  inputs: Record<string, unknown>;
  abort: (reason?: string) => never;
  emit: (event: RunEvent) => void;
  depth?: number;
  run?: RunIdentity;      // ctx.run.stepKey(nodeId) = idempotency key
}) => Promise<unknown> | unknown;
```

**The engine ships no executors of its own for effectful work.** A graph is inert
data; the *host* supplies the registry that gives each node kind its meaning.
That single fact is the whole security story (§5).

`RunOptions` carries `timeoutMs`, an `AbortSignal`, `initialInputs`, `depth`, a
`run` identity, and `resumeOutputs` — a per-node checkpoint map where a listed
node is **republished, not re-executed**, so routing reproduces exactly.

`RunEvent` is a small closed union: `run-start`, `run-end`, `run-error`,
`node-status`, `node-output`, `log`. It maps onto a status feed with no
translation layer.

Also on `/engine`: `runCohort` (fan-out with a policy/guard), `findSubflowCycle`
(catch `A → B → A` before saving, given a host resolver), `runFixtures` /
`validateFixtureFile` (the cross-runtime parity harness), the pause codec
(`pauseForHuman`, `encodePause`/`decodePause`, `isPause`), and the node-manifest
validator.

`/durable` adds `replayUpTo`, a `NodeClaimStore` interface, retry policy,
`durableUserInput` / `durableApproval` executors and a coordinator — i.e. the
crash-safe, resume-from-checkpoint layer, with the store left to the host.

### 2.1 Three behaviours verified by running it, not by reading about it

Each of these was confirmed against the installed v0.48.0 under plain Node
(`import('@particle-academy/fancy-flow/engine')` resolves in 58 ms). They decide
the design, so they were tested rather than assumed.

**(a) The engine ships almost no executors.** Across every subpath, the only
executors exported are `llmBranchExecutor`, `llmRouterExecutor` and
`subflowExecutor` (`/registry`), plus `durableUserInput` / `durableApproval`
(`/durable`). The 27 builtin *kinds* — including `api_request` (arbitrary HTTP),
`webhook_out`, `tool_use`, `data_store`, `schedule_trigger`, `webhook_trigger` —
are **definitions only**: config schema, ports, label, editor UI. Nothing that
performs the effect.

So a builtin node with a frightening name is not dangerous by default. It is
dangerous only if a host implements it. `api_request` in a GApp's flow does
nothing at all unless Genie chooses to make it do something.

**(b) An unregistered kind fails CLOSED.** Running a graph with an empty
registry:

```
ok: false | error: "No executor registered for kind=trigger"
events: run-start → node-status:a=running → node-status:a=error → log → run-end
```

The run aborts, no outputs, and the failure is reported on the node. This
matches `decideAppCall`'s own stance — unclassified is denied, never implicitly
public — so the two systems fail the same way rather than in opposite
directions.

**(c) Executor lookup is by `node.type`, NOT by `data.kind`.** This is the one
genuinely surprising fact, and the most important.

`FlowNodeKind = "trigger" | "action" | "decision" | "output" | "note" |
"subgraph"` — six coarse kits. Registering under the precise namespaced kind
does nothing on its own:

| Registry | Result |
|---|---|
| `{ '@particle-academy/api_request': fn }` only | `ok: false` — "No executor registered for kind=trigger" |
| `{ action: coarse, '@particle-academy/api_request': precise }` | `coarse` runs; the precise entry is **never consulted** |

The coarse type always wins, and a kind-only registry never fires.

This is a footgun for a host that registers per-kind executors and expects
precise dispatch — they would be silently shadowed. But taken deliberately it is
the *better* security shape: Genie registers **one** `action` executor, and that
single function is where `data.kind` is read and mapped to a Genie tool. One
door, not one per node kind, so a node kind structurally cannot acquire its own
bypass.

**(d) `importWorkflow` is a coercer, not a validator.** `/schema` exports
`exportWorkflow`, `importWorkflow`, `migrateSchema`, `WORKFLOW_SCHEMA_VERSION`
(currently `1`) and `workflowToBlob` — useful for persistence and version
migration. But it does not reject bad input:

| Input | `importWorkflow` result |
|---|---|
| `"not a workflow"` | graph with 0 nodes |
| `{}` | graph with 0 nodes |
| `{ nodes: 'x', edges: [] }` | graph with 0 nodes |

Garbage degrades silently to an empty graph. So it is fine for *loading Genie's
own stored flows* and for schema migration, and **must not** be mistaken for the
gate on an app-supplied graph. Validating what an app may run stays Genie's own
job — which is the right place for it anyway, since only Genie knows the grant.

**(e) No `eval` / `new Function` in the engine.** Grepped across every chunk
`/engine` pulls in: zero occurrences. Combined with (a), that means the
`transform` node's expression evaluation is **unimplemented and therefore the
host's to supply**. Whoever implements it inherits that decision: a restricted
interpreter, not `eval` — the engine has not made the unsafe choice for us, and
Genie should not make it either.

## 3. Host capabilities — fancy-flow already has this concept

`registerLlmClient`, `registerWorkflowResolver`, and `capabilityStatus()`
returning `Record<"llm" | "workflow_resolver" | "document", boolean>`.

Node **manifests** declare `capabilities?: Record<string, "required" |
"optional">`, `sideEffects?: "none" | "idempotent" | "unsafe-to-replay"`, and
`pausesForHuman?`. `checkCapabilities(manifest, available)` answers *"what does
this graph need that I haven't wired?"* **before** a run fails halfway.

This is fancy-flow's own vocabulary for host services, and it is **not** an
authorization model — nothing in it asks *may this app do this*. Genie's
`APP_CAPABILITIES` answers a different question and the two must not be
conflated. Naming them apart matters (§5).

## 4. The marketplace nodes

21 non-connector marketplace nodes today, all `@particle-academy/*`, all
implementing **both** `ts` and `php`, all `verified: true`. Overwhelmingly
git/forge-shaped — and strikingly close to what Genie already does:

- **Working copy**: `git_status`, `git_branches`, `git_checkout`, `git_diff`,
  `git_log`, `git_pull`, `git_push` — the last three *"or propose it for
  approval"*.
- **Forge**: `git_repo`, `git_issue_{list,get,open,update,comment}`,
  `git_pr_{list,get,open}`, `git_pr_checks` (routes on CI state),
  `git_pr_compare`.
- **AI/UX**: `llm_input` (model writes the form a step pauses on), `llm_screen`
  (model builds the interface from host-registered components), `ui_effect`.

Plus 4 hidden vendor connector nodes across Resend, Telegram, Stripe.

Marketplace nodes are **vendored source** (`npx fancy-cli@latest add node <kind>`),
not published packages — copied in per runtime. The engine's own ~25 core
builtins ship with it and need no install.

`git_pr_checks`, `git_status` and `git_issue_list` are the ones worth noting:
Genie's IssueWatch already tracks issues, PRs and security alerts, and
`checkIssues` is already a granted capability. There is overlap to decide about,
not to accidentally duplicate.

## 5. Genie's own machinery this must not bypass

### 5.1 `decideAppCall` is the single gate (`main/apps/bridge-decision.ts`)

Every GApp call answers two questions in order — **WHAT** (is this tool covered
by a granted capability?) then **WHERE** (may this app act on that workspace?).
Unclassified tools are **denied**, not implicitly public; `UNGRANTABLE_TOOLS`
can never be granted at any level; revocation is immediate and total.

`main/apps/capabilities.ts` classifies *every* Genie tool into a capability or
into `UNGRANTABLE_TOOLS` **with a stated reason**, and a test asserts that
against `GENIE_TOOL_NAMES` — so adding a tool without deciding whether an app
may use it is a **build failure**. That property is the thing most worth
protecting here.

`dispatchAppCall(appId, {tool, args, workspaceId}, deps)` in `bridge.ts` is the
reusable seam: it resolves the grant, calls `decideAppCall`, prepares the call,
and dispatches into the *same* MCP handler the agent path uses. No parallel tool
implementation exists to drift.

### 5.2 The consequence for a flow engine, stated plainly

A `FlowGraph` is inert JSON. It becomes dangerous only through the
`ExecutorRegistry` the host hands `runFlow`. So a node that reaches Genie must
**not** get its own path to Genie's tools — its executor must call
`dispatchAppCall` for the owning app, so the flow inherits *exactly* the grant
the app holds, enforced by the code already under test.

A flow that could run `manageTerminals` for an app not granted **Run commands**
would be a second, laxer authority path beside the agent one — precisely what
`bridge-decision.ts`'s header says must never exist.

Two corollaries:

- **Naming.** fancy-flow's node-manifest `capabilities` (host *services*) and
  Genie's `APP_CAPABILITIES` (user *consent*) are different things. Keep the
  words apart or a reviewer will one day read one as the other.
- **Attribution.** `mustAttribute` capabilities (`imDone`/`agentinbox`,
  `ForceTheQuestion`) stamp the app's name. A flow that pauses for human
  approval is *exactly* a `ForceTheQuestion`-shaped act, so it inherits that
  requirement rather than inventing an unattributed prompt.

### 5.3 Adjacent systems that already exist

| System | What it does | Relationship |
|---|---|---|
| `manageProcess` | Supervised background processes + **cron** (5-field schedule) | Already the scheduler. A flow wanting "every morning" should be *triggered by* this, not grow a second cron. |
| Plugin **recipes** (`main/plugins/recipes.ts`) | Serializable declared `steps[]` (`form`/`choice`/`terminal`/`browser`), run by the renderer's WizardModal, gated on the `recipes` capability | The closest existing thing to a workflow. Linear, renderer-run, no branching, no durability. `wizards` is reserved with the same shape. Overlap to decide deliberately. |
| GApp manifest / consent | Declares capabilities; user consents at install | Where a flow's authority must come from. |
| IssueWatch / `checkIssues` | Tracks issues, PRs, security alerts | Overlaps the `git_*` marketplace nodes. |

## 6. One finding that contradicts the package's own description

The registry describes `/engine` as running *"with zero React on a server,
worker, or CLI"*. **In the v0.48.0 build that is not true.**

`dist/engine.js` imports `runFlow` from `dist/chunk-MJ3A3TAI.js`, and line 3 of
that chunk is a static, module-scope:

```js
import ReactExports, { createContext, forwardRef, memo, useMemo, useState, ... } from 'react';
import { jsx, jsxs, Fragment } from 'react/jsx-runtime';
import { createPortal } from 'react-dom';
```

The runner and the node registry's `renderBody` config UI landed in the **same
chunk**, so importing `/engine` pulls React, `react/jsx-runtime` and `react-dom`
into the module graph. Nothing evaluates the DOM at import time, so it *works*
under Node — and Genie ships React anyway, so it resolves — but:

- the claim should not be relied on for a truly React-free worker;
- main-process bundling has to tolerate those imports;
- it is worth reporting upstream rather than working around. **A local shim
  would be a bandaid** — the fix belongs in fancy-flow's chunking.

Verified by reading `dist/`; not inferred from the description.

## 7. What is settled, and what is not

**Settled by research:**

- fancy-flow is real, current, npm-installable, and its peer requirements are
  already met by Genie.
- The engine is host-driven: graphs are data, executors are the host's — and it
  ships virtually none, fails closed on an unregistered node, and dispatches
  through six coarse types, which together make a single-chokepoint `action`
  executor the natural shape (§2.1).
- It already models durability, pause/resume, idempotency keys, subflow cycles
  and cross-runtime parity — none of which should be hand-rolled.
- Genie has exactly one authority gate for apps, and it is reusable as-is.

**Open, and for the owner (not for an agent to assume):** how much surface to
build first — engine only, or the editor too; who may author a flow; whether
flows supersede plugin recipes; and where triggering lives relative to
`manageProcess` cron.

---

# The design (owner-approved, 2026-08-22)

Put to the owner before building, via ForceTheQuestion. Answers:

| Question | Decision |
|---|---|
| Scope | **Engine + full `FlowEditor`** |
| Ownership | **Both, GApp-owned first** |
| Triggers | **Manual + `manageProcess` cron in this PR** |
| Recipes | **Leave alone**; document the overlap, converge later |

Owner's note on triggers, which shapes the whole trigger design:

> Ops running should not be tied to an agent request unless it's a manual
> trigger. We need to support several triggers, including time based triggers.
> so if any time based triggers exist, a cron checker should auto be started.

## The one-door principle

Everything below follows from §2.1(c): `runFlow` dispatches on the six coarse
node types, never on `data.kind`. Genie therefore registers **one** `action`
executor, and that function is the only place a flow can reach Genie. It reads
`data.kind`, resolves the Genie tool, and calls `dispatchAppCall` — the same
gate the GApp bridge uses, unchanged.

A flow is consequently bounded by *exactly* the grant its app already holds.
There is no flow permission model, no second consent screen, and nothing to keep
in sync. A flow can do less than its app, never more.

## Node kinds are DERIVED from the capability model

Genie's flow palette is generated from `APP_CAPABILITIES` — one node kind
`genie.<tool>` per classified tool. This is deliberate:

- A tool that is not classified into a capability **cannot appear as a node at
  all**, so `capabilities.ts`'s build-failure property extends to flows for free.
- `UNGRANTABLE_TOOLS` produce no node kind, so they are unreachable by
  construction rather than by a check somebody has to remember.
- The editor palette an app author sees is *already* filtered to what that app
  was granted — the canvas cannot offer a step that will refuse at run time.

Nothing is hand-maintained; a new Genie tool becomes a flow node the moment it
is classified, and never before.

## Admission: decide the whole graph before running any of it

`decideFlowAdmission(graph, grant)` is pure, and runs before the first node.
Because a graph is inert data and every step names its tool structurally, Genie
can answer *"may this app run this flow at all?"* up front, and say which
capabilities it uses and which node is the problem.

This is not the enforcement — `dispatchAppCall` in the executor is, and it stays
even for an admitted graph, because a graph could be mutated between admission
and run. Admission is fail-fast and honest UX: refusing at node 7 after six
irreversible side effects is a worse answer than refusing at node 0.

## Triggers self-start; they do not wait for an agent

Per the owner's note, a flow with a time-based trigger is Ops, not a favour an
agent does you. So:

- Trigger declarations are read off the graph's `trigger` nodes — `manual`,
  `schedule` (cron), `webhook`.
- **Manual** is the only trigger tied to a request.
- On boot, and whenever a flow is saved, Genie reconciles the set of scheduled
  flows and **auto-starts a cron checker** through the existing `manageProcess`
  scheduler if any time-based trigger exists — and stops it when the last one
  goes away. No user wiring, no agent involvement.
- `manageProcess` stays the only scheduler in Genie. The flow layer contributes
  *what to run*, never a second cron implementation.

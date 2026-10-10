# genie2

A rebuild of Genie. **An agent is a session. A session is not a terminal.**

Build specification: `.ai/plans/genie-2-spec-from-scratch.md` in the `tynn.ai` envelope.

## The rule this repository exists for

No agent process is ever attached to a pty — for any reason, including "an unused one".
`AgentEngine` has one member and no `'pty'`, so the state is unrepresentable rather than
merely avoided. The only TUI path is **Take Over**, which opens a terminal in its own window
with Genie's MCP available; Genie does not start, manage, restart or revive it.

## Layers

```
PROVIDER     @particle-academy/prism-acp       ClaudeDriver, CodexDriver — spawn, speak ACP
DURABILITY   @particle-academy/prism-harness   Thread + FileSessionStore ONLY (not AgentRuntime)
SURFACE      genie2                            renders the session model; never parses bytes
```

`prism-harness`'s `AgentRuntime` assumes Prism is the agent (`LlmClient = (req) => Promise<res>`)
and has zero knowledge of ACP. Genie's agent is an external CLI owning its own thread over a
streaming protocol, so only the durability half applies — confirmed as the intended seam by
that package's author.

## Commands

```
npm test              # 406 unit tests, ~2s
npm run typecheck     # tsc; the no-pty rule lives in the type system, so this is a gate
npm run build         # renderer (vite) + main (ESM) + preload (CJS — a sandboxed preload
                      # supports only CommonJS; an ESM one loads as nothing)
npm run verify        # typecheck + test + build
```

### Verification that is not a unit test

```
bash scripts/verify-linux.sh   # the whole gate on real Linux, in a container, ~40s
bash scripts/smoke-linux.sh    # OPEN THE APP: a real window under Xvfb, driven over CDP
npm run verify:live            # a real claude session: start, reply, persist, stop, process scan
npm run verify:flow            # real frames -> ledger rows -> the row a person reads
```

**`smoke-linux.sh` is the one that matters.** The build this replaces shipped four releases on
green unit suites and every one was broken the moment somebody opened it, because nobody ever
opened it. It runs on every push too, as a CI job called *a real window*, and uploads
screenshots — looking at them has found five defects no test caught, including a Dashboard with
no empty state and an entire application rendering in one font.

`verify:live` and `verify:flow` need the provider binary and spend real subscription tokens, so
they are deliberately not part of `npm test`. Run them before anything is tagged.

### Nothing GUI runs on the owner's desktop

Not a browser, not Electron, not a dev server. Every check above either runs headless in a
`--rm` container or on CI. That is a standing rule of this workspace, not a preference.

## Where things are

```
src/core/      every DECISION, as pure functions — tested without a DOM
src/main/      Electron main: registry, sessions, store, paths, upgrade
src/renderer/  React surfaces; they render and decide nothing
scripts/       verification that needs a machine rather than a test runner
docs/          the decisions the spec left to the builder, and why
```

The split is load-bearing: a decision taken inside a component is a decision nobody checks, and
that is where the previous build kept most of them.

## State

`.ai/plans/genie-2-build-status.md` in the envelope says what is built, what is verified, **how
it was verified, and what is not**. That separation is the point — four releases shipped on
"the tests pass".

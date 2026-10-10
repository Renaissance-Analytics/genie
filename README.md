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
npm test        # vitest
npm run typecheck
```

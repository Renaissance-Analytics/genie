/**
 * The ACP agent Genie spawns — our own host over `@particle-academy/prism-acp`.
 *
 * ACP runs on stdio: the client starts this process and the two exchange NDJSON on its
 * stdin and stdout. `prism-acp` is a LIBRARY (its `exports` offers `import` and no `bin`),
 * so the entry point is ours rather than a package's shim.
 *
 * That is a feature, not a workaround. A published `bin` on Windows is a `.cmd` shim which
 * re-enters whatever `node` happens to be first on PATH — silently defeating Genie's choice
 * of runtime, which is the whole point of launching with `process.execPath`. Owning the
 * entry removes the shim from the picture entirely.
 *
 * **`.mjs` on purpose.** `prism-acp` is ESM-only and Genie's `main` is CommonJS, so a `.js`
 * file here could not import it and the failure would surface at spawn as a hung handshake.
 *
 * Nothing is configured here. Auth travels in the environment and `~/.claude`, never in the
 * protocol — which is what makes the provider SUBSCRIPTION work with no API token — and the
 * env is built by the caller in `agent-spec.ts` (allow-list first, outranking credentials
 * stripped). This file only joins the library to the pipes.
 */

import { ClaudeDriver, probeSessionStore, serve } from '@particle-academy/prism-acp';
import { probeIsTrustworthy } from './probe-trust.mjs';

/**
 * REFUSE A RESUME AT LOAD, when the probe can be trusted here.
 *
 * prism-acp 0.4.0's `probeSession` turns a `session/load` for a conversation that does not exist
 * into a named `invalid_params` refusal, instead of an agent that comes up "resumed" and then
 * dies on its FIRST PROMPT — a failure Genie asked for because the late form is indistinguishable
 * from any other and quietly loses a conversation.
 *
 * Gated, because `probeSessionStore` reads `~/.claude/projects` and does not look at
 * `CLAUDE_CONFIG_DIR`, which Genie forwards deliberately and the CLI honours. See
 * `./probe-trust.mjs` — on an installation where those disagree the probe would call a live
 * conversation absent and refuse a resume that would have worked, which is the worse of the two
 * failures. Omitting it is exactly 0.3.0's behaviour.
 */
const probeSession = probeIsTrustworthy(process.env) ? (id) => probeSessionStore(id) : undefined;

const served = serve({
    input: process.stdin,
    output: process.stdout,
    driverFactory: (opts, events) => new ClaudeDriver({ ...opts, cwd: opts.cwd }, events),
    // Spread rather than `probeSession,`: the option is OPTIONAL and passing `undefined`
    // explicitly is the same as passing it, but reads as though a probe was intended.
    ...(probeSession ? { probeSession } : {}),
    /**
     * A frame that arrived and could not be used.
     *
     * stdout is the PROTOCOL — writing a diagnostic there would corrupt the stream it is
     * reporting on — so this goes to stderr, which Genie captures.
     */
    onProtocolError: (sessionId, problem) => {
        process.stderr.write(`[prism-acp] ${sessionId}: ${problem}\n`);
    },
});

// Exit when the client closes the pipe. Without this the process outlives its parent and
// becomes the orphan class that has already cost this machine real memory — a test runner
// held 12.5 GB for six days because nothing reaped what was spawned.
served.closed.then(
    () => process.exit(0),
    (err) => {
        process.stderr.write(`[prism-acp] stream ended badly: ${err?.message ?? String(err)}\n`);
        process.exit(1);
    },
);

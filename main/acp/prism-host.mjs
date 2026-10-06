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

import { ClaudeDriver, serve } from '@particle-academy/prism-acp';

const served = serve({
    input: process.stdin,
    output: process.stdout,
    driverFactory: (opts, events) => new ClaudeDriver({ ...opts, cwd: opts.cwd }, events),
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

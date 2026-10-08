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

import {
    ClaudeDriver,
    CodexDriver,
    probeSessionStore,
    serve,
} from '@particle-academy/prism-acp';

/**
 * WHICH PROVIDER this child is driving, from the env `agent-spec.ts` built.
 *
 * prism-acp 0.5.0 ships a Codex driver beside the Claude one, so this script is no longer
 * claude-only. The provider arrives in the environment rather than as an argv flag for the same
 * reason everything else does: `acpEnv` is an allow-list and the argv is `[script]` and nothing
 * else, so adding a flag would mean two places that decide how this child is launched.
 *
 * Defaulting to claude keeps an older spec — one whose env predates this variable — working
 * exactly as it did, rather than refusing to start over a missing hint.
 */
const provider = (process.env.GENIE_ACP_PROVIDER ?? 'claude').trim();

/**
 * REFUSE A RESUME AT LOAD, rather than letting it die on the first prompt.
 *
 * `probeSession` turns a `session/load` for a conversation that does not exist into a named
 * `invalid_params` refusal. Genie asked prism for it: without it the load RETURNED SUCCESS and the
 * CLI's `No conversation found with session ID` arrived a turn later, where nothing could act on
 * it — indistinguishable from any other late failure, and it quietly loses a conversation.
 *
 * ## It was gated for one release, and the gate is gone
 *
 * 0.4.0's probe read `~/.claude/projects` and ignored `CLAUDE_CONFIG_DIR` — which Genie forwards
 * deliberately (the subscription credential lives there) and the CLI honours. On an installation
 * where those differ it would have called a live conversation absent and refused a resume that
 * would have worked, so Genie passed the probe only where its assumption held. Reported; 0.4.1
 * resolves the store the way the CLI does, and prism found the sharper version of it — their own
 * `ClaudeDriver.start()` already passed that variable to the child, so the driver and the probe
 * disagreed about where one store was.
 *
 * ## No options, and that is the correct call HERE specifically
 *
 * prism's warning is that a caller who builds the child's env itself must hand the same object to
 * the probe. This file IS the child: `startAcpAgent` spawns it with the allow-list env from
 * `main/acp/agent-spec.ts`, so `process.env` here is exactly that env, and the default — read this
 * process's environment — is right by construction rather than by luck.
 */
/**
 * CLAUDE ONLY. prism says so explicitly: *"Omit `probeSession` for Codex — that helper reads
 * claude's store, and Codex checks its identity by resuming the captured thread id."*
 *
 * Pointing it at a codex session id would read `~/.claude/projects`, find nothing, and refuse a
 * resume that would have worked — the exact failure the gate before it existed to avoid, arrived at
 * from the other side.
 */
const probeSession = provider === 'claude' ? (id) => probeSessionStore(id) : undefined;

const served = serve({
    input: process.stdin,
    output: process.stdout,
    driverFactory: (opts, events) =>
        provider === 'codex'
            ? new CodexDriver(opts, events)
            : new ClaudeDriver({ ...opts, cwd: opts.cwd }, events),
    // Omitted for codex — see above. Passing `undefined` explicitly is the same as passing it, but
    // reads as though a probe was intended.
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

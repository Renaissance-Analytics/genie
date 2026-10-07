import { spawn } from 'node:child_process';
import { prismHostPath } from './resolve-adapter';
import { acpRegistry } from './registry';
import { AcpSessionDriver } from './session';
import { startAcpAgent, type ChildLike } from './spawn';

/**
 * Start an ACP agent for a terminal spec, and register it so Genie sees it as alive.
 *
 * The impure wiring, deliberately thin: every decision it touches is tested elsewhere —
 * the launch grammar and env in `agent-spec`, the refusals in `spawn`, the handshake in
 * `session`, liveness in `registry`. What is left here is forwarding, plus the one thing
 * that has to happen in a particular ORDER.
 *
 * **Register before the handshake.** `isTerminalLive` is what the roster, the agent cap,
 * drain and triage ask, and the handshake takes a moment. An agent that is spawning but
 * not yet registered reads as DEAD to all of them — long enough for drain to let an
 * upgrade proceed over it, or for triage to prescribe a restart for something that is
 * coming up perfectly well.
 */

export interface StartedAcpAgent {
    driver: AcpSessionDriver;
    pid: number | undefined;
}

export function startAcpForSpec(input: {
    specId: string;
    provider: string;
    cwd: string;
    /** Subscription unless the owner has deliberately configured an API key. */
    auth?: 'subscription' | 'api-key';
    onStderr?: (line: string) => void;
    /**
     * Where `session/update` notifications go.
     *
     * A PORT, so this file keeps importing neither the session store nor the database, and
     * so the subscription can be asserted without starting a child process.
     *
     * Its absence is why the declared path was dead: the driver was constructed with an
     * `onNotification` dep it never called, the returned driver was discarded by the caller,
     * and `applySessionUpdate` — the mapper for all twenty update kinds — had no production
     * caller at all. The transport talked; nothing listened.
     */
    onSessionUpdate?: (update: unknown) => void;
    /**
     * The turn finished — `session/prompt` resolved.
     *
     * A port for the same reason as `onSessionUpdate`: this file imports neither the session
     * store nor the database. ACP has no turn-over notification, so a resolve is the only
     * signal, and without it `turn-ended` telemetry never fires and every turn looks like it
     * is still running.
     */
    onTurnEnded?: () => void;
    /**
     * Continue THIS conversation instead of opening a new one.
     *
     * The provider's own session id, from `meta.chat_session_id` — captured out of
     * `META_CLI_SESSION_ID` on an earlier run. Absent means there is nothing to continue
     * (a first launch, or a provider that never reported one), and the session starts fresh.
     */
    resumeSessionId?: string | null;
}): StartedAcpAgent | { error: string } {
    const started = startAcpAgent(
        { provider: input.provider, cwd: input.cwd, auth: input.auth ?? 'subscription' },
        {
            spawn: (command, args, env, cwd) =>
                spawn(command, args, {
                    cwd,
                    // EXACTLY the env `acpEnv` built. Nothing inherited behind its back —
                    // that allow-list is what keeps an ambient ANTHROPIC_API_KEY from
                    // silently billing per token while the surface says "subscription".
                    env,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    windowsHide: true,
                }) as unknown as ChildLike,
            // The runtime the child will run on is THIS process's, which is Electron's
            // Node — never the pty host's standalone 20.x, whose version is pinned to an
            // ABI-matched node-pty prebuild.
            nodeVersion: () => process.version,
            nodeExec: () => process.execPath,
            hostScript: () => prismHostPath(),
            hostEnv: () => process.env as Record<string, string | undefined>,
            onStderr: input.onStderr,
        },
    );

    if ('error' in started) return started;

    const driver = new AcpSessionDriver({
        request: (method, params) => started.client.request(method, params),
        notify: (method, params) => started.client.notify(method, params),
        onRequest: (method, handler) => started.client.onRequest(method, handler),
        onNotification: (method, cb) => started.client.onNotification(method, cb),
    });

    // BEFORE the handshake: see the note above.
    //
    // The DRIVER's prompt goes in, not just a kill handle. Without it
    // `AcpSessionDriver.prompt()` has no production caller, so a session can be started and
    // observed and never talked to — and since ACP is the mechanism rather than a mode, that
    // is every Claude agent, unreachable and silent about it.
    acpRegistry.register(input.specId, {
        kill: started.kill,
        get closed() {
            return started.client.closed;
        },
        prompt: async (text) => {
            const outcome = await driver.prompt(text);
            // The turn is over when `session/prompt` RESOLVES — ACP has no "turn over"
            // notification. Reported here because this is the only place that sees the
            // resolve, and the telemetry would otherwise record turns that start and never
            // end.
            input.onTurnEnded?.();
            return outcome;
        },
    });

    /**
     * SUBSCRIBE BEFORE THE HANDSHAKE.
     *
     * `session/new` can be answered with updates already in flight, and a notification that
     * arrives before the listener is attached is simply lost — there is no replay. Attaching
     * first costs nothing and is the difference between a transcript that starts at the
     * beginning and one missing its first chunks.
     */
    if (input.onSessionUpdate) {
        started.client.onNotification('session/update', (params) => {
            try {
                input.onSessionUpdate!(params);
            } catch (err) {
                // Never throw inside a notification handler: it tears down the subscription
                // and the agent silently stops reporting for the rest of its life.
                console.warn(`[acp] session/update for ${input.specId} was not applied:`, err);
            }
        });
    }

    // Fire and forget: the handshake's failure belongs on the agent's own surface, not in
    // the caller's control flow — `createAgentTerminal` has already returned a terminal by
    // the time this settles, exactly as the pty path has.
    const resumeId = input.resumeSessionId?.trim();
    const begin = resumeId
        ? driver.resume({ cwd: input.cwd, sessionId: resumeId })
        : driver.start({ cwd: input.cwd });

    void begin.catch((err) => {
        // A REFUSED RESUME IS NOT A DEAD AGENT. prism-acp refuses a load for a session that
        // is still running, and refuses an ACP id with a message naming the right key —
        // neither is a reason to leave the agent with no session at all. Falling back to a
        // fresh start keeps it usable and says so, rather than leaving a window that accepts
        // prompts into nothing.
        if (resumeId) {
            console.warn(
                `[acp] could not resume ${input.specId} (${String(err)}) — starting a fresh ` +
                    'conversation instead; the previous one is not lost, only not continued.',
            );
            void driver.start({ cwd: input.cwd }).catch(() => {});
        }
        // The channel will report closed through the registry, which is what the roster
        // and triage read. Swallowing here keeps an unhandled rejection out of the main
        // process; it does not hide the failure from anything that looks.
    });

    return { driver, pid: started.pid };
}

import { spawn } from 'node:child_process';
import { adapterScriptOf } from './resolve-adapter';
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
            adapterScript: (pkg) => adapterScriptOf(pkg),
            hostEnv: () => process.env as Record<string, string | undefined>,
            onStderr: input.onStderr,
        },
    );

    if ('error' in started) return started;

    // BEFORE the handshake: see the note above.
    acpRegistry.register(input.specId, {
        kill: started.kill,
        get closed() {
            return started.client.closed;
        },
    });

    const driver = new AcpSessionDriver({
        request: (method, params) => started.client.request(method, params),
        notify: (method, params) => started.client.notify(method, params),
        onRequest: (method, handler) => started.client.onRequest(method, handler),
        onNotification: (method, cb) => started.client.onNotification(method, cb),
    });

    // Fire and forget: the handshake's failure belongs on the agent's own surface, not in
    // the caller's control flow — `createAgentTerminal` has already returned a terminal by
    // the time this settles, exactly as the pty path has.
    void driver.start({ cwd: input.cwd }).catch(() => {
        // The channel will report closed through the registry, which is what the roster
        // and triage read. Swallowing here keeps an unhandled rejection out of the main
        // process; it does not hide the failure from anything that looks.
    });

    return { driver, pid: started.pid };
}

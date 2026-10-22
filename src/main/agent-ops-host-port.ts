import type { AgentOpsPorts } from './agent-ops-host.js';
import type { SessionHost } from './session-host.js';

/**
 * THE SESSION HOST AS AGENT OPERATIONS SEE IT — the one place the real `SessionHost` is wired into `AgentOpsPorts.host`.
 *
 * main.ts builds its agent-ops ports with this, and the tests that drive `restartAgent` / `switchDriver` against a real
 * host use it too, so a method the wiring forgets is forgotten in the tests as well. `host` is late-bound: main.ts
 * creates the session host after the ports.
 */
export function sessionHostPort(host: () => SessionHost | null): AgentOpsPorts['host'] {
    return {
        start: (record, cwd) => host()!.start(record, cwd),
        stop: (id) => host()!.stop(id),
        // How the last stop ended, once it has: restart and switch wait on it. Missing here, the wait was a no-op and a
        // Claude restart inside its stop grace was refused "still stopping", with nothing to retry it (2026-10-22).
        ended: (id) => host()!.ended(id),
        probe: (id) => host()!.probe(id),
        // A running agent's own models, and a switch with no restart (prism-acp 0.22).
        modelState: (id) => host()?.modelState(id) ?? null,
        switchModel: (id, model) => host()?.switchModel(id, model) ?? null,
    };
}

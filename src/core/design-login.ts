import type { StreamEvent } from './stream-event.js';

/**
 * CLAUDE DESIGN'S OWN LOGIN (#1081; the owner, 2026-10-21: "it needs a better UX for handling that just like our initial
 * login trap so users don't have to figure out what to do").
 *
 * MEASURED in a real ledger that day: a session agent's DesignSync call ended as a FAILED tool row (`name: null`) whose
 * output reads "DesignSync needs design-system authorization, and /design-login cannot run in this non-interactive
 * session. Ask the user to run /design-login once from an interactive Claude Code session on this machine — headless and
 * SDK runs here then reuse that authorization." So the authorization is per MACHINE, and the refusal names itself.
 *
 * What this is NOT: a provider sign-out. The agent's turn goes on (the tool failed, the turn did not), and there is no
 * status command for it, so nothing here claims the login worked: when the login window ends, the agents that waited are
 * told to retry, and a retry that is refused again raises the prompt again (`AgentSession`).
 */

/** The login window's key (main/login-host.ts) and its route's `login=` (the Take Over window's notice). */
export const DESIGN_LOGIN = 'claude-design';

/** The refusal's own words — the part that names `/design-login`, not the tool's name, which a later tool may share. */
const REFUSAL = '/design-login cannot run in this non-interactive session';

/** A failed tool whose output is Claude Design's refusal for want of `/design-login`. Anything else is not. */
export function designLoginRefused(event: StreamEvent): boolean {
    return event.kind === 'tool' && event.status === 'failed' && typeof event.output === 'string' && event.output.includes(REFUSAL);
}

/** What each agent that waited is told when the Claude Design login window ends. Honest: it was RUN, not verified. */
export const DESIGN_LOGIN_RAN =
    'Claude Design login was run on this machine. Retry what needed it (the call that asked for /design-login). If it is refused again, say so: Genie will offer the login again.';

/** The host's side of telling them (main/session-host.ts). */
export interface DesignLoginPort {
    designLoginAgents(): readonly string[];
    clearDesignLogin(agentId: string): void;
    prompt(agentId: string, text: string, by: string | null): boolean;
}

/** Every agent waiting on the login: cleared, then told to retry, by Genie. Answers who was told. */
export function tellDesignLoginRan(port: DesignLoginPort): string[] {
    const ids = [...port.designLoginAgents()];
    for (const id of ids) {
        port.clearDesignLogin(id);
        port.prompt(id, DESIGN_LOGIN_RAN, 'genie');
    }
    return ids;
}

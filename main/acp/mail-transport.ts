import type { WorkspaceAgentTransport } from '../db';
import type { HarnessTransportPayload } from '../agentinbox/harness-transport';
import type { AcpSessionEntry } from './registry';

/**
 * An ACP session as an AgentInbox harness transport.
 *
 * ## Why this exists
 *
 * AgentInbox delivers mail into a harness through one of two native transports, and both are
 * properties of a provider's CLI: the Claude Channel (`pull`, loaded only when the launch line
 * carries `--dangerously-load-development-channels`) and the Codex App Server (`push`).
 *
 * An ACP session has no launch line — claude's ACP launch is prism's adapter under node, with
 * no Claude Code flags at all — so the channel cannot bind for one. Making ACP the default
 * therefore removed the push transport from every claude agent, and removed it SILENTLY: mail
 * still queued durably and the agent still found it on its next `receive`. Nothing failed; it
 * simply stopped arriving.
 *
 * The session itself is the replacement, and a better one. It is a `push`, so the agent ACKs
 * what it was handed, where the channel could only ever prove a write (genie#549). It needs no
 * flag, so there is no silent-misconfiguration case. And it is already running — the transport
 * is the connection Genie is using anyway.
 *
 * Pure, with the registry and the prompt injected, because this is the part worth testing:
 * the wiring in `main/terminal/ipc.ts` is one line in a file with no test.
 */

/** `WorkspaceAgentTransport` is widened for this; `native_transport` holds it, so no
 *  migration is involved — the CHECK on the legacy `transport` column takes NULL. */
export const ACP_SESSION_TRANSPORT: WorkspaceAgentTransport = 'acp-session';

export interface AcpMailPorts {
    /** The live session's prompt, or null when there is none for this spec. */
    promptFor: (specId: string) => AcpSessionEntry['prompt'] | null;
    /** `HarnessTransportRegistry.bind` — a PUSH binding. */
    bind: (
        agentId: string,
        kind: WorkspaceAgentTransport,
        send: (payload: HarnessTransportPayload) => Promise<void>,
    ) => void;
}

/**
 * Turn a session prompt into the registry's `send`.
 *
 * REJECTING matters as much as sending. The registry unbinds a push transport whose `send`
 * throws and leaves the message queued, so a rejection is how an agent falls back to reading
 * its own inbox. Resolving on a refused prompt would ACK mail that never arrived — the
 * message would be marked delivered and never seen again, which is strictly worse than no
 * transport at all.
 */
export function acpMailSender(
    prompt: AcpSessionEntry['prompt'],
): (payload: HarnessTransportPayload) => Promise<void> {
    return async (payload) => {
        // `submitted` is a PTY concept — the Enter after a bracketed paste. An ACP prompt is
        // one call, so `delivered` is the only honest signal here.
        const result = await prompt(payload.text);
        if (!result.delivered) {
            throw new Error('The ACP session did not take the message.');
        }
    };
}

/**
 * Bind this agent's mail to its ACP session. Returns whether a binding was made.
 *
 * Refuses in both of the cases where binding would be a lie — no live session to prompt, and
 * no AgentInbox identity to bind under. Either would tell AgentInbox the agent's mail was
 * being delivered somewhere, which is the exact suppression genie#528 is about: the notice
 * that could have reached the agent is held back in favour of a transport that cannot carry
 * it.
 */
export function bindAcpMailTransport(
    ports: AcpMailPorts,
    args: { specId: string; agentId: string | null | undefined },
): boolean {
    if (!args.agentId) return false;
    const prompt = ports.promptFor(args.specId);
    if (!prompt) return false;
    ports.bind(args.agentId, ACP_SESSION_TRANSPORT, acpMailSender(prompt));
    return true;
}

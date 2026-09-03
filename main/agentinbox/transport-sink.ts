import { harnessTransportRegistry, type HarnessTransportRegistry } from './harness-transport';
import type { AgentInboxMessage, AgentInboxNotifyTarget } from './types';

/**
 * The broker's `transportSink` — how an AgentInbox message reaches an agent
 * over its harness's OWN channel instead of its terminal's keyboard.
 *
 * Lives here rather than inline in background.ts so the routing decision is
 * testable without an Electron main process. background.ts still owns the
 * wiring; this owns only the decision.
 *
 * The three answers the broker understands (see `deliverToHarness`):
 *
 *  - `false`  — declined. No harness transport at all, so the PTY nudge is the
 *               fallback, with every draft-safety rule that comes with it.
 *  - `true`   — delivered, and Genie ACKs on the agent's behalf.
 *  - nothing  — the adapter took it and the ACK is the agent's own. The agent
 *               is attached, so nothing may be typed at its prompt.
 */
export function createHarnessTransportSink(
    registry: HarnessTransportRegistry = harnessTransportRegistry,
): (
    target: AgentInboxNotifyTarget,
    msg: AgentInboxMessage,
) => boolean | Promise<boolean> | void {
    return (target, msg) => {
        const mode = registry.deliveryModeFor(target.agentId);
        // No live harness connection of any kind. THIS is what the PTY nudge is
        // for, and the only thing it is for.
        if (!mode) return false;
        // PULL (Claude Channel): the bridge holds a blocking `receive` on the
        // durable inbox, and `send` has already settled it with this message.
        // It ACKs only once its own stdout accepts the notification, so Genie
        // neither pushes nor ACKs here — it answers "attached", which is what
        // keeps the notice off the agent's keyboard.
        //
        // Gating this on `codex-app-server` was genie#344: a live Claude
        // Channel was told `false`, the broker read that as "the harness
        // declined", and typed the notice into the prompt — where it is
        // indistinguishable from the human.
        if (mode === 'pull') return undefined;
        // PUSH (Codex App Server): the delivery promise resolves only after App
        // Server accepts turn/start, so its `ok` is a real receipt to ACK on.
        return Promise.resolve(
            registry.deliver(target.agentId, {
                text: msg.text,
                messageId: msg.id,
                from: msg.from,
                fromLabel: msg.fromLabel,
                priority: msg.interrupt ? 'high' : 'normal',
            }),
        ).then((result) => result.ok);
    };
}

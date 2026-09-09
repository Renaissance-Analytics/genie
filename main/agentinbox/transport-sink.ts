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
 *  - nothing  — the adapter TOOK it and cannot say it arrived. Nothing is typed
 *               at the prompt (the agent probably has it), but the message stays
 *               unread and the five-minute deadline arms behind it (genie#549).
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
        // There is nothing to push to and nothing to ACK on — the bridge writes
        // a notification Claude Code answers nothing to, so no receipt exists in
        // this direction at all (genie#549). Answering "took it, unconfirmed" is
        // what keeps a second copy off the agent's keyboard while leaving the
        // message unread until the agent itself reads it.
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

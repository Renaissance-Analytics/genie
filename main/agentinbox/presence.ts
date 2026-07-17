import { broadcastLocal } from '../remote';
import { mobileEmit } from '../mobile/server';
import { broadcastTerminalAttention } from '../terminal/ipc';
import { agentInboxBroker } from './broker';
import type { AgentInboxBrokerEvent } from './types';

/**
 * Wire the AgentInbox broker's outbound events to Genie's existing fan-out —
 * mirroring `broadcastTerminalSpecsChanged`: a LOCAL renderer broadcast
 * (`broadcastLocal`, so a host window's own /ws/events feed isn't double-pushed)
 * plus the mobile dashboard push (`mobileEmit`, a no-op when that server's off).
 * Local-only; no relay.
 *
 *   - presence  → `agentInbox:presence` carrying the full {@link AgentInboxAgentInfo}.
 *   - offline   → `agentInbox:presence` carrying `{ agentId, status:'offline', left }`.
 *   - message   → `agentInbox:message` carrying a preview (never the full stream).
 *   - interrupt → the target terminal's attention glow (an `interrupt` DM is the
 *                 only sanctioned nudge; it never writes into the pty).
 *
 * Call {@link installAgentInboxPresence} once at boot.
 */
export function installAgentInboxPresence(): void {
    agentInboxBroker.setEmitter((ev: AgentInboxBrokerEvent) => {
        switch (ev.type) {
            case 'presence':
                broadcastLocal('agentinbox:presence', ev.agent);
                mobileEmit('agentinbox:presence', ev.agent);
                break;
            case 'offline': {
                const payload = { agentId: ev.agentId, status: 'offline', left: true };
                broadcastLocal('agentinbox:presence', payload);
                mobileEmit('agentinbox:presence', payload);
                break;
            }
            case 'message':
                broadcastLocal('agentinbox:message', ev.preview);
                mobileEmit('agentinbox:message', ev.preview);
                break;
            case 'interrupt':
                // Nudge only — glow the recipient's terminal so it's noticed; never
                // inject into its pty (that would corrupt an in-flight agent turn).
                broadcastTerminalAttention(ev.terminalId, true);
                break;
            case 'escalation':
                // Track C — an urgent DM went unACKed past the window; surface a
                // "waiting on <agent>" alert to the human oversight panel.
                broadcastLocal('agentinbox:escalation', ev.escalation);
                mobileEmit('agentinbox:escalation', ev.escalation);
                break;
            case 'escalation-resolved':
                // The target finally received it — clear the alert.
                broadcastLocal('agentinbox:escalation', {
                    messageId: ev.messageId,
                    targetAgentId: ev.targetAgentId,
                    resolved: true,
                });
                mobileEmit('agentinbox:escalation', {
                    messageId: ev.messageId,
                    targetAgentId: ev.targetAgentId,
                    resolved: true,
                });
                break;
        }
    });
}

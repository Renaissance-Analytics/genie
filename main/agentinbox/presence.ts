import { broadcastLocal } from '../remote';
import { mobileEmit } from '../mobile/server';
import { broadcastTerminalAttention } from '../terminal/ipc';
import { agentPulse } from '../terminal/agent-pulse';
import { agentInboxBroker } from './broker';
import { playAlert } from '../notify-sound';
import { alertKindForInboxSender } from '../notify-sound-kinds';
import { readMachineSender } from './types';
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
 *   - lifecycle → an AgentPulse marker on the workspace row (delivered / checked
 *                 / replied). NOT its own broadcast: it rides the `agent-pulse`
 *                 event, which is already in PASSTHROUGH_EVENTS, so a remote
 *                 window shows the HOST's inbox activity for free. A second
 *                 channel would need its own passthrough entry and its own
 *                 mobileEmit — two things to keep in step for no gain.
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
            case 'message': {
                broadcastLocal('agentinbox:message', ev.preview);
                mobileEmit('agentinbox:message', ev.preview);
                // …and chime, if the owner asked to hear agents talking to each
                // other, or a machine reporting in (genie#546). The SENDER
                // decides which: an agent id is an agentMessage, a machine
                // source is an automated notice, and the human is silent — you
                // do not need a chime for the message you just typed.
                //
                // `readMachineSender` answers the machine half rather than this
                // file matching on the id's shape: genie#543 made it the ONE
                // place that parses a machine sender, and it is deliberately
                // strict — an unrecognised `genie:<kind>:<id>` is ordinary mail,
                // not a source Genie can claim to have understood.
                const alert = alertKindForInboxSender(
                    ev.preview.from,
                    readMachineSender(ev.preview.from) !== null,
                );
                if (alert) playAlert(alert);
                break;
            }
            case 'lifecycle':
                // The pulse fans this out itself (broadcastLocal + mobileEmit on
                // `agent-pulse`), so there is deliberately no broadcast here.
                agentPulse.mark(ev.moment.workspaceId, ev.moment.kind);
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
            case 'lag':
                // genie #64 — the AGENT-lag level moved. The header badge is a
                // level, so this only fires on a transition.
                broadcastLocal('agentinbox:lag', { count: ev.count });
                mobileEmit('agentinbox:lag', { count: ev.count });
                break;
            case 'cleared': {
                // genie #64 — the human wiped a conversation. Tell every open
                // window so it drops its cached view instead of rendering rows
                // the host no longer has.
                const payload = { scope: ev.scope, key: ev.key };
                broadcastLocal('agentinbox:cleared', payload);
                mobileEmit('agentinbox:cleared', payload);
                break;
            }
        }
    });
}

import { broadcastLocal } from '../remote';
import { mobileEmit } from '../mobile/server';
import { broadcastTerminalAttention } from '../terminal/ipc';
import { whisperBroker } from './broker';
import type { WhisperBrokerEvent } from './types';

/**
 * Wire the WhisperChat broker's outbound events to Genie's existing fan-out —
 * mirroring `broadcastTerminalSpecsChanged`: a LOCAL renderer broadcast
 * (`broadcastLocal`, so a host window's own /ws/events feed isn't double-pushed)
 * plus the mobile dashboard push (`mobileEmit`, a no-op when that server's off).
 * Local-only; no relay.
 *
 *   - presence  → `whisper:presence` carrying the full {@link WhisperAgentInfo}.
 *   - offline   → `whisper:presence` carrying `{ agentId, status:'offline', left }`.
 *   - message   → `whisper:message` carrying a preview (never the full stream).
 *   - interrupt → the target terminal's attention glow (an `interrupt` DM is the
 *                 only sanctioned nudge; it never writes into the pty).
 *
 * Call {@link installWhisperPresence} once at boot.
 */
export function installWhisperPresence(): void {
    whisperBroker.setEmitter((ev: WhisperBrokerEvent) => {
        switch (ev.type) {
            case 'presence':
                broadcastLocal('whisper:presence', ev.agent);
                mobileEmit('whisper:presence', ev.agent);
                break;
            case 'offline': {
                const payload = { agentId: ev.agentId, status: 'offline', left: true };
                broadcastLocal('whisper:presence', payload);
                mobileEmit('whisper:presence', payload);
                break;
            }
            case 'message':
                broadcastLocal('whisper:message', ev.preview);
                mobileEmit('whisper:message', ev.preview);
                break;
            case 'interrupt':
                // Nudge only — glow the recipient's terminal so it's noticed; never
                // inject into its pty (that would corrupt an in-flight agent turn).
                broadcastTerminalAttention(ev.terminalId, true);
                break;
        }
    });
}

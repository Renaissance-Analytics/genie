import { liveTerminalForAgent } from './identity';
import type { ListNudgeIO } from './service';

/**
 * The real lookup + delivery behind a UserList nudge, assembled from injected
 * parts so the wiring can be tested without a broker or a main process.
 *
 * `resolveUserListItem` decides WHAT to say and whether the resolution stands;
 * this decides WHO hears it. Keeping them apart is deliberate — the decision is
 * already covered by its own suite, and every remaining way this feature can
 * lie to a person lives in the lookup: an agent found by name in the wrong
 * workspace, or a "delivered" reported against a terminal with nobody on it.
 */
export interface NudgeIODeps {
    /** Every terminal Genie knows about, live or not. */
    terminals: () => readonly {
        id: string;
        workspace_id: string | null;
        meta?: { whisper_purpose?: unknown } | null;
    }[];
    /** Whether that terminal has an agent identity that could receive a message. */
    isLive: (terminalId: string) => boolean;
    /** Post as the PERSON — they really did tick the item off, and the comment
     *  is theirs. Reports the broker's own reason for a failure. */
    deliver: (
        terminalId: string,
        text: string,
    ) => { ok: true } | { ok: false; reason: 'no-agent' | 'refused'; error?: string };
}

export function buildListNudgeIO(deps: NudgeIODeps): ListNudgeIO {
    return {
        liveTerminalFor: (workspaceId, agentName) =>
            liveTerminalForAgent(deps.terminals(), deps.isLive, workspaceId, agentName),

        deliver: (terminalId, text) => {
            let outcome: ReturnType<NudgeIODeps['deliver']>;
            try {
                outcome = deps.deliver(terminalId, text);
            } catch (e) {
                // A throw is the one outcome the broker never describes, and
                // reporting it as a delivery is the failure this whole seam
                // exists to prevent.
                return {
                    ok: false,
                    reason: `sending it threw: ${e instanceof Error ? e.message : String(e)}`,
                };
            }
            if (outcome.ok) return { ok: true };
            // `no-agent` and `refused` are different facts about different
            // things (genie#462). The person reading this decides whether to go
            // and tell someone, so the two must not collapse into one sentence.
            if (outcome.reason === 'no-agent') {
                return {
                    ok: false,
                    reason: 'that agent is no longer running in this workspace, so it was not told. It will see this the next time it reads its lists.',
                };
            }
            return {
                ok: false,
                reason: `Genie refused to deliver the notice${outcome.error ? `: ${outcome.error}` : ''}`,
            };
        },
    };
}

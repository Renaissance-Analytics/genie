import type { PermissionDecision } from '../acp/permission';

/**
 * What a HUMAN does to a session: prompt it, stop it, decide a permission.
 *
 * ## Why this had to be built
 *
 * `agentSession` over IPC was `list()` and nothing else. `AgentView` took `onApprove` and
 * `onTakeOver` as optional callbacks and `master.tsx` passed neither; the Conversation tab had
 * no composer; and `terminal:write` sends raw keystrokes to a pty, which for an ACP agent is an
 * empty shell rather than the agent.
 *
 * With ACP as the mechanism and Conversation as the default surface, that means **a human could
 * not prompt an agent, stop a turn, or answer a permission request from Genie's own UI.** Only
 * the MCP tools could, because `deliverTerminalInput` was taught about ACP and the renderer
 * never was. Every bit of it type-checked and the suite was green.
 *
 * ## Why the decisions are here and not in `main/ipc.ts`
 *
 * That file has no test of its own and imports Electron. These three functions are the part
 * worth checking — the refusals especially — so they take ports and the handlers stay thin.
 */

export interface SessionWritePorts {
    /** `acpRegistry.promptFor` — null for a pty agent or a closed channel. */
    promptFor: (specId: string) => ((text: string) => Promise<{ delivered: boolean; submitted: boolean }>) | null;
    /** `acpRegistry.cancelFor`. */
    cancelFor: (specId: string) => (() => Promise<{ honoured: boolean }>) | null;
    /** `acpRegistry.decideFor`. */
    decideFor: (specId: string) => ((approvalId: string, decision: PermissionDecision) => void) | null;
    /**
     * May this agent start another turn — the daily budget gate.
     *
     * Fails OPEN upstream: a database that cannot be read must not become "Genie has stopped
     * running agents".
     */
    allowTurn: (specId: string) => boolean;
}

export type PromptResult =
    | { ok: true; delivered: boolean; submitted: boolean }
    | { ok: false; reason: 'no-session' | 'empty' | 'parked' }
    | { ok: false; reason: 'failed'; error: string };

/**
 * Send a prompt to a structured session.
 *
 * The budget gate applies to a human's prompt too. The cap is about the SUBSCRIPTION rather than
 * about who typed, and the gate ASKS rather than refusing silently — so the numbers land in front
 * of the person at the moment they matter, and they can clear it for the day in one click.
 */
export async function promptSession(
    ports: SessionWritePorts,
    input: { specId: string; text: string },
): Promise<PromptResult> {
    const text = input.text.trim();
    // A stray Enter in the composer. Sending it starts a turn with no instruction, which costs
    // tokens and produces a shrug.
    if (!text) return { ok: false, reason: 'empty' };

    const prompt = ports.promptFor(input.specId);
    // Named rather than silent: a send that reports nothing is how a UI ends up claiming a prompt
    // the agent never saw.
    if (!prompt) return { ok: false, reason: 'no-session' };

    if (!ports.allowTurn(input.specId)) return { ok: false, reason: 'parked' };

    try {
        const outcome = await prompt(text);
        // `delivered: false` is a real outcome — the channel went while the call was in flight —
        // and it is reported rather than thrown so the composer can keep the text.
        return { ok: true, delivered: outcome.delivered, submitted: outcome.submitted };
    } catch (err) {
        // Reached from an IPC handler. An unhandled rejection in the main process is a worse
        // outcome than a failed send the UI can show.
        return { ok: false, reason: 'failed', error: err instanceof Error ? err.message : String(err) };
    }
}

export type CancelResult =
    | { ok: true; honoured: boolean }
    | { ok: false; reason: 'no-session' | 'failed'; error?: string };

/**
 * Ask the agent to stop the turn.
 *
 * NOT budget-gated: a cap exists to stop work starting, and refusing to stop work already
 * running because of a cap would be the opposite of what it is for.
 *
 * `honoured` is a real answer either way — `session/cancel` only ASKS, so an agent that keeps
 * going is a fact to report rather than a failure to retry.
 */
export async function cancelSession(
    ports: SessionWritePorts,
    input: { specId: string },
): Promise<CancelResult> {
    const cancel = ports.cancelFor(input.specId);
    if (!cancel) return { ok: false, reason: 'no-session' };
    try {
        return { ok: true, ...(await cancel()) };
    } catch (err) {
        return { ok: false, reason: 'failed', error: err instanceof Error ? err.message : String(err) };
    }
}

export type DecideResult = { ok: true } | { ok: false; reason: 'no-session' };

/**
 * Answer a permission the agent is parked on.
 *
 * NOT budget-gated, for the same reason as cancel: deciding is not starting work, and a parked
 * agent waiting on a question nobody may answer is strictly worse than one over its cap.
 */
export function decideApproval(
    ports: SessionWritePorts,
    input: { specId: string; approvalId: string; decision: PermissionDecision },
): DecideResult {
    const decide = ports.decideFor(input.specId);
    if (!decide) return { ok: false, reason: 'no-session' };
    decide(input.approvalId, input.decision);
    return { ok: true };
}

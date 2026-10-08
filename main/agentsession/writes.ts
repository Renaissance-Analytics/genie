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
    /**
     * `DeclaredSessionStore.recordHumanPromptForSpec` — put what the owner said into the
     * transcript, because the agent never will.
     *
     * Measured against a real claude ACP session (`handshake.real.test.ts`, logged every run):
     * the declared stream is `agent_message_chunk,notice,usage_update` and nothing else, and
     * `session/load` on the CLI's own session id replays `(0) none`. The prompt is neither echoed
     * nor replayed. So the Conversation showed the reply and no record of the question.
     *
     * Optional: a remote window or a harness may have no declared store, and a missing recorder
     * must cost a transcript line, never the message.
     */
    recordPrompt?: (specId: string, text: string) => void;
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

    /**
     * RECORD BEFORE SENDING, and the ORDER is the whole point.
     *
     * `session/prompt` resolves when the TURN COMPLETES, not when the agent receives the text. The
     * first version of this recorded on a delivered outcome — i.e. after every reply the turn
     * produced — so the owner's question appeared BELOW its own answer, and against codex (which
     * echoes the prompt mid-turn, measured) a third copy landed at the end where no tail-match could
     * collapse it.
     *
     * The three cases where nothing reached the agent are exactly the three settled ABOVE this line:
     * empty text, no session, budget parked. Past here the message is out, and `delivered: false`
     * means Genie could not CONFIRM it rather than that the agent did not get it — so erasing what
     * the owner typed on an unconfirmed send would be the worse error. The composer keeps the text
     * too, which is the other half of the same decision.
     */
    try {
        ports.recordPrompt?.(input.specId, text);
    } catch {
        // A transcript line is worth less than the message. Never let recording stop the send.
    }

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

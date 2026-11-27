/**
 * "SEND ALL NOW", ONE MESSAGE AT A TIME, WITH A RESULT EACH (Tynn #1089; the owner, 2026-11-27: "clicking the send all now
 * button does nothing at all"). The host had refused his kept message as already queued, and the refusal was drawn under the
 * message, far from the button. Now each kept message goes in the order written; the bar says how far it is and then what
 * became of each: `sent`, `waiting` (the agent already holds it, behind its turn: not a refusal), or `failed` with the reason.
 * A failure never stops the rest.
 */

export type SendOutcome = { readonly ok: true; readonly waiting?: true } | { readonly ok: false; readonly reason: string };

export interface SendAllItem { readonly id: string; readonly text: string }

export type SendAllResult =
    | { readonly id: string; readonly text: string; readonly outcome: 'sent' | 'waiting' }
    | { readonly id: string; readonly text: string; readonly outcome: 'failed'; readonly reason: string };

export interface SendAllState {
    readonly done: number;
    readonly of: number;
    readonly running: boolean;
    readonly results: readonly SendAllResult[];
}

export async function sendAll(items: readonly SendAllItem[], send: (item: SendAllItem) => Promise<SendOutcome>, onState: (state: SendAllState) => void): Promise<SendAllState> {
    const results: SendAllResult[] = [];
    onState({ done: 0, of: items.length, running: items.length > 0, results: [] });
    for (const item of items) {
        let outcome: SendOutcome;
        try {
            outcome = await send(item);
        } catch (error) {
            outcome = { ok: false, reason: error instanceof Error ? error.message : String(error) };
        }
        results.push(outcome.ok
            ? { id: item.id, text: item.text, outcome: outcome.waiting === true ? 'waiting' : 'sent' }
            : { id: item.id, text: item.text, outcome: 'failed', reason: outcome.reason });
        onState({ done: results.length, of: items.length, running: results.length < items.length, results: [...results] });
    }
    return { done: results.length, of: items.length, running: false, results };
}

/** `Sending 2 of 3…` while it runs; then `Sent 2 of 2.`, or the mix: `Sent 1 of 3 · 1 waiting behind the current turn · 1 not sent.` */
export function sendAllWords(state: SendAllState): string {
    if (state.running) return `Sending ${Math.min(state.done + 1, state.of)} of ${state.of}…`;
    const sent = state.results.filter((r) => r.outcome === 'sent').length;
    const waiting = state.results.filter((r) => r.outcome === 'waiting').length;
    const failed = state.results.filter((r) => r.outcome === 'failed').length;
    const parts = [`Sent ${sent} of ${state.of}`];
    if (waiting > 0) parts.push(`${waiting} waiting behind the current turn`);
    if (failed > 0) parts.push(`${failed} not sent`);
    return `${parts.join(' · ')}.`;
}

/** One message's result, in words. */
export function sendAllResultWords(result: SendAllResult): string {
    if (result.outcome === 'sent') return 'Sent';
    if (result.outcome === 'waiting') return 'Waiting behind the current turn';
    return `Not sent: ${result.reason}`;
}

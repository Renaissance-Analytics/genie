import type { Attachment } from './prompt-content.js';

/**
 * WHAT BECAME OF ONE MESSAGE FROM THE CHAT COMPOSER (react-fancy 5.70.0, acknowledged send).
 *
 * The composer's `onSubmit` returns the send, and react-fancy keeps the draft until it resolves: it empties on success,
 * keeps the draft on `{ ok: false }`, refuses a second send while one is in flight, and keeps text typed meanwhile.
 * So every outcome has to say where the message now lives — in exactly ONE place:
 *
 * - `sent`: the host took it — delivered, or queued for the current turn or a provider's resume (genie#1143/#1144,
 *   which the thread shows from the host's own record). The composer empties.
 * - `kept`: the agent is not running. The window keeps it in the thread as not delivered, with the chat's Restart, which
 *   sends every such message in order (genie#1238). The composer empties — keeping it there too would have Restart
 *   send it while the composer still offers it, and a second press send it twice.
 * - `failed`: nobody holds it — a refusal with a reason (a file the provider cannot take), an error, a window not
 *   connected to Genie, a Take Over window's mail that failed. The COMPOSER keeps it, and says why; no undelivered
 *   bubble is drawn beside it.
 *
 * PURE: the host is reached through the ports.
 */
export type ChatSendOutcome = { kind: 'sent' } | { kind: 'kept' } | { kind: 'failed'; reason: string };

/** Where the composer sends (core/chat-view.ts `chatSendFor`). */
export type ChatRoute = { kind: 'prompt' } | { kind: 'inbox'; to: string };

export interface ChatDeliveryPorts {
    /** Prompt the agent's session; `null` = this window is not connected to Genie. */
    prompt: ((text: string, attachments: readonly Attachment[]) => Promise<{ ok: boolean; reason?: string | null }>) | null;
    /** Mail a Take Over window's inbox. Rejects when it was not sent. */
    mail: (to: string, text: string) => Promise<unknown>;
    /** Keep the message in the thread as not delivered: the agent is not running (genie#1238). */
    keepUndelivered: () => void;
}

/** The words of an error, without Electron's IPC wrapper ("Error invoking remote method '<channel>': Error: …"). */
export function errorWords(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '');
}

/** One message, delivered by its route. Never rejects: every failure is an outcome with its reason. */
export async function deliverChat(route: ChatRoute, text: string, attachments: readonly Attachment[], ports: ChatDeliveryPorts): Promise<ChatSendOutcome> {
    if (route.kind === 'inbox') {
        if (attachments.length > 0) return { kind: 'failed', reason: 'Files cannot be sent to a Take Over window from here yet.' };
        try {
            await ports.mail(route.to, text);
            return { kind: 'sent' };
        } catch (error) {
            return { kind: 'failed', reason: errorWords(error) };
        }
    }
    if (!ports.prompt) return { kind: 'failed', reason: 'Genie is not connected.' };
    try {
        const r = await ports.prompt(text, attachments);
        if (r.ok) return { kind: 'sent' };
        // No reason = the agent is not running (session-host `promptWith`): the thread keeps it, with its Restart.
        if (!r.reason) {
            ports.keepUndelivered();
            return { kind: 'kept' };
        }
        return { kind: 'failed', reason: r.reason };
    } catch (error) {
        return { kind: 'failed', reason: errorWords(error) };
    }
}

/** react-fancy 5.70's `SubmitResult`: nothing empties the composer; `{ ok: false }` keeps the draft. */
export type ComposerAck = undefined | { ok: false; error: string };

/** What the composer is told about an outcome. */
export function composerAck(outcome: ChatSendOutcome): ComposerAck {
    return outcome.kind === 'failed' ? { ok: false, error: outcome.reason } : undefined;
}

/**
 * One composer send: read the attachments, send, and — only once the message holds its bytes somewhere — release the
 * draft's stored files (genie#1261). A failure releases nothing: the kept draft, files and all, is what a restart comes
 * back to. A host `onSend` that returns nothing (the doctor window) is taken as sent, as before.
 */
export async function submitFromComposer(steps: {
    read: () => Promise<readonly Attachment[]>;
    send: (attachments: readonly Attachment[]) => void | Promise<ChatSendOutcome>;
    release: () => void;
}): Promise<ComposerAck> {
    let outcome: ChatSendOutcome;
    try {
        const files = await steps.read();
        outcome = (await steps.send(files)) ?? { kind: 'sent' };
    } catch (error) {
        outcome = { kind: 'failed', reason: errorWords(error) };
    }
    if (outcome.kind !== 'failed') steps.release();
    return composerAck(outcome);
}

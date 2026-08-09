import crypto from 'node:crypto';
import { AGENTINBOX_HUMAN } from './types';
import { agentInboxBroker, type AgentInboxBroker } from './broker';
import {
    attachmentStoreRoot,
    readAttachmentBytes,
    storeInlineAttachments,
} from './attachments';

/**
 * The HUMAN panel's two attachment-aware host ops, in ONE implementation shared
 * by the local IPC handlers (`main/ipc.ts`) and the remote HTTP routes
 * (`main/mobile/api.ts`) — the same "one protocol, one implementation" rule the
 * rest of the AgentInbox panel already follows, so a remote window behaves
 * byte-identically to a local one.
 *
 * Neither op touches the filesystem outside Genie's OWN attachment store:
 *
 *  - ATTACHING sends the bytes INLINE (the panel uses the browser's file input),
 *    so the panel needs no fs capability and a human on a remote window attaches
 *    from THEIR machine rather than rummaging through the host's disk.
 *  - DOWNLOADING hands the bytes back for the client to save, for the same
 *    reason in reverse — a remote human wants the file locally, not on the host.
 *
 * The human is deliberately unscoped here (as everywhere in this panel: "the
 * human owns the workstation"), but the CAPS still apply — an oversize or
 * executable attachment is refused exactly as it is for an agent.
 */

/** One file the panel posted inline with a message. */
export interface HumanInboxAttachment {
    filename: string;
    /** base64 of the file's bytes, straight from the browser file input. */
    base64: string;
}

interface HumanDeps {
    broker?: AgentInboxBroker;
    storeRoot?: () => string;
}

/**
 * Post as the human, optionally with files. ALL-OR-NOTHING: if an attachment is
 * refused the message is NOT sent, so the human never sees "sent" for a message
 * whose files silently went missing.
 */
export async function postAsHuman(
    input: {
        channelKey?: string;
        toAgentId?: string;
        text?: string;
        attachments?: HumanInboxAttachment[];
    },
    deps: HumanDeps = {},
): Promise<{ ok: boolean; error?: string }> {
    const broker = deps.broker ?? agentInboxBroker;
    if (!input?.text?.trim()) return { ok: false, error: 'Message is empty.' };
    if (!input.channelKey && !input.toAgentId) {
        return { ok: false, error: 'Pick a channel or an agent to message.' };
    }

    let attachments;
    try {
        attachments = await storeInlineAttachments({
            files: input.attachments ?? [],
            storeRoot: (deps.storeRoot ?? attachmentStoreRoot)(),
            newId: () => crypto.randomUUID(),
        });
    } catch (e) {
        return {
            ok: false,
            error: `Nothing was sent — ${e instanceof Error ? e.message : String(e)}`,
        };
    }

    const r = broker.send({
        human: true,
        channelArg: input.channelKey,
        toAgentId: input.toAgentId,
        text: input.text,
        attachments,
    });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
}

/** An attachment's bytes for the panel to save client-side. */
export async function readHumanAttachment(
    attachmentId: string,
    deps: HumanDeps = {},
): Promise<{
    ok: boolean;
    error?: string;
    filename?: string;
    mime?: string;
    bytes?: number;
    base64?: string;
}> {
    const broker = deps.broker ?? agentInboxBroker;
    const id = String(attachmentId ?? '').trim();
    if (!id) return { ok: false, error: 'No attachment given.' };
    // The human passes the same gate as everyone else — it just always clears it
    // (see canAccessMessageAttachment), so this is the ONE lookup path.
    const att = broker.attachmentFor(AGENTINBOX_HUMAN, id);
    if (!att) return { ok: false, error: 'That attachment is no longer available.' };
    try {
        const buf = await readAttachmentBytes((deps.storeRoot ?? attachmentStoreRoot)(), att.sha256);
        return {
            ok: true,
            filename: att.filename,
            mime: att.mime,
            bytes: buf.length,
            base64: buf.toString('base64'),
        };
    } catch (e) {
        // This read is reachable over the REMOTE/mobile API, so the raw fs error
        // (a host path, or stack detail) must never reach the response — log it,
        // return a FIXED reason (genie#11, js/stack-trace-exposure; same discipline
        // as redactPluginFsError in mobile/api.ts).
        console.warn('[agentinbox] reading a human attachment failed:', e);
        return { ok: false, error: 'That attachment could not be read.' };
    }
}

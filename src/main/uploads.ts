import { basename } from 'node:path';
import { HUMAN, type Resolution } from '../core/inbox.js';
import { uploadRefusal } from '../core/mobile.js';

/**
 * UPLOAD FROM A DEVICE THAT IS NOT THIS HOST (§6.8 mobile UI: upload; genie#1354). A phone, a relay or a share guest has
 * no path on this host, so its bytes arrive over the socket and go to the inbox AS BYTES (§6.4: attachments are byte
 * copies, never path references) — Genie 1's `storeInlineAttachments` (main/agentinbox/attachments.ts, v0.7.0-beta.342).
 * Nothing is written to a temp file, so no path exists to name the file by: it keeps the name the device gave, base name
 * only. The inbox's own rules are applied before anything is stored — an executable name or an over-cap file is refused —
 * and the address resolves the inbox way, with the same words the desktop composer gets.
 */

type AgentTarget = Extract<Resolution, { kind: 'one' }>['id'];

export interface UploadSenderInput {
    readonly resolve: (to: string) => Resolution;
    readonly send: (input: { from: typeof HUMAN; to: AgentTarget; text: string; files: readonly { name: string; bytes: Uint8Array }[] }) => Promise<{ id: string }>;
}

export type SendFileResult = { ok: true; messageId: string } | { ok: false; reason: string };

export interface UploadSender {
    sendFile(to: string, text: string, name: string, bytes: Uint8Array): Promise<SendFileResult>;
}

export function uploadSender(input: UploadSenderInput): UploadSender {
    return {
        sendFile: async (to, text, name, bytes) => {
            const refusal = uploadRefusal(name, bytes.byteLength);
            if (refusal) return { ok: false, reason: refusal };
            const target = input.resolve(to);
            if (target.kind === 'none') return { ok: false, reason: `nobody at ${to}` };
            if (target.kind === 'ambiguous') return { ok: false, reason: `${to} names more than one agent — use one of: ${target.forms.join(', ')}` };
            if (target.kind === 'human') return { ok: false, reason: 'that is you' };
            // The name's base name only: a name with a path in it names nothing on this host.
            const fileName = basename(name.replace(/\\/g, '/'));
            try {
                const message = await input.send({ from: HUMAN, to: target.id, text, files: [{ name: fileName, bytes }] });
                return { ok: true, messageId: message.id };
            } catch (error) {
                return { ok: false, reason: error instanceof Error ? error.message : String(error) };
            }
        },
    };
}

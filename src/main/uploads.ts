import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { HUMAN, type Resolution } from '../core/inbox.js';
import { uploadRefusal } from '../core/mobile.js';

/**
 * UPLOAD FROM A PHONE (§6.8 mobile UI: upload). A phone has no path on this host, so its bytes
 * arrive over the socket and land in a temp file under Genie's own directory for exactly as long
 * as the inbox needs to COPY them (§6.4: attachments are byte copies, never path references).
 * The file is removed whether the send landed or failed. The inbox's own rules are applied before
 * a byte is written — an executable name or an over-cap file never touches the disk — and the
 * address resolves the inbox way, with the same words the desktop composer gets.
 */

type AgentTarget = Extract<Resolution, { kind: 'one' }>['id'];

export interface UploadSenderInput {
    /** Where the temp files live; created on first use. */
    readonly dir: string;
    readonly resolve: (to: string) => Resolution;
    readonly send: (input: { from: typeof HUMAN; to: AgentTarget; text: string; attachments: readonly string[] }) => Promise<{ id: string }>;
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
            await mkdir(input.dir, { recursive: true });
            // The name's basename only, under OUR directory — a name with a path in it goes nowhere else.
            const path = join(input.dir, `${randomUUID()}-${basename(name.replace(/\\/g, '/'))}`);
            try {
                await writeFile(path, bytes);
                const message = await input.send({ from: HUMAN, to: target.id, text, attachments: [path] });
                return { ok: true, messageId: message.id };
            } catch (error) {
                return { ok: false, reason: error instanceof Error ? error.message : String(error) };
            } finally {
                await rm(path, { force: true });
            }
        },
    };
}

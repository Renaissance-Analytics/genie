import { Icon, ImagePill } from '@particle-academy/react-fancy';
import { attachmentPills } from '../../core/sent-attachments.js';
import type { AttachmentRef } from '../../core/stream-event.js';
import type { AttachmentReply } from '../../core/thread-store.js';

/**
 * A SENT MESSAGE'S FILES (Tynn #642; the owner, 2026-11-12: "these pills should show me the thumbnail on hover the same
 * way they do in the user input"). An image the host kept is the kit's ImagePill — the composer's own pill — whose
 * thumbnail is read from the host once, on its first hover or focus (`agents.attachment`), never with the thread. Any other
 * file, or an image with no way to read it, is its name.
 */
export interface SentAttachmentsProps {
    /** The message's id, on the row's handle. */
    readonly id: string;
    readonly names: readonly string[];
    readonly refs?: readonly AttachmentRef[] | undefined;
    /** Read one kept image from the host. Absent: images are named only. */
    readonly load?: ((attachmentId: string) => Promise<AttachmentReply>) | undefined;
    readonly className?: string | undefined;
}

export function SentAttachments({ id, names, refs, load, className }: SentAttachmentsProps) {
    return (
        <div data-chat-attachments={id} className={className ?? 'flex flex-wrap justify-end gap-1'}>
            {attachmentPills(names, refs).map((p, i) => p.ref && load ? (
                <ImagePill
                    key={`${p.ref.id}-${i}`}
                    label={p.name}
                    data-chat-attachment-image={p.ref.id}
                    loadThumbnail={async () => {
                        const reply = await load(p.ref!.id);
                        if (!reply.ok) throw new Error(reply.reason);
                        return `data:${reply.mimeType};base64,${reply.data}`;
                    }}
                />
            ) : (
                <span key={`${p.name}-${i}`} data-chat-attachment-file="" className="flex items-center gap-1 rounded-md border border-[var(--border-1)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--fg-3)]"><Icon name="paperclip" size="xs" />{p.name}</span>
            ))}
        </div>
    );
}

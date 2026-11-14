import type { AttachmentRef } from './stream-event.js';

/** One file a message sent, and the image the host kept for it (`null`: not an image, or none kept). */
export interface SentAttachment {
    readonly name: string;
    readonly ref: AttachmentRef | null;
}

/**
 * A SENT MESSAGE'S FILES, EACH WITH ITS KEPT IMAGE (Tynn #642). The row names every file (`attachments`) and the images the
 * host kept (`attachmentRefs`, in the order sent); each kept image meets the first name of its own not yet met, so two
 * files with one name keep their order.
 */
export function attachmentPills(names: readonly string[], refs: readonly AttachmentRef[] | undefined): SentAttachment[] {
    const left = [...(refs ?? [])];
    return names.map((name) => {
        const at = left.findIndex((r) => r.name === name);
        if (at < 0) return { name, ref: null };
        const [ref] = left.splice(at, 1);
        return { name, ref: ref! };
    });
}

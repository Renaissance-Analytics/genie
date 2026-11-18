import type { Attachment } from '../core/prompt-content.js';

export interface UploadWorkspace {
    readonly path: string;
    readonly asleep: boolean;
    readonly untrusted: boolean;
}

export type SaveUploadsResult = { ok: true; files: Attachment[] } | { ok: false; reason: string };

/** STUB (Tynn #829 RED). */
export async function saveChatUploads(input: { workspace: UploadWorkspace | null; files: readonly Attachment[]; now: Date }): Promise<SaveUploadsResult> {
    return { ok: true, files: [...input.files] };
}

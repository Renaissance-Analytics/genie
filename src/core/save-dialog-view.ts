import type { FileStatus, SaveChoices, SavePreview } from './workspace-save.js';

/** Inert stub (RED): the Save to repo dialog's view model (Tynn #756 UI). */

export interface SaveDialogInput {
    readonly preview: SavePreview | null;
    readonly choices: SaveChoices;
    readonly busy: boolean;
    readonly error: string | null;
    readonly saved: readonly string[] | null;
}

export interface SaveDialogView {
    readonly loading: boolean;
    readonly refusal: { reason: string; fields: readonly { path: string; reason: string }[] } | null;
    readonly warning: string | null;
    readonly info: string | null;
    readonly files: readonly { path: string; label: string; status: FileStatus; words: string }[];
    readonly incoming: readonly { id: string; label: string }[];
    readonly conflicts: readonly { id: string; label: string; local: string; incoming: string; choice: 'local' | 'incoming' | null }[];
    readonly canSave: boolean;
    readonly saveLabel: string;
    readonly note: string | null;
    readonly error: string | null;
    readonly done: string | null;
}

export function elementLabel(id: string): string {
    return id;
}

export function fileLabel(path: string): string {
    return path;
}

export function saveDialogView(_input: SaveDialogInput): SaveDialogView {
    return { loading: false, refusal: null, warning: null, info: null, files: [], incoming: [], conflicts: [], canSave: false, saveLabel: 'Save', note: null, error: null, done: null };
}

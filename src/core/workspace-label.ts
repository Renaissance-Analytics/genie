import { folderName } from './workspace-name.js';

/**
 * A WORKSPACE AS A PERSON READS IT — its name, never its id.
 *
 * The owner, 2026-10-12: "I am still seeing workspaces ID's in several places". The rail had been
 * fixed to show names, but every other place that drew a workspace (pickers, badges, the Governs
 * list, the phone) still printed the raw ULID it had been handed. This is the one rule they all use:
 * the snapshot's `name` when there is one, else the folder the workspace lives in, and the id only
 * when the id names no workspace we know — an unknown id is still better shown than hidden.
 * Values sent back to main stay ids; only what is drawn changes.
 */
export function workspaceLabel(
    workspaces: readonly { id: string; path: string; name?: string | undefined }[] | null | undefined,
    id: string,
): string {
    const ws = workspaces?.find((w) => w.id === id);
    if (!ws) return id;
    const name = ws.name?.trim();
    if (name) return name;
    const folder = folderName(ws.path);
    return folder.length > 0 ? folder : id;
}

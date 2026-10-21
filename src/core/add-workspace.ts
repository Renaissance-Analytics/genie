/**
 * ADDING A WORKSPACE THE WAY GENIE 1 DID (the owner, 2026-10-21: "Look at Genie 1"; Genie 1's add-workspace.ts and
 * workspace-onboarding.ts). The pure half: the folder a new workspace gets, why one cannot be made, and where a folder
 * picker opens.
 */

/** Genie 1's `workspaceFolderName`: lowercase, runs of anything else to one dash, `.agi`. Empty = no folder can be made. */
export function workspaceFolderName(name: string): string {
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return slug === '' ? '' : `${slug}.agi`;
}

/** Genie 1's refusals (add-workspace.ts `addWorkspacePlan`), in its words; `null` = a workspace can be made. */
export function newWorkspaceProblem(name: string, parent: string): string | null {
    if (name.trim() === '') return 'Give the workspace a name.';
    if (parent.trim() === '') return 'Choose where the workspace should live.';
    if (workspaceFolderName(name) === '') return 'Give the workspace a name it can be a folder for.';
    return null;
}

/**
 * WHERE A FOLDER PICKER OPENS (the owner, 2026-10-21): in the scope of a workspace, that workspace's folder; from the
 * workstation, the Primary workspace (Settings → General); else the home folder; the bare root (`/`, the drives on
 * Windows) only when nothing better is known.
 */
export function pickerStart(at: { workspacePath?: string | null | undefined; primaryWorkspace?: string | null | undefined; home?: string | null | undefined }): string {
    for (const p of [at.workspacePath, at.primaryWorkspace, at.home]) if (typeof p === 'string' && p.trim() !== '') return p.trim();
    return '/';
}

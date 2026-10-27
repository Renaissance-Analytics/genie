import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

/**
 * EXPORT… (genie#1264; the owner, 2026-10-27: "Our file browser needs a real export, for saving a file to a new location
 * locally"). A workspace file, saved to a place the person picks on this machine.
 *
 * Genie 1 (v0.7.0-beta.342) had none: its FileTreeContextMenu offered no export, and its one "save to this machine" path —
 * the AgentInbox attachment download — read the bytes into the renderer as base64 and clicked an `<a download>`. Here MAIN
 * opens the OS save dialog and streams the file to the chosen path: the bytes never reach the renderer, so a binary or a
 * file far over the editor's size cap exports whole.
 *
 * - WHAT: a file inside the workspace (`FilesHost.absolute`, the confinement every file op uses), never the root, never a
 *   folder. Anything else is refused before a dialog opens.
 * - WHO: only a person. Nothing is written without the OS dialog's answer, and the destination comes from that dialog
 *   alone — no caller can name one. No MCP tool or remote-protocol method reaches this.
 * - WHERE THE DIALOG STARTS: the folder the last export went to this session, else Downloads (Genie 1's
 *   main/dialog-start-dir.ts remembered the last place for the session in the same way).
 * - OVERWRITE: the OS dialog asks. The copy goes to a hidden temp file beside the destination and is renamed over it only
 *   once complete, so a failed copy (disk full, the source gone) leaves the chosen file as it was and no partial behind.
 */

export interface SaveDialogOptions {
    readonly title: string;
    readonly defaultPath: string;
    readonly buttonLabel: string;
}
/** Electron's `dialog.showSaveDialog`, parented to `asker` — the window that asked, handed through `export`. */
export type SaveDialog = (options: SaveDialogOptions, asker?: unknown) => Promise<{ canceled: boolean; filePath?: string | undefined }>;

export interface ExportPorts {
    readonly files: { absolute(workspaceId: string, path: string): string | null };
    readonly saveDialog: SaveDialog;
    /** This machine's Downloads folder (`app.getPath('downloads')`). */
    readonly downloads: () => string;
}

/** A path or a reason crosses back to the window — never the file's bytes. */
export type ExportResult = { ok: true; path: string } | { ok: false; canceled: true } | { ok: false; reason: string };

export interface FileExporter {
    /** `asker`: the window that asked, passed to the dialog port as it is, to parent the dialog. */
    export(workspaceId: string, path: string, asker?: unknown): Promise<ExportResult>;
}

function wordsFor(error: unknown, name: string, dest: string): string {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'EACCES' || code === 'EPERM') return `${name} could not be exported: ${dirname(dest)} cannot be written to (permission denied)`;
    if (code === 'ENOSPC') return `${name} could not be exported: the disk at ${dirname(dest)} is full`;
    if (code === 'EROFS') return `${name} could not be exported: ${dirname(dest)} is read-only`;
    if (code === 'ENOENT') return `${name} could not be exported: ${name} or the folder ${dirname(dest)} no longer exists`;
    return `${name} could not be exported: ${error instanceof Error ? error.message : String(error)}`;
}

export function fileExporter(ports: ExportPorts): FileExporter {
    let lastDir: string | null = null;
    return {
        async export(workspaceId, path, asker) {
            const source = path === '' ? null : ports.files.absolute(workspaceId, path);
            if (source === null) return { ok: false, reason: 'that file is not in this workspace; Genie exports nothing from outside it' };
            const name = basename(source);
            try {
                if (!(await stat(source)).isFile()) return { ok: false, reason: `${name} is a folder; only a file can be exported` };
            } catch (error) {
                return { ok: false, reason: wordsFor(error, name, source) };
            }
            const picked = await ports.saveDialog({ title: `Export ${name}`, defaultPath: join(lastDir ?? ports.downloads(), name), buttonLabel: 'Export' }, asker);
            if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
            const dest = picked.filePath;
            lastDir = dirname(dest);
            const part = join(dirname(dest), `.${basename(dest)}.${randomUUID().slice(0, 8)}.genie-export`);
            try {
                // `wx`: the temp name is ours alone — never over something that happens to be there.
                await pipeline(createReadStream(source), createWriteStream(part, { flags: 'wx' }));
                await rename(part, dest);
                return { ok: true, path: dest };
            } catch (error) {
                await rm(part, { force: true }).catch(() => {});
                return { ok: false, reason: wordsFor(error, name, dest) };
            }
        },
    };
}

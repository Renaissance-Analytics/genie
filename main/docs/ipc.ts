import { app, ipcMain } from 'electron';
import { listDocs, readDoc, resolveDocsDir, type DocEntry } from './docs';

/**
 * IPC for the in-app Docs viewer:
 *
 *   docs:list()      → [{ slug, title }]   ordered by filename (reading order)
 *   docs:read(slug)  → markdown string | null
 *
 * The docs dir is resolved once against dev (repo `docs/`) and packaged
 * (`<asar>/docs`) layouts. `docs:read` only serves files from that dir and is
 * slug-guarded (no traversal) — see docs.ts.
 */
export function registerDocsIpc(dirname: string): void {
    const docsDir = resolveDocsDir(
        dirname,
        process.cwd(),
        app.isPackaged ? process.resourcesPath : undefined,
    );

    ipcMain.handle('docs:list', (): DocEntry[] => listDocs(docsDir));
    ipcMain.handle('docs:read', (_e, slug: string): string | null =>
        readDoc(docsDir, slug),
    );
}

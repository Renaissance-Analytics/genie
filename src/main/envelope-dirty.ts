import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';

/** What is at a path, read without following a link. */
export type PathKind = 'missing' | 'dir' | 'file' | 'link' | 'other';

export interface DirtyFs {
    kind(path: string): Promise<PathKind>;
    read(path: string): Promise<string | null>;
    write(path: string, text: string): Promise<void>;
    mkdir(path: string): Promise<void>;
}

export const DIRTY_IGNORES: readonly string[] = ['.ai/_dirty/**', '!.ai/_dirty/.gitkeep'];

/** RED STUB: inert. */
export async function ensureEnvelopeDirty(_input: { workspacePath: string; fs: DirtyFs }): Promise<void> {
    // intentionally does nothing yet
}

/** Node's fs for ensureEnvelopeDirty; every write is reported to `touched`. */
export function nodeDirtyFs(touched: (path: string) => void = () => {}): DirtyFs {
    return {
        kind: async (p) => {
            try {
                const s = await lstat(p);
                return s.isSymbolicLink() ? 'link' : s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other';
            } catch { return 'missing'; }
        },
        read: async (p) => { try { return await readFile(p, 'utf8'); } catch { return null; } },
        write: async (p, text) => { await writeFile(p, text, 'utf8'); touched(p); },
        mkdir: async (p) => { await mkdir(p); touched(p); },
    };
}

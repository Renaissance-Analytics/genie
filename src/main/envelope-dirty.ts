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

const HEADING = '# Files dropped into the workspace: kept here, never committed.';

/**
 * AN EXISTING ENVELOPE GETS .ai/_dirty/ (the owner, 2026-11-17; new envelopes have had it since genie#2033, Tynn #818).
 * An .agi envelope (`project.json` a file, `.ai` a real folder) with no `.ai/_dirty` gets the `.gitignore` lines it is
 * missing of `.ai/_dirty/**` and `!.ai/_dirty/.gitkeep`, then the folder with an empty `.gitkeep`. Nothing else is
 * touched and nothing is committed: an ordinary working-tree change.
 *
 * - Never through a link: `.ai`, `.ai/_dirty` or the `.gitignore` being one (or anything but a folder/file) = no write.
 * - Once: an envelope that has `.ai/_dirty` in any form is left exactly as it is (a Genie 1 one keeps its contents).
 * - The lines go first, so a run cut short after them leaves the folder to the next run, which adds no line twice.
 *
 * Whether Genie may write into the workspace at all (trusted, not hibernated) is the caller's gate: syncAgentDocs.
 */
export async function ensureEnvelopeDirty(input: { workspacePath: string; fs: DirtyFs }): Promise<void> {
    const { fs } = input;
    const at = (rel: string) => `${input.workspacePath}/${rel}`;
    if ((await fs.kind(at('project.json'))) !== 'file') return;
    if ((await fs.kind(at('.ai'))) !== 'dir') return;
    if ((await fs.kind(at('.ai/_dirty'))) !== 'missing') return;
    const ignoreKind = await fs.kind(at('.gitignore'));
    if (ignoreKind !== 'file' && ignoreKind !== 'missing') return;

    const before = ignoreKind === 'file' ? ((await fs.read(at('.gitignore'))) ?? '') : '';
    const have = new Set(before.split(/\r?\n/).map((l) => l.trim()));
    const missing = DIRTY_IGNORES.filter((l) => !have.has(l));
    if (missing.length > 0) {
        const eol = before.includes('\r\n') ? '\r\n' : '\n';
        const lead = before === '' ? '' : before.endsWith('\n') ? eol : `${eol}${eol}`;
        const heading = have.has(HEADING) ? [] : [HEADING];
        await fs.write(at('.gitignore'), `${before}${lead}${[...heading, ...missing].join(eol)}${eol}`);
    }
    await fs.mkdir(at('.ai/_dirty'));
    await fs.write(at('.ai/_dirty/.gitkeep'), '');
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

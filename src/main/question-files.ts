import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

/**
 * THE FILES A QUESTION NAMES, READ FOR ITS DRAWER (Genie 1's ForceTheQuestion file drawer; the owner, 2026-10-19).
 *
 * A question's paths are prose an AGENT wrote, so they are untrusted. Each resolves inside the ASKING workspace or not at
 * all: a relative path is taken from the workspace root, an absolute one only when it lies inside it, and `..` out of it
 * is refused however it is written. Only text is shown (a NUL byte is binary), up to MAX_BYTES.
 */

/** The drawer is a reader: a file bigger than this is not shown whole. */
export const MAX_BYTES = 512 * 1024;

const OUTSIDE = 'that file is not in this workspace';

/** The absolute path inside `root` that `named` means, or `null` when it would leave the workspace. */
function inside(root: string, named: string): string | null {
    const base = resolve(root);
    // Either separator: a question written on Windows names `..\x`, and a Linux host must refuse that too.
    const normalised = named.replace(/\\/g, '/');
    const target = isAbsolute(named) ? resolve(named) : resolve(base, normalised);
    const rel = relative(base, target);
    // A step UP is `..` as a whole segment — not a file that merely starts with two dots (`..notes.md` is inside).
    if (rel === '' || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) return null;
    return target;
}

export type QuestionFile = { ok: true; path: string; text: string } | { ok: false; reason: string };

export async function readQuestionFile(root: string, named: string): Promise<QuestionFile> {
    const target = inside(root, named);
    if (target === null) return { ok: false, reason: OUTSIDE };
    let size: number;
    try {
        const info = await stat(target);
        if (!info.isFile()) return { ok: false, reason: 'no such file' };
        size = info.size;
    } catch {
        return { ok: false, reason: 'no such file' };
    }
    if (size > MAX_BYTES) return { ok: false, reason: `too large to show here (${Math.round(size / 1024)} KB) — open it in the Files panel` };
    const bytes = await readFile(target);
    if (bytes.includes(0)) return { ok: false, reason: 'not a text file' };
    return { ok: true, path: named, text: bytes.toString('utf8') };
}

/** Which of the named paths are files inside the workspace — what gets a chip. */
export async function existingFiles(root: string, named: readonly string[]): Promise<Set<string>> {
    const out = new Set<string>();
    for (const n of named) {
        const target = inside(root, n);
        if (target === null) continue;
        try {
            if ((await stat(target)).isFile()) out.add(n);
        } catch {
            // Not there: no chip.
        }
    }
    return out;
}

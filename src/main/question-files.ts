import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { mediaMimeOf } from '../core/files-media.js';
import { questionMediaKind, type QuestionMedia } from '../core/question-media.js';
import { confinePathSync, OutsideWorkspaceError } from './workspace-confine.js';

/**
 * THE FILES A QUESTION NAMES, READ FOR ITS DRAWER (Genie 1's ForceTheQuestion file drawer; the owner, 2026-10-19).
 *
 * A question's paths are prose an AGENT wrote, so they are untrusted. Each resolves inside the ASKING workspace or not at
 * all: a relative path is taken from the workspace root, an absolute one only when it lies inside it, and `..` out of it
 * is refused however it is written. Text is shown up to MAX_BYTES (a NUL byte is binary); an image is sent to be drawn, a PDF or any other binary only named with its size (Tynn #726).
 */

/** The drawer is a reader: a file bigger than this is not shown whole. */
export const MAX_BYTES = 512 * 1024;

/** An image is sent to the drawer whole, as a data: URL; bigger than this it is named with its size and opened in Files. */
export const MAX_MEDIA_BYTES = 8 * 1024 * 1024;

const OUTSIDE = 'that file is not in this workspace';

/**
 * The absolute path inside `root` that `named` means, or `null` when it would leave the workspace — as written OR after
 * links: the SHARED check (genie#1354, workspace-confine.ts), so a symlink or junction inside the workspace that points
 * out of it is refused. A step UP is `..` as a whole segment — not a file that merely starts with two dots.
 */
function inside(root: string, named: string): string | null {
    // Either separator: a question written on Windows names `..\x`, and a Linux host must refuse that too.
    const normalised = isAbsolute(named) ? named : named.replace(/\\/g, '/');
    try {
        return confinePathSync(root, normalised, 'it is not shown');
    } catch (error) {
        if (error instanceof OutsideWorkspaceError) return null;
        throw error;
    }
}

export type QuestionFile = { ok: true; path: string; text: string } | { ok: true; path: string; media: QuestionMedia } | { ok: false; reason: string };

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
    const kind = questionMediaKind(named);
    if (kind === 'pdf') return { ok: true, path: named, media: { kind: 'pdf', size } };
    if (kind === 'image') {
        if (size > MAX_MEDIA_BYTES) return { ok: true, path: named, media: { kind: 'binary', size } };
        const bytes = await readFile(target);
        return { ok: true, path: named, media: { kind: 'image', src: `data:${mediaMimeOf(named)};base64,${bytes.toString('base64')}`, size } };
    }
    if (size > MAX_BYTES) return { ok: false, reason: `too large to show here (${Math.round(size / 1024)} KB) — open it in the Files panel` };
    const bytes = await readFile(target);
    if (bytes.includes(0)) return { ok: true, path: named, media: { kind: 'binary', size } };
    return { ok: true, path: named, text: bytes.toString('utf8') };
}

/** The path a question names, confined to its workspace (the drawer's own check), or `null`. Used to open it in Files. */
export function questionFileInside(root: string, named: string): string | null {
    return inside(root, named);
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

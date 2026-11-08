import { parseUnifiedDiff } from '@particle-academy/fancy-file-commons';
import type { FileEditFact } from './stream-event.js';

/**
 * A NATIVE EDIT, AS THE PROVIDER DESCRIBED IT (Tynn #440 part C). prism-acp 0.39.0 hands each edit over as
 * `_meta['particle.academy/file_edits']`: a workspace-relative `path`, a rename's `movePath`, a `kind`, and a unified
 * `diff` with standard headers. Codex's own input (`changes`) names none of Claude's `file_path` / `old_string` /
 * `new_string`, so this list is where its path, diff and counts come from. Claude's entries are `textScope: 'fragment'`
 * (its replacement strings, not the file's lines) and are left to its own input, read as before.
 *
 * When the list did not fit prism's frame budget it is left out WHOLE and `_meta['particle.academy/omitted']` says so
 * (`file_edits: 'frame_budget'`): that is "diff unavailable (too large)", never an edit with no changes.
 */

export const FILE_EDITS_META = 'particle.academy/file_edits';
export const OMITTED_META = 'particle.academy/omitted';

/** What a too-large edit says, wherever it is shown — never "no changes". */
export const DIFF_TOO_LARGE = 'diff unavailable (too large)';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** + and − lines of a unified diff, read by the kit's own parser (`fancy-file-commons`), never a hand-rolled one. */
export function countsOfDiff(diff: string): { plus: number; minus: number } {
    let plus = 0;
    let minus = 0;
    for (const file of parseUnifiedDiff(diff)) {
        for (const hunk of file.hunks) {
            for (const line of hunk.lines) {
                if (line.side === 'after') plus += 1;
                else if (line.side === 'before') minus += 1;
            }
        }
    }
    return { plus, minus };
}

/** The tool row's edit fields from an ACP update's `_meta`: `{}` when it carries no native edit list. */
export function editsFromUpdate(update: Record<string, unknown>): { edits?: readonly FileEditFact[]; editsOmitted?: true } {
    const meta = isRecord(update['_meta']) ? update['_meta'] : null;
    if (meta === null) return {};
    const omitted = meta[OMITTED_META];
    if (isRecord(omitted) && omitted['file_edits'] !== undefined) return { editsOmitted: true };
    const raw = meta[FILE_EDITS_META];
    if (!Array.isArray(raw) || raw.length === 0) return {};
    const edits: FileEditFact[] = [];
    for (const entry of raw) {
        // Only the provider's whole-file view is read here: a fragment (Claude) or a malformed entry leaves the call to
        // its own input, as before.
        if (!isRecord(entry) || entry['textScope'] !== 'file') return {};
        const path = entry['path'];
        const kind = entry['kind'];
        const diff = entry['diff'];
        if (typeof path !== 'string' || path === '' || typeof diff !== 'string' || (kind !== 'add' && kind !== 'delete' && kind !== 'update')) return {};
        const movePath = typeof entry['movePath'] === 'string' && entry['movePath'] !== '' ? entry['movePath'] : undefined;
        edits.push({ path, ...(movePath !== undefined ? { movePath } : {}), kind, diff, ...countsOfDiff(diff) });
    }
    return { edits };
}

/** One file's name on a row: its path, or `from → to` for a move. */
function fileLabel(edit: FileEditFact): string {
    return edit.movePath !== undefined ? `${edit.path} → ${edit.movePath}` : edit.path;
}

/** The row's label: the file (a move as `from → to`), or the first and how many more. */
export function editLabel(edits: readonly FileEditFact[]): string | null {
    const first = edits[0];
    if (first === undefined) return null;
    const more = edits.length - 1;
    return more === 0 ? fileLabel(first) : `${fileLabel(first)} and ${more} more file${more === 1 ? '' : 's'}`;
}

/** The files as they are now: a move's destination, every other edit's path. */
export function editedPaths(edits: readonly FileEditFact[]): string[] {
    return edits.map((e) => e.movePath ?? e.path);
}

/** The edit's whole unified diff, or `null` when any file's diff was too large to keep. */
export function unifiedOf(edits: readonly FileEditFact[]): string | null {
    let out = '';
    for (const e of edits) {
        if (e.diff === undefined) return null;
        out += e.diff.endsWith('\n') || e.diff === '' ? e.diff : `${e.diff}\n`;
    }
    return out;
}

export type ReverseResult = { ok: true; text: string } | { ok: false; reason: string };

interface ParsedHunk {
    readonly newStart: number;
    readonly newCount: number;
    readonly before: string[];
    readonly after: string[];
}

/** The hunks of ONE file's unified diff; `null` when it is not one Genie can apply exactly. */
function hunksOf(diff: string): ParsedHunk[] | null {
    const hunks: ParsedHunk[] = [];
    let current: { newStart: number; newCount: number; before: string[]; after: string[] } | null = null;
    const lines = diff.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    for (const line of lines) {
        const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (header) {
            current = { newStart: Number(header[1]), newCount: Number(header[2] ?? '1'), before: [], after: [] };
            hunks.push(current);
            continue;
        }
        if (current === null) continue; // file headers (`---`, `+++`, `diff --git`, rename lines) come first
        // A changed final newline is not something a line-wise reverse can put back exactly.
        if (line.startsWith('\\')) return null;
        const mark = line[0];
        const text = line.slice(1);
        if (mark === ' ') { current.before.push(text); current.after.push(text); }
        else if (mark === '-') current.before.push(text);
        else if (mark === '+') current.after.push(text);
        else return null;
    }
    return hunks;
}

/**
 * THE EDIT UNDONE: its diff applied in reverse to the file as it is now. Every hunk's new side must stand exactly where
 * the diff says; otherwise the file changed since and the answer is a refusal, never a guess.
 */
export function reverseApply(text: string, diff: string): ReverseResult {
    const hunks = hunksOf(diff);
    if (hunks === null || hunks.length === 0) return { ok: false, reason: 'the edit’s diff cannot be applied in reverse here' };
    const endsWithNewline = text.endsWith('\n');
    const lines = text.split('\n');
    if (endsWithNewline) lines.pop();
    // Last hunk first, so an earlier hunk's line numbers still hold.
    for (const hunk of [...hunks].reverse()) {
        if (hunk.after.length !== hunk.newCount) return { ok: false, reason: 'the edit’s diff cannot be applied in reverse here' };
        const at = hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1;
        const here = lines.slice(at, at + hunk.after.length);
        if (at < 0 || here.length !== hunk.after.length || here.some((l, i) => l !== hunk.after[i])) {
            return { ok: false, reason: 'the edit does not apply in reverse: the file changed since' };
        }
        lines.splice(at, hunk.after.length, ...hunk.before);
    }
    return { ok: true, text: lines.join('\n') + (endsWithNewline ? '\n' : '') };
}

/** Reverting a native edit: one updated file, in place, with its diff — anything else refused with the reason. */
export function revertNativeEdit(text: string, edits: readonly FileEditFact[]): ReverseResult {
    if (edits.length !== 1) return { ok: false, reason: `the edit changed ${edits.length} files; Genie reverts one file at a time` };
    const edit = edits[0]!;
    if (edit.diff === undefined) return { ok: false, reason: DIFF_TOO_LARGE };
    if (edit.movePath !== undefined) return { ok: false, reason: 'the edit moved the file; Genie does not move it back' };
    if (edit.kind === 'add') return { ok: false, reason: 'the edit created the file; reverting it would delete the file' };
    if (edit.kind === 'delete') return { ok: false, reason: 'the edit deleted the file; there is no file to write back into' };
    return reverseApply(text, edit.diff);
}

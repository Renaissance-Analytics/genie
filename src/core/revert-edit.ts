import { confine } from './files-panel.js';
import { DIFF_TOO_LARGE, editedPaths, revertNativeEdit } from './file-edits.js';
import type { FileEditFact } from './stream-event.js';

/**
 * REVERT THIS EDIT (the board's footer door in the Inspector): the call's OWN before-text goes back where its after-text
 * is. Only when the file still holds exactly what the edit wrote, exactly once — otherwise the place is unknown and the
 * answer is a refusal with the reason, never a guess. A `Write` reported no before-text, so there is nothing to put
 * back. An `edits[]` list is undone last-first.
 */
export type RevertResult = { ok: true; text: string } | { ok: false; reason: string };

function pairsOf(rawInput: unknown): { before: string; after: string }[] | null {
    if (typeof rawInput !== 'object' || rawInput === null) return null;
    const input = rawInput as Record<string, unknown>;
    if (typeof input['old_string'] === 'string' && typeof input['new_string'] === 'string') {
        return [{ before: input['old_string'], after: input['new_string'] }];
    }
    if (Array.isArray(input['edits'])) {
        const out: { before: string; after: string }[] = [];
        for (const e of input['edits']) {
            if (typeof e !== 'object' || e === null) return null;
            const r = e as Record<string, unknown>;
            if (typeof r['old_string'] !== 'string' || typeof r['new_string'] !== 'string') return null;
            out.push({ before: r['old_string'], after: r['new_string'] });
        }
        return out.length > 0 ? out : null;
    }
    return null;
}

export function revertEdit(text: string, rawInput: unknown): RevertResult {
    const pairs = pairsOf(rawInput);
    if (pairs === null) return { ok: false, reason: 'the call reported no before-text to put back' };
    let out = text;
    for (const p of [...pairs].reverse()) {
        if (p.after === '') return { ok: false, reason: 'the edit wrote nothing, so its place in the file cannot be found' };
        const first = out.indexOf(p.after);
        if (first < 0) return { ok: false, reason: 'the file no longer contains what the edit wrote' };
        if (out.indexOf(p.after, first + 1) >= 0) return { ok: false, reason: 'what the edit wrote appears more than once; the place is ambiguous' };
        out = out.slice(0, first) + p.before + out.slice(first + p.after.length);
    }
    return { ok: true, text: out };
}

type EditEvent = { readonly rawInput: unknown; readonly edits?: readonly FileEditFact[] | undefined; readonly editsOmitted?: true | undefined };

/**
 * REVERT THIS TOOL CALL'S EDIT, however it was reported (Tynn #440 part C): a native edit (Codex) by its diff applied in
 * reverse (`revertNativeEdit`), refused with the reason when it does not apply cleanly; any other by its own old/new
 * strings (`revertEdit`).
 */
export function revertToolEdit(text: string, event: EditEvent): RevertResult {
    if (event.editsOmitted === true) return { ok: false, reason: DIFF_TOO_LARGE };
    if (event.edits !== undefined) return revertNativeEdit(text, event.edits);
    return revertEdit(text, event.rawInput);
}

/** The file a tool call's edit changed, relative to the workspace root; `null` when none, several, or one outside it. */
export function toolEditPathIn(event: EditEvent, root: string): string | null {
    if (event.edits !== undefined) {
        const paths = editedPaths(event.edits);
        return paths.length === 1 ? confine(root, paths[0]!) || null : null;
    }
    return editPathIn(event.rawInput, root);
}

/** The edited file, relative to the workspace root; `null` when the call named none or one outside it (rawInput is untrusted). */
export function editPathIn(rawInput: unknown, root: string): string | null {
    if (typeof rawInput !== 'object' || rawInput === null) return null;
    const path = (rawInput as Record<string, unknown>)['file_path'];
    return typeof path === 'string' ? confine(root, path) : null;
}

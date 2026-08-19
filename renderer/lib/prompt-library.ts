import type { SavedPrompt } from '../components/Master/GenieCommandWindow';

/**
 * PURE. The Command Window's saved prompts (Tynn story #247), stored as JSON in
 * the `saved_prompts` setting.
 *
 * Deliberately forgiving on READ. That string is hand-editable and syncs between
 * machines, so it will eventually be malformed, half-written, or produced by a
 * newer Genie. It is also read on the path that OPENS the palette — so anything
 * that throws here costs the user Ctrl+K entirely, which is worse than losing a
 * prompt. A broken library degrades to empty; a broken ROW is dropped and the
 * rest survive.
 */

/** A row is usable only if the palette can both FIND it and SEND it. */
function isUsable(value: unknown): value is SavedPrompt {
    if (typeof value !== 'object' || value === null) return false;
    const row = value as Record<string, unknown>;
    return (
        typeof row.id === 'string' &&
        row.id.trim().length > 0 &&
        // No label → invisible in the palette. No text → sends nothing. Either
        // way the prompt cannot do its job, so it is not offered.
        typeof row.label === 'string' &&
        row.label.trim().length > 0 &&
        typeof row.text === 'string' &&
        row.text.trim().length > 0
    );
}

export function parsePromptLibrary(raw: string | undefined): SavedPrompt[] {
    if (!raw || !raw.trim()) return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) return [];

    // Narrowed to the three fields Genie uses rather than passed through whole:
    // a newer Genie may add fields, and those rows must still work here (so they
    // are kept), but this build should not carry values it does not understand
    // into its own state.
    return parsed.filter(isUsable).map((p) => ({ id: p.id, label: p.label, text: p.text }));
}

export function serializePromptLibrary(prompts: readonly SavedPrompt[]): string {
    return JSON.stringify(prompts);
}

/**
 * Add or replace a prompt, KEEPING its position.
 *
 * Position matters: the palette preserves the library's order, so an edit that
 * moved a row would change what Enter lands on next time.
 */
export function upsertPrompt(prompts: readonly SavedPrompt[], prompt: SavedPrompt): SavedPrompt[] {
    const at = prompts.findIndex((p) => p.id === prompt.id);
    if (at === -1) return [...prompts, prompt];
    const next = [...prompts];
    next[at] = prompt;
    return next;
}

export function removePrompt(prompts: readonly SavedPrompt[], id: string): SavedPrompt[] {
    return prompts.filter((p) => p.id !== id);
}

/** An id for a new prompt. Time-ordered so a synced library stays readable. */
export function newPromptId(now: number, random: number): string {
    return `p-${now.toString(36)}-${Math.floor(random * 1e6).toString(36)}`;
}

/**
 * Pure client-side helpers for the ForceTheQuestion availability SETTINGS UI — the
 * flyout DND toggle + the per-workspace / per-workstation selectors. These only
 * read/write the `ftq_availability_*` JSON scope-map setting strings; they hold NO
 * business logic. The authoritative resolver (most-specific scope wins) and the
 * DND-message default live in `main/ask/availability.ts` and run on the MAIN side
 * during enforcement — the renderer never re-decides surfacing, it only edits the
 * stored preference. Pure (no React / electron) so it unit-tests in the node
 * renderer env. See `.ai/plans/pending-questions-ux.md`.
 */

export type FtqAvailability = 'available' | 'dnd';

/** The global default shown in the UI when nothing is stored. Mirrors main's
 *  DEFAULT_FTQ_AVAILABILITY — DISPLAY ONLY; enforcement uses main's own copy. */
export const AVAILABILITY_DEFAULT: FtqAvailability = 'available';

const isAvailability = (v: unknown): v is FtqAvailability =>
    v === 'available' || v === 'dnd';

/** Parse a `{ id: 'available'|'dnd' }` scope-map setting string, dropping junk
 *  keys/values. Tolerant of empty / non-JSON / non-object input → `{}`. */
export function parseScopeMap(raw: string | undefined): Record<string, FtqAvailability> {
    if (typeof raw !== 'string' || raw === '') return {};
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, FtqAvailability> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (isAvailability(v)) out[k] = v;
    }
    return out;
}

/** The stored availability for one scope id, or undefined when unset (→ inherit
 *  the broader scope). */
export function scopeValue(
    raw: string | undefined,
    id: string,
): FtqAvailability | undefined {
    return parseScopeMap(raw)[id];
}

/** Set (or clear, with `null`) one scope id in the map, returning the new setting
 *  STRING to persist. Returns '' when the map is left empty, so the setting reads
 *  back as unset rather than a stray '{}'. */
export function setScopeEntry(
    raw: string | undefined,
    id: string,
    value: FtqAvailability | null,
): string {
    const map = parseScopeMap(raw);
    if (value === null) delete map[id];
    else map[id] = value;
    const keys = Object.keys(map);
    return keys.length === 0 ? '' : JSON.stringify(map);
}

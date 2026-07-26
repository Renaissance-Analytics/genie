/**
 * Per-user attribution emoji.
 *
 * A workstation's agents run on the OWNER's credentials, but several people may
 * drive them. So every principal that can drive carries an emoji, and that emoji
 * is stamped on each action they take (see `audit()`), giving a readable "who did
 * what" trail even though the creds behind the action are always the owner's.
 *
 * Tynn is the assignment AUTHORITY — the emoji is chosen where workstation access
 * is granted and travels with the principal's identity. This module is the host's
 * fallback for a principal that arrives without one: a DETERMINISTIC pick, so the
 * same person keeps the same emoji across reconnects instead of flickering, with a
 * probe past emoji already in use by other connected users.
 */

/** The fallback palette — visually distinct, single-glyph, no skin/gender variants. */
export const ATTRIBUTION_EMOJI: readonly string[] = [
    '🦊', '🐢', '🦉', '🐙', '🦋', '🐝', '🦀', '🐳',
    '🦩', '🦔', '🐧', '🦆', '🐬', '🦌', '🐿️', '🦇',
    '🌵', '🍄', '🌻', '🍁', '⚡', '🔥', '❄️', '🌈',
    '🎈', '🎸', '🚀', '🛸', '⚓', '🧭', '🔮', '🎯',
];

/** The desktop host itself — the local owner sitting at the machine. */
export const DESKTOP_EMOJI = '🖥️';

/** FNV-1a over the id: a stable, cheap spread across the palette. */
function hashIndex(id: string, modulo: number): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < id.length; i++) {
        h ^= id.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return Math.abs(h) % modulo;
}

/**
 * The emoji for a principal.
 *
 * `preferred` (the one the access grant assigned) always wins — Tynn owns
 * assignment and is responsible for keeping its own set collision-free. Without
 * one we hash the principal id into the palette and probe forward past anything
 * `taken` by another connected user, so a roomful of people get distinct glyphs.
 * With more users than palette entries the probe exhausts and duplicates become
 * possible — the audit `by` id remains the authoritative discriminator.
 */
export function assignEmoji(
    principalId: string,
    taken: Iterable<string> = [],
    preferred?: string | null,
): string {
    if (preferred) return preferred;
    const used = new Set(taken);
    const start = hashIndex(principalId, ATTRIBUTION_EMOJI.length);
    for (let i = 0; i < ATTRIBUTION_EMOJI.length; i++) {
        const candidate = ATTRIBUTION_EMOJI[(start + i) % ATTRIBUTION_EMOJI.length]!;
        if (!used.has(candidate)) return candidate;
    }
    return ATTRIBUTION_EMOJI[start]!;
}

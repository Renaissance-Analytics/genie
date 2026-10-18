/**
 * WHAT'S NEW, ONCE PER VERSION (Tynn #762; Genie 1's `whats_new_seen_version`). The words are the release's own
 * (docs/releases/v<version>.md), its "What's new" section ONLY: the migration and build notes there are for the people
 * shipping it, not the person using it (the owner: no migration or dev notes in the product).
 */

/** The "## What's new" section of a release's notes, without its heading; `null` when it has none. */
export function whatsNewSection(markdown: string): string | null {
    const lines = markdown.replace(/\r\n/g, '\n').split('\n');
    const start = lines.findIndex((l) => /^##\s+What[’']s new\s*$/i.test(l.trim()));
    if (start === -1) return null;
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => /^##?\s/.test(l));
    const section = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
    return section.length > 0 ? section : null;
}

/** What to show for the running version: its section, unless already seen or there is none to show. */
export function whatsNewFor(
    version: string,
    seen: string,
    notes: Readonly<Record<string, string>>,
): { version: string; notes: string } | null {
    if (seen === version) return null;
    const raw = notes[version];
    const section = raw === undefined ? null : whatsNewSection(raw);
    return section === null ? null : { version, notes: section };
}

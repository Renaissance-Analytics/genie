/**
 * THE FILE STEM FOR A SAVED ELEMENT (Tynn #756): the element's name, lower case, words joined by dashes, never empty, never one
 * already taken (`backup`, `backup-2`). `.processes/<stem>.json` uses it; `.flows/` has the same rule (core/workspace-flows.ts).
 */
export function fileStem(name: string, taken: ReadonlySet<string>, fallback = 'item'): string {
    const stem = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') || fallback;
    if (!taken.has(stem)) return stem;
    for (let n = 2; ; n++) {
        const candidate = `${stem}-${n}`;
        if (!taken.has(candidate)) return candidate;
    }
}

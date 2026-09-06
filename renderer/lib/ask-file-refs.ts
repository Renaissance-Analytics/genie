/**
 * Finding the files a ForceTheQuestion question is ABOUT (Tynn story #272).
 *
 * A question like "does §3 of `.ai/plans/impactium-actioncatalog-spec.md` still
 * hold?" hands the reader a path and nothing else. To answer it they leave the
 * modal, find the file, read it, and come back to a question they have half
 * forgotten — so the modal opens the file in a pane beside the question instead.
 *
 * This is the part that decides WHICH words are files. It runs over prose an
 * agent wrote, so the hard half is what NOT to match: a version string, the end
 * of a sentence, a URL. Every false positive is a chip offering to open a file
 * that isn't there, which is worse than missing one.
 *
 * DOM-free and framework-free on purpose — the renderer has no jsdom harness
 * (see vitest.config.ts), so the decision lives here where it can be tested.
 */

export interface AskFileRef {
    /** The path as the question wrote it, with any `:line` suffix removed. */
    path: string;
    /** The last segment — what the chip is labelled with. */
    name: string;
    /** A section the question pointed at (`§3`), when it named one. */
    section?: string;
    /** A 1-based line the question pointed at (`file.ts:42`), when it named one. */
    line?: number;
}

/** More chips than this is a wall, not an affordance. */
const MAX_REFS = 8;

/**
 * A path-shaped run of characters.
 *
 * Deliberately ends AT the extension, so a path at the end of a sentence
 * ("it lives in main/ask/inbox.ts.") doesn't swallow the full stop, and a
 * trailing `:42` is matched separately rather than folded into the path.
 *
 * The extension must start with a letter and be at least two characters: that
 * is what tells `spec.md` from `v0.7.0-beta.303`. It costs the single-letter
 * extensions (`.c`, `.h`, `.m`) — rare in a question, and cheaper to lose than
 * a chip on every version number an agent mentions.
 */
const PATH_RE =
    /(?:[A-Za-z]:[\\/])?(?:[\w.@~+-]+[\\/])*[\w.@~+-]+\.[A-Za-z][A-Za-z0-9]{1,7}/g;

/** `:42` or `#L42` immediately after a path. */
const LINE_RE = /^(?::(\d{1,7})|#L(\d{1,7}))/;

/** `§3`, `§ 3`, `§3.2` — optionally after whitespace or a closing backtick. */
const SECTION_RE = /^[\s`]*(§\s?[\w.]+)/;

/** Spans that are a URL — everything from the scheme to the next whitespace. */
function urlSpans(md: string): Array<[number, number]> {
    const spans: Array<[number, number]> = [];
    const re = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
    for (let m = re.exec(md); m; m = re.exec(md)) {
        spans.push([m.index, m.index + m[0].length]);
    }
    return spans;
}

function overlaps(spans: Array<[number, number]>, from: number, to: number): boolean {
    return spans.some(([a, b]) => from < b && to > a);
}

function basename(p: string): string {
    const parts = p.split(/[\\/]/);
    return parts[parts.length - 1] || p;
}

/**
 * Every file the question names, in the order it names them, deduped by path and
 * capped at {@link MAX_REFS}.
 *
 * A token counts as a file when it looks like a path AND contains a SEPARATOR.
 * `repos/genie/main/db.ts` names a location; `package.json` names no location at
 * all, and no amount of formatting around it can supply one.
 *
 * Inline code used to be accepted as a second route in, on the theory that an
 * agent writing `` `package.json` `` meant a file. It does not follow. An agent
 * setting a filename in code is usually TALKING ABOUT the file, and the header
 * above already states the standard that exemption broke: *"Every false positive
 * is a chip offering to open a file that isn't there, which is worse than
 * missing one."*
 *
 * Two ways it went wrong, and the second is the reason the rule changed
 * (genie#475):
 *
 *  - A name with nowhere to resolve gives ENOENT on the workspace root. Ugly,
 *    but it announces itself.
 *  - A name that DOES resolve at the root is silent. This workspace is an `.agi`
 *    envelope with eleven repositories under `repos/`, each with its own
 *    `package.json`, `README.md`, `AGENTS.md`, `vitest.config.ts`. A bare name is
 *    ambiguous by construction, and the single interpretation that resolves — the
 *    envelope root — is almost never the one meant. The chip opens, renders, and
 *    looks right while showing the wrong file.
 *
 * The cost is a question that names a real file bare-word, which now gets no
 * chip. That is the trade the header always asked for.
 */
export function extractFileRefs(markdown: string): AskFileRef[] {
    if (!markdown) return [];
    const urls = urlSpans(markdown);
    const seen = new Set<string>();
    const out: AskFileRef[] = [];

    PATH_RE.lastIndex = 0;
    for (let m = PATH_RE.exec(markdown); m; m = PATH_RE.exec(markdown)) {
        if (out.length >= MAX_REFS) break;
        const raw = m[0];
        const from = m.index;
        const to = from + raw.length;

        // A path inside a URL is part of that URL, not a file on this disk.
        if (overlaps(urls, from, to)) continue;

        // No separator, no location — see the docblock above.
        if (!/[\\/]/.test(raw)) continue;
        if (seen.has(raw)) continue;

        const rest = markdown.slice(to);
        const lineMatch = LINE_RE.exec(rest);
        const line = lineMatch ? Number(lineMatch[1] ?? lineMatch[2]) : undefined;
        const afterLine = lineMatch ? rest.slice(lineMatch[0].length) : rest;
        const sectionMatch = SECTION_RE.exec(afterLine);

        seen.add(raw);
        out.push({
            path: raw,
            name: basename(raw),
            ...(sectionMatch ? { section: sectionMatch[1]!.replace(/§\s+/, '§') } : {}),
            ...(line !== undefined ? { line } : {}),
        });
    }
    return out;
}

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

/** Spans of the markdown that are inside inline code (`` `like this` ``). */
function codeSpans(md: string): Array<[number, number]> {
    const spans: Array<[number, number]> = [];
    const re = /`+([^`]*)`+/g;
    for (let m = re.exec(md); m; m = re.exec(md)) {
        spans.push([m.index, m.index + m[0].length]);
    }
    return spans;
}

/** Spans that are a URL — everything from the scheme to the next whitespace. */
function urlSpans(md: string): Array<[number, number]> {
    const spans: Array<[number, number]> = [];
    const re = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
    for (let m = re.exec(md); m; m = re.exec(md)) {
        spans.push([m.index, m.index + m[0].length]);
    }
    return spans;
}

function within(spans: Array<[number, number]>, from: number, to: number): boolean {
    return spans.some(([a, b]) => from >= a && to <= b);
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
 * A token counts as a file when it looks like a path AND either contains a
 * separator (`renderer/pages/ask.tsx`) or the question set it in code
 * (`` `package.json` ``). A bare `package.json` in running prose does not: too
 * many ordinary sentences end in something that parses as `word.word`.
 */
export function extractFileRefs(markdown: string): AskFileRef[] {
    if (!markdown) return [];
    const code = codeSpans(markdown);
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

        const separated = /[\\/]/.test(raw);
        if (!separated && !within(code, from, to)) continue;
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

/**
 * URL detection for the terminal's clickable-links layer.
 *
 * Why a hand-rolled matcher instead of `@xterm/addon-web-links`: the official
 * addon hard-validates every candidate with `new URL(uri)` BEFORE its handler
 * runs, which throws for scheme-less inputs (`github.com/foo`, `www.x.com`).
 * Its `urlRegex` option is therefore moot for bare URLs — they can never be
 * linkified no matter the pattern. We want bare URLs clickable, so we own the
 * detection and feed xterm's `registerLinkProvider` directly.
 *
 * Matching rules (deliberately conservative for a terminal, where filenames
 * like `index.ts` / `main.go` / `README.md` look exactly like bare domains):
 *   - `http(s)://…`            — always, up to whitespace.
 *   - `www.<host>[/path]`      — the `www.` marker is a strong URL signal.
 *   - `<host>/<path>`          — a bare host is only linkified when followed by
 *                                a path (the slash disambiguates it from a
 *                                filename). Bare `example.com` is NOT linkified.
 *   - never an e-mail's domain (`user@host.com`).
 *
 * Pure + side-effect-free so it can be unit-tested without a DOM/xterm.
 */

/** One detected URL and its half-open character span within a line. */
export interface UrlMatch {
    /** The matched text exactly as it appears in the buffer (punctuation trimmed). */
    text: string;
    /** Browser-ready href — scheme-less matches are prefixed with `https://`. */
    href: string;
    /** 0-based index of the first character of `text` within the line. */
    start: number;
    /** 0-based index one past the last character of `text`. */
    end: number;
}

// A DNS-ish host: one or more dot-separated labels ending in a >=2-char TLD.
const HOST = '(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}';
// Path/query/fragment tail — anything up to whitespace or a bracket/quote.
const TAIL = "(?:[:/?#][^\\s\"'`<>(){}\\[\\]]*)?";

const URL_RE = new RegExp(
    [
        // scheme + everything up to whitespace/bracket
        "https?:\\/\\/[^\\s\"'`<>(){}\\[\\]]+",
        // www. host (path optional)
        `www\\.${HOST}${TAIL}`,
        // bare host that MUST be followed by a path (the slash is the signal)
        `${HOST}[/][^\\s"'\`<>(){}\\[\\]]*`,
    ].join('|'),
    'gi',
);

// Trailing punctuation that is almost always sentence/markup, not part of the URL.
const TRAILING = /[.,;:!?)\]}>'"`]+$/;

/** Prefix scheme-less hosts with https:// so the OS browser can open them. */
export function normalizeHref(raw: string): string {
    return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

/**
 * Find every clickable URL in a single line of terminal text. Spans are
 * 0-based half-open `[start, end)` indices into `line`.
 */
export function findUrls(line: string): UrlMatch[] {
    const out: UrlMatch[] = [];
    URL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = URL_RE.exec(line)) !== null) {
        const matchStart = m.index;
        let text = m[0];

        // Trim trailing sentence punctuation, shrinking the span to match.
        const trimmed = text.replace(TRAILING, '');
        text = trimmed;
        if (text.length < 4) continue;

        // Skip e-mail addresses: a bare host immediately preceded by `@`.
        if (line[matchStart - 1] === '@') continue;

        out.push({
            text,
            href: normalizeHref(text),
            start: matchStart,
            end: matchStart + text.length,
        });
    }
    return out;
}

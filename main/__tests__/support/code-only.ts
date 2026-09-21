/**
 * THE source-scanning comment stripper for guard tests (genie#404, genie#517).
 *
 * A guard test reads real source and asserts something is ABSENT. To do that it
 * has to ignore comments — otherwise a guard is tripped by the prose explaining
 * why the thing is forbidden, which trains people to delete the explanation.
 *
 * ## Why line-based, and not a block-comment span
 *
 * The obvious idiom is `src.replace(/\/\*[\s\S]*?\*\//g, '')`. It cannot tell a
 * real block comment from a slash-star **inside a string literal**: the span
 * opens at the literal and runs to the next real star-slash, deleting every line
 * between them from the scan — and the guard then reports the file CLEAN.
 *
 * That is not hypothetical. The main-side draft of the provider guard hit it for
 * real: it called `main/ipc.ts` clean while line 1785 held the union in plain
 * code. **A negative assertion with a silent blind spot is worse than no
 * assertion, because it is believed.**
 *
 * The known cost of going line-based: a `//` inside a string (a URL) truncates
 * the rest of THAT line. That loses one line rather than an arbitrary span of
 * them, and it cannot be triggered from a neighbouring line.
 *
 * ## Why it lives here
 *
 * This is the fifth copy. Four files had already written it by hand — three
 * string-aware, two still using the blinded span — which is exactly how a fix
 * lands in some copies and not others and nobody can tell which guard is awake.
 * One implementation, one blind spot, documented once.
 *
 * CRLF-safe: lines are split on `\r?\n`, because a guard anchored on a bare
 * `\n` is inert on a CRLF checkout and silently passes (genie#517).
 */
export function codeOnly(src: string): string {
    return src
        .split(/\r?\n/)
        .map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? '' : line.replace(/\/\/.*$/, '')))
        .join('\n');
}

/**
 * The same, for sources that also carry HTML comments — scaffolded `.html`
 * templates, where `<!-- … -->` is the comment form.
 *
 * ## Why this is a loop and not one `.replace`
 *
 * A single pass is INCOMPLETE on nested input: `<!--<!-- -->` has its inner
 * pair removed and the outer `<!--` survives (CodeQL
 * `js/incomplete-multi-character-sanitization`, flagged on this very file when
 * the idiom was consolidated here — it came along for the ride from the copy it
 * replaced). So pairs are removed until the string stops changing.
 *
 * ## What happens to a marker with no partner
 *
 * Whatever is left cannot be a complete comment, so the remaining `<!--` and
 * `-->` TOKENS are dropped without taking any text with them. That direction is
 * deliberate: this feeds guards that assert something is ABSENT, and the two
 * possible mistakes are not equal.
 *
 *   - Leaving commented prose in the scan can only make a guard fire when it
 *     should not — loud, visible, fixed in a minute.
 *   - Deleting a span to the end of the file hides real code from the guard,
 *     which is the silent blind spot this whole module exists to remove.
 *
 * So when in doubt it keeps text and drops markers, never the reverse.
 */
export function codeOnlyHtml(src: string): string {
    // A SCAN, not a regex replace.
    //
    // Two CodeQL findings landed on the replace-based version of this function,
    // and both were fair:
    //   - `js/incomplete-multi-character-sanitization` — one pass leaves the
    //     outer `<!--` of `<!--<!-- -->` behind, so it had to loop.
    //   - `js/bad-tag-filter` — the HTML spec also closes a comment on `--!>`,
    //     and a filter that knows only `-->` walks straight past one that ends
    //     the other way and scans its contents as code.
    //
    // Both are the SAME mistake this module exists to remove: a scanner that is
    // confident about a grammar it only partly implements. Patching the regex
    // twice would have left a third case waiting. Walking the string once
    // cannot half-match — it is either inside a comment or it is not — so the
    // class is gone rather than the two known instances.
    let out = '';
    let i = 0;
    while (i < src.length) {
        if (src.startsWith('<!--', i)) {
            const end = nextCommentEnd(src, i + 4);
            if (end === -1) {
                // Unterminated: keep the TEXT, drop the marker. A guard that
                // asserts ABSENCE would rather fire wrongly (loud, fixed in a
                // minute) than go blind to everything below (silent, believed).
                out += src.slice(i + 4);
                break;
            }
            i = end;
            continue;
        }
        out += src[i];
        i += 1;
    }
    return codeOnly(out);
}

/** Index just past the next `-->` or `--!>`, or -1 when the comment never ends. */
function nextCommentEnd(src: string, from: number): number {
    for (let i = from; i < src.length; i += 1) {
        if (src.startsWith('-->', i)) return i + 3;
        if (src.startsWith('--!>', i)) return i + 4;
    }
    return -1;
}

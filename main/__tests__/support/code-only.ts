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
 * templates, where `<!-- … -->` is the comment form and a lone `<!--` cannot
 * appear inside a JS string on the same line.
 */
export function codeOnlyHtml(src: string): string {
    return codeOnly(src.replace(/<!--[\s\S]*?-->/g, ''));
}

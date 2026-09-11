/**
 * Reading rules out of a stylesheet, for tests that must assert WHICH selector
 * carries a declaration.
 *
 * The renderer test env has no DOM, so no test there can compute a layout. What
 * it can do is read the source — and the two cases that need it (the lists dock
 * reserve, the Genie OS shimmer) were each a rule keyed on the wrong selector.
 * Shared rather than copied, so one fix to the parsing serves both.
 */

/** Strip `/* … *\/` blocks, including multi-line ones, CRLF or LF. */
export function stripCssComments(css: string): string {
    return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * The declarations inside the first block whose selector list is exactly
 * `selector`, or null when no such rule exists. Exact match on the trimmed
 * prelude, so `.gwrap.lists-docked` does not accidentally answer for
 * `.gwrap.lists-docked .gright`.
 */
export function declarationsFor(css: string, selector: string): string | null {
    const body = stripCssComments(css);
    const rule = /([^{}]+)\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = rule.exec(body)) !== null) {
        const prelude = m[1]!.split(',').map((s) => s.trim().replace(/\s+/g, ' ')).join(', ');
        if (prelude === selector) return m[2]!.trim();
    }
    return null;
}

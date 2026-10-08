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
 * prelude, so `.gwrap.docked` does not accidentally answer for
 * `.gwrap.docked .gright`.
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

/** The value of a `--token: N;` declaration anywhere in the sheet, or null. */
export function cssTokenValue(css: string, name: string): number | null {
    const m = new RegExp(`${name}:\\s*(-?[0-9]+)\\s*;`).exec(css);
    return m ? Number(m[1]) : null;
}

/**
 * The `z-index` a selector ends up with, FOLLOWING one level of `var()`.
 *
 * Every global rung in `master.css` is a token now. Three test files read those numbers, each
 * with its own regex for raw digits, and tokenising the ladder took all three red at once — the
 * assertions were right and only the reading was out of date. One reader, so the next change to
 * how the sheet expresses a layer is one fix rather than three.
 *
 * Matches the FIRST block whose prelude mentions the selector, which is how the callers were
 * already searching; one level of indirection only, because a token defined in terms of another
 * token is not something this ladder does and a recursive resolver would quietly accept a tangle
 * nobody could read.
 */
export function cssZIndexOf(css: string, selector: string): number | null {
    const body = stripCssComments(css);
    const at = body.indexOf(selector);
    if (at < 0) return null;
    const open = body.indexOf('{', at);
    if (open < 0) return null;
    const block = body.slice(open, body.indexOf('}', open));
    const direct = /z-index:\s*(-?[0-9]+)\s*;/.exec(block);
    if (direct) return Number(direct[1]);
    const token = /z-index:\s*var\(\s*(--[a-z0-9-]+)\s*\)/i.exec(block);
    return token ? cssTokenValue(css, token[1]!) : null;
}

import path from 'node:path';

/**
 * The one containment check the hosting runtime has.
 *
 * It lives on its own — rather than inside `static.ts` where it started — for
 * two reasons. It is used by BOTH the static adapter's request path (a URL must
 * not escape the document root) and the persisted site config (a stored docroot
 * must not escape its workspace), and a second copy of a security check is a
 * second thing to get wrong. And `static.ts` pulls in `node:http`/`node:https`,
 * which `db.ts` has no business importing just to validate a path.
 */

/**
 * True when `candidate` is `rootAbs` or lies beneath it.
 *
 * Uses `path.relative` rather than a string prefix so `/root-evil` is not
 * treated as being inside `/root`, and so the comparison respects the platform's
 * separator and case rules.
 */
export function isInside(rootAbs: string, candidate: string): boolean {
    const rel = path.relative(rootAbs, candidate);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

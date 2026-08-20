/**
 * PURE. The number on the top-bar Questions icon (genie#60).
 *
 * Two things were wrong with it.
 *
 * The VISIBLE one: it badged the number of WORKSPACES with pending questions, so
 * three questions from one workspace showed "1" — a badge answering a question
 * nobody asks. `pendingCount` in `ask/inbox.ts` is documented, in those words, as
 * "the number for the top-bar badge" and returns the total; the badge was simply
 * never wired to it.
 *
 * The INVISIBLE one: every source was optional-chained and every fallback was a
 * zero. A `questions:changed` with no payload — which several emitters send — set
 * the badge to nothing, and nothing is indistinguishable from "no questions". That
 * is the state reported while the flyout behind it listed three.
 *
 * So: resolve a count from whatever arrived, and return NULL when it cannot be
 * read. Null means FETCH, not zero. A badge should never show a number it did not
 * earn.
 */

const isCount = (v: unknown): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0;

interface CountLike {
    count?: unknown;
    groups?: ReadonlyArray<{ count?: unknown }>;
}

export function questionBadgeCount(payload: unknown): number | null {
    if (typeof payload !== 'object' || payload === null) return null;
    const p = payload as CountLike;

    // A total, from either the push payload or a fetched list. Deliberately NOT
    // `workspaces` — that is how many rooms the questions are in.
    if (isCount(p.count)) return p.count;

    // An older host answers `questions:list` without a total. Summing the groups
    // is right where counting them is not.
    if (Array.isArray(p.groups)) {
        return p.groups.reduce<number>((n, g) => n + (isCount(g?.count) ? g.count : 0), 0);
    }

    return null;
}

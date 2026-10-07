import { useCallback, useEffect, useState } from 'react';

/**
 * The URL query, without Next (owner directive, Tynn #449).
 *
 * This replaces the only thing `next/router` was doing in Genie: handing a page its query
 * string. Two call sites used it (`master.tsx` for the view route, `terminal.tsx` for the
 * spec to attach to), and both only ever read `router.query`.
 *
 * ## Shape is deliberately Next-compatible
 *
 * `Record<string, string | string[] | undefined>`, with a REPEATED param becoming an array —
 * because `parseViewRoute` and `parseTerminalWindowRoute` already handle that shape and are
 * tested against it. Changing the shape here would mean re-testing both parsers for no gain.
 *
 * ## There is no `isReady`
 *
 * Next's router parses the URL asynchronously, so `router.query` was empty on the first
 * render and callers had to wait for `isReady` or briefly decide the wrong thing.
 * `URLSearchParams` is synchronous: the query is correct on the first render, so the wait is
 * gone rather than hidden. Any `isReady` guard that survives this migration is dead weight.
 */

export type PageQuery = Record<string, string | string[] | undefined>;

/** Pure, so it can be tested without a DOM. `search` may include the leading `?`. */
export function readPageQuery(search: string): PageQuery {
    const out: PageQuery = {};
    for (const [key, value] of new URLSearchParams(search)) {
        const existing = out[key];
        if (existing === undefined) {
            out[key] = value;
        } else if (Array.isArray(existing)) {
            existing.push(value);
        } else {
            // Second occurrence promotes to an array, matching what Next handed back.
            out[key] = [existing, value];
        }
    }
    return out;
}

/**
 * Serialise back, dropping empty values so the url you sit on most stays clean.
 *
 * An ARRAY becomes repeated keys. `mergeViewRoute` is tested to preserve a repeated
 * non-route param verbatim, so flattening or dropping one here would break that guarantee
 * silently -- and the params at risk are `host` and `stage`, which decide whether this
 * renderer points at a remote machine.
 */
export function pageQueryString(query: Record<string, string | string[] | undefined>): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        for (const v of Array.isArray(value) ? value : [value]) {
            if (v !== '') params.append(key, v);
        }
    }
    const s = params.toString();
    return s ? `?${s}` : '';
}

/** Fired when `replacePageQuery` changes the url, since `history.replaceState` does not
 *  notify anyone on its own. */
const QUERY_EVENT = 'genie:pagequery';

/**
 * Rewrite the query WITHOUT reloading.
 *
 * `replaceState` rather than `pushState`: these are view changes inside one window, and a
 * window whose Back button walked through every tab you looked at would be a worse Back
 * button than none. The route is still in the url, so refresh and bookmarking work.
 */
export function replacePageQuery(query: Record<string, string | string[] | undefined>): void {
    if (typeof window === 'undefined') return;
    const next = `${window.location.pathname}${pageQueryString(query)}`;
    window.history.replaceState(null, '', next);
    window.dispatchEvent(new Event(QUERY_EVENT));
}

/** The live query for this window. */
export function usePageQuery(): PageQuery {
    const read = useCallback(
        () => (typeof window === 'undefined' ? {} : readPageQuery(window.location.search)),
        [],
    );
    const [query, setQuery] = useState<PageQuery>(read);

    useEffect(() => {
        const sync = () => setQuery(read());
        // `popstate` for Back/Forward, our own event for in-app rewrites.
        window.addEventListener('popstate', sync);
        window.addEventListener(QUERY_EVENT, sync);
        sync();
        return () => {
            window.removeEventListener('popstate', sync);
            window.removeEventListener(QUERY_EVENT, sync);
        };
    }, [read]);

    return query;
}

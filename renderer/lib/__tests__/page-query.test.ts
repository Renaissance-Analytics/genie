import { describe, expect, it } from 'vitest';
import { pageQueryString, readPageQuery } from '../page-query';

/**
 * The query parsing that replaced `next/router` (Tynn #449).
 *
 * The shape must stay Next-compatible — `string` for one value, `string[]` for a repeat —
 * because `parseViewRoute` and `parseTerminalWindowRoute` are already tested against that
 * shape. If this handed back something subtly different, both route parsers would start
 * resolving the wrong surface and nothing here would notice.
 */

describe('readPageQuery', () => {
    it('reads a single value as a string', () => {
        expect(readPageQuery('?view=deck')).toEqual({ view: 'deck' });
    });

    it('tolerates a missing leading question mark', () => {
        expect(readPageQuery('view=deck')).toEqual({ view: 'deck' });
    });

    it('is empty for an empty search, which is the DEFAULT surface', () => {
        // `{}` is what makes `parseViewRoute` return the Deck. A non-empty object here would
        // silently change what opens.
        expect(readPageQuery('')).toEqual({});
        expect(readPageQuery('?')).toEqual({});
    });

    it('promotes a REPEATED param to an array, as Next did', () => {
        expect(readPageQuery('?spec=a&spec=b')).toEqual({ spec: ['a', 'b'] });
        expect(readPageQuery('?spec=a&spec=b&spec=c')).toEqual({ spec: ['a', 'b', 'c'] });
    });

    it('decodes percent-encoding, so a Windows cwd survives', () => {
        // `?cwd=C:\a b\c` round-trips through the terminal window route.
        expect(readPageQuery('?cwd=C%3A%5Ca%20b%5Cc').cwd).toBe(['C:', 'a b', 'c'].join(String.fromCharCode(92)));
    });

    it('keeps a param it has never heard of', () => {
        // `stage` and `host` are bound before load and decide whether the renderer talks to
        // a remote machine. Dropping one would silently make a remote window local.
        expect(readPageQuery('?host=h1&view=grid')).toEqual({ host: 'h1', view: 'grid' });
    });

    it('keeps an empty value as an empty string rather than dropping the key', () => {
        // `?spec=` must be distinguishable, because the route parsers treat a blank spec as
        // "scratch" rather than as absent.
        expect(readPageQuery('?spec=')).toEqual({ spec: '' });
    });
});

describe('pageQueryString', () => {
    it('gives nothing for an empty query, so the default url stays clean', () => {
        expect(pageQueryString({})).toBe('');
    });

    it('drops undefined and empty values rather than emitting bare keys', () => {
        expect(pageQueryString({ a: '1', b: undefined, c: '' })).toBe('?a=1');
    });

    it('encodes values', () => {
        expect(pageQueryString({ cwd: 'a b' })).toBe('?cwd=a+b');
    });

    it('round-trips through readPageQuery', () => {
        const q = { view: 'grid', host: 'h1' };
        expect(readPageQuery(pageQueryString(q))).toEqual(q);
    });
});

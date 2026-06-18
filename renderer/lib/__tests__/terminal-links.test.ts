import { describe, it, expect } from 'vitest';
import { findUrls, normalizeHref } from '../terminal-links';

describe('normalizeHref', () => {
    it('leaves http(s) URLs untouched', () => {
        expect(normalizeHref('https://x.com')).toBe('https://x.com');
        expect(normalizeHref('http://x.com')).toBe('http://x.com');
    });
    it('prefixes https:// onto scheme-less hosts', () => {
        expect(normalizeHref('github.com/foo')).toBe('https://github.com/foo');
        expect(normalizeHref('www.x.com')).toBe('https://www.x.com');
    });
});

describe('findUrls', () => {
    const hrefs = (line: string) => findUrls(line).map((u) => u.href);

    it('matches a full https URL', () => {
        expect(hrefs('see https://github.com/Renaissance-Analytics/genie now')).toEqual([
            'https://github.com/Renaissance-Analytics/genie',
        ]);
    });

    it('keeps a scheme + host as a SINGLE match (no split)', () => {
        const m = findUrls('x https://github.com/a/b y');
        expect(m).toHaveLength(1);
        expect(m[0].href).toBe('https://github.com/a/b');
    });

    it('matches a scheme-less host that has a path', () => {
        expect(hrefs('open github.com/foo/bar please')).toEqual([
            'https://github.com/foo/bar',
        ]);
    });

    it('matches a www. host even without a path', () => {
        expect(hrefs('go www.example.com end')).toEqual(['https://www.example.com']);
    });

    it('does NOT linkify bare filenames that look like domains', () => {
        // .ts/.go/.md are valid TLDs — a bare host with no path/www must be skipped.
        expect(findUrls('edit index.ts and main.go and README.md')).toHaveLength(0);
    });

    it('does NOT linkify a bare host without a path or www', () => {
        expect(findUrls('visit example.com today')).toHaveLength(0);
    });

    it('does NOT linkify an e-mail domain', () => {
        expect(findUrls('mail me@example.com please')).toHaveLength(0);
    });

    it('trims trailing sentence punctuation', () => {
        const m = findUrls('see https://example.com/path. ok');
        expect(m).toHaveLength(1);
        expect(m[0].text).toBe('https://example.com/path');
        expect(m[0].href).toBe('https://example.com/path');
    });

    it('reports a correct 0-based half-open span', () => {
        const line = 'ab https://x.com cd';
        const [u] = findUrls(line);
        expect(line.slice(u.start, u.end)).toBe('https://x.com');
        expect(u.start).toBe(3);
        expect(u.end).toBe(16);
    });

    it('finds multiple URLs on one line', () => {
        expect(hrefs('github.com/a/b and www.c.com end')).toEqual([
            'https://github.com/a/b',
            'https://www.c.com',
        ]);
    });

    it('returns nothing for url-free text', () => {
        expect(findUrls('just some plain words here')).toHaveLength(0);
    });
});

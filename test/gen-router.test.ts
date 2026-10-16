import { describe, expect, it } from 'vitest';
import { HOSTS_BEGIN, HOSTS_END, hostsFileBlock, mergeHostsFile, normalizeHost, resolveRoute, type GenRoute } from '../src/core/gen-router.js';

/**
 * THE `.gen` FRONT DOOR (§6.6) — the pure half: which site a request's Host names, and the
 * hosts-file block the external-browser path writes. Everything the router does is decided here;
 * `main/gen-router.ts` only moves bytes.
 */

const routes: GenRoute[] = [
    { host: 'tynn.gen', target: '127.0.0.1:4101' },
    { host: 'dash.gen', target: '127.0.0.1:4102' },
];

describe('normalizing a Host header', () => {
    it('lower-cases, strips a port, and strips a trailing dot', () => {
        expect(normalizeHost('Tynn.GEN:443')).toBe('tynn.gen');
        expect(normalizeHost('tynn.gen.')).toBe('tynn.gen');
        expect(normalizeHost('[::1]:8080')).toBe('[::1]');
    });

    it('an absent or empty Host is null', () => {
        expect(normalizeHost(undefined)).toBeNull();
        expect(normalizeHost('')).toBeNull();
    });
});

describe('resolving a request to a site', () => {
    it('a known .gen host → its loopback target', () => {
        expect(resolveRoute('tynn.gen', routes)).toEqual({ kind: 'site', host: 'tynn.gen', target: '127.0.0.1:4101' });
        expect(resolveRoute('DASH.gen:443', routes)).toEqual({ kind: 'site', host: 'dash.gen', target: '127.0.0.1:4102' });
    });

    it('a .gen host nobody serves → `no-site`, naming it, so the page can say which name and offer the fix', () => {
        expect(resolveRoute('ghost.gen', routes)).toEqual({ kind: 'no-site', host: 'ghost.gen' });
    });

    it('anything that is not a .gen host → `not-gen` — the front door serves nothing else', () => {
        // COUNTED: four non-.gen hosts, four refusals. A router that proxied `localhost` would be
        // an open proxy to whatever listens on the targets.
        const refused = ['localhost', '127.0.0.1', 'example.com', 'tynn.gen.example.com'].map((h) => resolveRoute(h, routes));
        expect(refused.filter((r) => r.kind === 'not-gen')).toHaveLength(4);
        expect(resolveRoute(undefined, routes)).toEqual({ kind: 'not-gen', host: null });
    });

    it('S5: a multi-label .gen host — Genie 1’s <site>.<workspace>.gen — resolves to its route; a one-label one still does (control)', () => {
        const more: GenRoute[] = [...routes, { host: 'web.example.gen', target: '127.0.0.1:4103' }, { host: 'api.docs.example.gen', target: '127.0.0.1:4104' }];
        expect(resolveRoute('web.example.gen', more)).toEqual({ kind: 'site', host: 'web.example.gen', target: '127.0.0.1:4103' });
        expect(resolveRoute('API.Docs.Example.gen:443', more)).toEqual({ kind: 'site', host: 'api.docs.example.gen', target: '127.0.0.1:4104' });
        expect(resolveRoute('tynn.gen', more)).toEqual({ kind: 'site', host: 'tynn.gen', target: '127.0.0.1:4101' });
        // A multi-label name nobody serves is no-site (with the fix to offer), never not-gen.
        expect(resolveRoute('ghost.example.gen', more)).toEqual({ kind: 'no-site', host: 'ghost.example.gen' });
        // A name that is not a valid hostname is still nothing the front door serves.
        expect(['web..example.gen', 'web_1.example.gen', '.gen'].map((h) => resolveRoute(h, more).kind)).toEqual(['not-gen', 'not-gen', 'not-gen']);
    });

    it('a target is always loopback — a route to anything else is refused at resolution, not proxied', () => {
        const bad: GenRoute[] = [{ host: 'evil.gen', target: '10.0.0.5:80' }];
        expect(resolveRoute('evil.gen', bad)).toEqual({ kind: 'no-site', host: 'evil.gen' });
    });
});

/** Genie 1's block as its hosts-file.ts wrote it (tab-separated, both loopbacks), for names nothing serves any more. */
const V1_BLOCK = ['# BEGIN GENIE SITES', '127.0.0.1\told.gen', '::1\told.gen', '# END GENIE SITES'];

describe('the hosts-file block for external browsers', () => {
    it('is a 127.0.0.1 AND a ::1 line per NAME (Genie 1’s two loopbacks) between Genie-owned markers, sorted, each name once', () => {
        expect(hostsFileBlock(['tynn.gen', 'dash.gen', 'tynn.gen']).split('\n')).toEqual([
            '# >>> genie .gen sites — managed, do not edit between the markers',
            '127.0.0.1 dash.gen',
            '::1 dash.gen',
            '127.0.0.1 tynn.gen',
            '::1 tynn.gen',
            '# <<< genie .gen sites',
        ]);
        // COUNTED: exactly one IPv6 line per name, not "contains ::1".
        const block = hostsFileBlock(['a.gen', 'b.gen', 'c.gen']);
        expect(block.match(/^::1 /gm) ?? []).toHaveLength(3);
        expect(block.match(/^127\.0\.0\.1 /gm) ?? []).toHaveLength(3);
        // A multi-label site gets its FULL name on its lines (S5).
        expect(hostsFileBlock(['web.example.gen']).split('\n').slice(1, 3)).toEqual(['127.0.0.1 web.example.gen', '::1 web.example.gen']);
    });

    it('the same set in another order renders the same bytes — a reorder of the sites never writes the file', () => {
        expect(mergeHostsFile('127.0.0.1 localhost\n', ['tynn.gen', 'dash.gen'])).toBe(mergeHostsFile('127.0.0.1 localhost\n', ['dash.gen', 'tynn.gen']));
    });

    it('refuses a name that could inject a line of its own', () => {
        expect(() => hostsFileBlock(['evil.gen\n0.0.0.0 bank.example'])).toThrow(/not a \.gen name/);
        expect(() => hostsFileBlock(['example.com'])).toThrow(/not a \.gen name/);
    });

    it('replaces an existing Genie block in place and leaves everything else byte-identical; a matching file is returned unchanged', () => {
        const before = ['127.0.0.1 localhost', HOSTS_BEGIN, '127.0.0.1 old.gen', HOSTS_END, '::1 localhost', ''].join('\n');
        const after = mergeHostsFile(before, ['tynn.gen']);
        expect(after).toBe(['127.0.0.1 localhost', HOSTS_BEGIN, '127.0.0.1 tynn.gen', '::1 tynn.gen', HOSTS_END, '::1 localhost', ''].join('\n'));
        expect(mergeHostsFile('127.0.0.1 localhost\n', ['tynn.gen'])).toBe(`127.0.0.1 localhost\n${hostsFileBlock(['tynn.gen'])}\n`);
        expect(mergeHostsFile(after, ['tynn.gen'])).toBe(after);
    });

    it('no names → the block is gone, markers and all; a file without one is returned unchanged (nothing to write, nothing to prompt for)', () => {
        const withBlock = ['127.0.0.1 localhost', HOSTS_BEGIN, '127.0.0.1 old.gen', '::1 old.gen', HOSTS_END, ''].join('\n');
        expect(mergeHostsFile(withBlock, [])).toBe('127.0.0.1 localhost\n');
        expect(mergeHostsFile('127.0.0.1 localhost\n', [])).toBe('127.0.0.1 localhost\n');
    });

    it('Genie 1’s `# BEGIN GENIE SITES` block is removed in the same write that sets Genie 2’s — and then it is gone, so a second pass changes nothing', () => {
        const v1 = ['127.0.0.1 localhost', ...V1_BLOCK, '10.0.0.9 printer.example', ''].join('\n');
        const once = mergeHostsFile(v1, ['tynn.gen']);
        expect(once).not.toContain('GENIE SITES');
        expect(once).not.toContain('old.gen');
        expect(once).toBe(['127.0.0.1 localhost', '10.0.0.9 printer.example', ...hostsFileBlock(['tynn.gen']).split('\n'), ''].join('\n'));
        expect(mergeHostsFile(once, ['tynn.gen'])).toBe(once);
        // With no names of Genie 2's own, the leftover still goes — and the person's lines stay.
        expect(mergeHostsFile(v1, [])).toBe('127.0.0.1 localhost\n10.0.0.9 printer.example\n');
    });

    it('keeps a Windows hosts file’s CRLF line endings, its own lines byte for byte', () => {
        const crlf = '# Copyright (c) 1993-2009 Microsoft Corp.\r\n127.0.0.1 localhost\r\n';
        const out = mergeHostsFile(crlf, ['tynn.gen']);
        expect(out).toBe(`# Copyright (c) 1993-2009 Microsoft Corp.\r\n127.0.0.1 localhost\r\n${hostsFileBlock(['tynn.gen']).split('\n').join('\r\n')}\r\n`);
        expect(out.replace(/\r\n/g, '')).not.toContain('\n');
        expect(mergeHostsFile(out, [])).toBe(crlf);
    });

    it('a BEGIN with no END (an interrupted write) is healed, not duplicated', () => {
        const torn = ['127.0.0.1 localhost', HOSTS_BEGIN, '127.0.0.1 half.gen'].join('\n');
        expect(mergeHostsFile(torn, ['tynn.gen'])).toBe(['127.0.0.1 localhost', ...hostsFileBlock(['tynn.gen']).split('\n')].join('\n'));
    });
});


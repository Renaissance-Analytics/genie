import { describe, expect, it } from 'vitest';
import { hostsFileBlock, mergeHostsFile, normalizeHost, resolveRoute, type GenRoute } from '../src/core/gen-router.js';

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

    it('a target is always loopback — a route to anything else is refused at resolution, not proxied', () => {
        const bad: GenRoute[] = [{ host: 'evil.gen', target: '10.0.0.5:80' }];
        expect(resolveRoute('evil.gen', bad)).toEqual({ kind: 'no-site', host: 'evil.gen' });
    });
});

describe('the hosts-file block for external browsers', () => {
    it('is one 127.0.0.1 line per site between Genie-owned markers, so it can be replaced whole and removed clean', () => {
        const block = hostsFileBlock(routes);
        expect(block.split('\n')).toEqual([
            '# >>> genie .gen sites — managed, do not edit between the markers',
            '127.0.0.1 tynn.gen',
            '127.0.0.1 dash.gen',
            '# <<< genie .gen sites',
        ]);
        // No sites → the markers alone, which is how a removal looks.
        expect(hostsFileBlock([]).split('\n')).toHaveLength(2);
    });

    it('replaces an existing Genie block in a hosts file and leaves everything else byte-identical', () => {
        const before = ['127.0.0.1 localhost', '# >>> genie .gen sites — managed, do not edit between the markers', '127.0.0.1 old.gen', '# <<< genie .gen sites', '::1 localhost', ''].join('\n');
        const after = mergeHostsFile(before, routes);
        expect(after).toBe(['127.0.0.1 localhost', '# >>> genie .gen sites — managed, do not edit between the markers', '127.0.0.1 tynn.gen', '127.0.0.1 dash.gen', '# <<< genie .gen sites', '::1 localhost', ''].join('\n'));
        // A file with no block gets one appended; a file that already matches is returned unchanged.
        expect(mergeHostsFile('127.0.0.1 localhost\n', routes)).toBe('127.0.0.1 localhost\n' + hostsFileBlock(routes) + '\n');
        expect(mergeHostsFile(after, routes)).toBe(after);
    });
});

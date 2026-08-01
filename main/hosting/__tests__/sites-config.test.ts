import { describe, expect, it } from 'vitest';
import {
    hostedSiteIdFor,
    parseHostedSites,
    resolveHostedSite,
    sanitizeHostedSitePatch,
} from '../sites-config';
import { siteIdFor } from '../../mobile/hosts';

/**
 * The persisted per-workspace "sites enabled" model (Tynn #232, P2 item 5).
 *
 * This is the small piece of state the future Site Manager UX (P3) will drive:
 * which site, PHP or static, and which directory is the document root. P2 builds
 * only the backing store and the resolve step — but that resolve step is the one
 * place a stored string becomes a directory Genie will serve to a browser, so it
 * is where containment has to be enforced.
 *
 * Everything here is pure; the DB round-trip is covered in `main/__tests__/db`.
 */

const WORKSPACE = 'C:/repos/tynn';

describe('hostedSiteIdFor', () => {
    it('is the SAME id a discovered site gets for that hostname', () => {
        // This is what makes the Testing Browser wiring additive rather than a
        // rewrite: a hosted site keys `localTargetsBySiteId` exactly where the
        // hosts-file-discovered one did, so "prefer the hosted target" is a map
        // overwrite instead of a new resolution path.
        expect(hostedSiteIdFor('tynn.test')).toBe(siteIdFor('tynn.test'));
        expect(hostedSiteIdFor('TYNN.test')).toBe(siteIdFor('tynn.test'));
    });
});

describe('sanitizeHostedSitePatch', () => {
    it('keeps a well-formed config', () => {
        expect(
            sanitizeHostedSitePatch({
                enabled: true,
                hostname: 'Tynn.test',
                kind: 'php',
                docroot: 'public',
                index: 'index.php',
            }),
        ).toEqual({
            enabled: true,
            hostname: 'tynn.test',
            kind: 'php',
            docroot: 'public',
            index: 'index.php',
        });
    });

    it('drops junk instead of storing it', () => {
        expect(sanitizeHostedSitePatch(null)).toEqual({});
        expect(sanitizeHostedSitePatch({ enabled: 'yes', kind: 'ruby' } as never)).toEqual({});
        expect(sanitizeHostedSitePatch({ hostname: 'not a hostname' })).toEqual({});
    });

    it('normalises the docroot to forward slashes and trims trailing ones', () => {
        expect(sanitizeHostedSitePatch({ docroot: 'public\\build\\' }).docroot).toBe(
            'public/build',
        );
        expect(sanitizeHostedSitePatch({ docroot: './dist' }).docroot).toBe('dist');
        // The repo root itself is a legitimate docroot for a plain static site.
        expect(sanitizeHostedSitePatch({ docroot: '' }).docroot).toBe('');
    });

    it('REFUSES an absolute docroot — INCLUDING a bare leading separator', () => {
        // A stored absolute path would let one workspace's config serve any
        // directory on the machine; the docroot is only ever meaningful
        // relative to the workspace it belongs to.
        //
        // `/public` is refused along with `/etc` because the two are
        // indistinguishable: on POSIX both are absolute, and guessing that one
        // of them "obviously means relative" is how a rule like this stops
        // being a rule. The Site Manager supplies a relative path.
        expect(sanitizeHostedSitePatch({ docroot: 'C:/Windows/System32' }).docroot).toBeUndefined();
        expect(sanitizeHostedSitePatch({ docroot: '/etc' }).docroot).toBeUndefined();
        expect(sanitizeHostedSitePatch({ docroot: '/public' }).docroot).toBeUndefined();
        expect(sanitizeHostedSitePatch({ docroot: '\\public' }).docroot).toBeUndefined();
        expect(sanitizeHostedSitePatch({ docroot: '\\\\server\\share' }).docroot).toBeUndefined();
    });

    it('REFUSES a docroot that climbs out of the workspace', () => {
        expect(sanitizeHostedSitePatch({ docroot: '../../secrets' }).docroot).toBeUndefined();
        expect(sanitizeHostedSitePatch({ docroot: 'public/../..' }).docroot).toBeUndefined();
    });

    it('refuses a front controller that is a path rather than a file name', () => {
        // `index` is joined onto the docroot inside the generated Caddyfile;
        // a separator there would move the front controller outside it.
        expect(sanitizeHostedSitePatch({ index: '../../app.php' }).index).toBeUndefined();
        expect(sanitizeHostedSitePatch({ index: 'sub/index.php' }).index).toBeUndefined();
        expect(sanitizeHostedSitePatch({ index: 'index.php' }).index).toBe('index.php');
    });
});

describe('parseHostedSites', () => {
    it('reads NULL and corrupt JSON as "nothing enabled"', () => {
        expect(parseHostedSites(null)).toEqual({});
        expect(parseHostedSites('')).toEqual({});
        expect(parseHostedSites('{oops')).toEqual({});
        expect(parseHostedSites('[]')).toEqual({});
    });

    it('sanitizes every entry it reads back', () => {
        const raw = JSON.stringify({
            abc: { enabled: true, hostname: 'a.test', kind: 'static', docroot: '../../etc' },
        });
        expect(parseHostedSites(raw)).toEqual({
            abc: { enabled: true, hostname: 'a.test', kind: 'static' },
        });
    });
});

describe('resolveHostedSite', () => {
    const config = {
        enabled: true,
        hostname: 'tynn.test',
        kind: 'php' as const,
        docroot: 'public',
    };

    it('turns a stored config into the runtime\'s HostedSite with an ABSOLUTE root', () => {
        const site = resolveHostedSite(WORKSPACE, config);
        expect(site).not.toBeNull();
        expect(site?.id).toBe(siteIdFor('tynn.test'));
        expect(site?.root.replace(/\\/g, '/')).toBe('C:/repos/tynn/public');
        expect(site?.kind).toBe('php');
    });

    it('serves the workspace root when the docroot is empty', () => {
        const site = resolveHostedSite(WORKSPACE, { ...config, kind: 'static', docroot: '' });
        expect(site?.root.replace(/\\/g, '/')).toBe('C:/repos/tynn');
    });

    it('returns null for a config that would escape the workspace', () => {
        // Belt and braces: `sanitizeHostedSitePatch` already refuses these on
        // the way in, but a blob written by an older build — or by hand — must
        // not be able to serve `C:/Users` because it got past the writer.
        // Mutation-checked: removing the containment check here fails this test
        // even with sanitisation intact.
        expect(resolveHostedSite(WORKSPACE, { ...config, docroot: '../../..' })).toBeNull();
        expect(resolveHostedSite(WORKSPACE, { ...config, docroot: 'C:/Windows' })).toBeNull();
    });

    it('returns null without a workspace path or a hostname', () => {
        expect(resolveHostedSite('', config)).toBeNull();
        expect(resolveHostedSite(WORKSPACE, { ...config, hostname: '' })).toBeNull();
    });

    it('carries the front controller through for php sites only', () => {
        expect(resolveHostedSite(WORKSPACE, { ...config, index: 'app.php' })?.index).toBe('app.php');
        // A static site's `index` is its SPA shell, which the static adapter
        // reads itself — it is not a Caddy front controller.
        expect(
            resolveHostedSite(WORKSPACE, { ...config, kind: 'static', index: 'app.php' })?.index,
        ).toBe('app.php');
    });
});

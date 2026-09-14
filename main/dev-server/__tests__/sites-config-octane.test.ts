import { describe, expect, it } from 'vitest';
import { sanitizeDevSitePatch, siteEngineUse } from '../sites-config';

/**
 * `hostServe: { mode: 'octane' }` — a Laravel site Genie starts under Octane
 * (genie#668). The site definition is written into the git-tracked envelope, so
 * the sanitiser is what decides the shape that is allowed to land there.
 */
describe('hostServe octane — what a site may declare', () => {
    it('keeps an Octane serve mode with its server', () => {
        for (const server of ['frankenphp', 'roadrunner', 'swoole'] as const) {
            expect(sanitizeDevSitePatch({ hostServe: { mode: 'octane', server } }).hostServe).toEqual({
                mode: 'octane',
                server,
            });
        }
    });

    it('carries a PHP version pin, validated by the same rule as a php site', () => {
        expect(
            sanitizeDevSitePatch({ hostServe: { mode: 'octane', server: 'frankenphp', version: '8.4' } }).hostServe,
        ).toEqual({ mode: 'octane', server: 'frankenphp', version: '8.4' });
        expect(
            sanitizeDevSitePatch({
                hostServe: { mode: 'octane', server: 'frankenphp', version: '8.4; rm -rf /' },
            }).hostServe,
        ).toEqual({ mode: 'octane', server: 'frankenphp' });
    });

    it('needs no document root — Octane serves the app from the repo, and a root would be a setting nothing reads', () => {
        const clean = sanitizeDevSitePatch({
            hostServe: { mode: 'octane', server: 'roadrunner', root: 'public' } as never,
        }).hostServe;
        expect(clean).toEqual({ mode: 'octane', server: 'roadrunner' });
    });

    it('DROPS a server Octane does not have, rather than store a site that cannot start', () => {
        expect(
            sanitizeDevSitePatch({ hostServe: { mode: 'octane', server: 'nginx' } as never }).hostServe,
        ).toBeUndefined();
        expect(sanitizeDevSitePatch({ hostServe: { mode: 'octane' } as never }).hostServe).toBeUndefined();
    });

    it('POSITIVE CONTROL: static and php still require their root', () => {
        expect(sanitizeDevSitePatch({ hostServe: { mode: 'php' } as never }).hostServe).toBeUndefined();
        expect(sanitizeDevSitePatch({ hostServe: { mode: 'php', root: 'public' } }).hostServe).toEqual({
            mode: 'php',
            root: 'public',
        });
    });
});

describe('siteEngineUse — an Octane site runs PHP', () => {
    it('reports php, with the pin when there is one, so a default change names this site', () => {
        expect(
            siteEngineUse({ genName: 'a.acme.gen', hostServe: { mode: 'octane', server: 'swoole', version: '8.3' } }),
        ).toEqual({ genName: 'a.acme.gen', tool: 'php', version: '8.3' });
        expect(siteEngineUse({ genName: 'a.acme.gen', hostServe: { mode: 'octane', server: 'swoole' } })).toEqual({
            genName: 'a.acme.gen',
            tool: 'php',
        });
    });
});

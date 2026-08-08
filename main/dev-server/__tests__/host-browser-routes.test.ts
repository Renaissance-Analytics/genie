import { describe, expect, it } from 'vitest';
import { hostBrowserRoutes } from '../host-browser-routes';
import type { DevSiteConfig } from '../sites-config';

/**
 * Which live sites the host reconcile (CA + hosts-file + host Caddy :443) should
 * serve to REAL external browsers (story #238 P2). The rule is narrow on purpose:
 * a site is included ONLY when it is host-native (no container) AND the owner
 * opted it in with `browserExposed`. The in-app Testing Browser is unaffected —
 * it serves every `.gen` site through its own carrier regardless of this.
 */
const base = (over: Partial<DevSiteConfig> = {}): DevSiteConfig => ({
    name: 'web',
    genName: 'web.acme.gen',
    repo: 'app',
    runMode: 'host',
    kind: 'http',
    enabled: true,
    ...over,
});

describe('hostBrowserRoutes', () => {
    it('includes a browser-exposed host-native http site, using its LIVE port', () => {
        expect(
            hostBrowserRoutes([{ config: base({ genName: 'moic.gen', browserExposed: true }), port: 49_812 }]),
        ).toEqual([{ genName: 'moic.gen', port: 49_812 }]);
    });

    it('carries upstreamHost when the site pins one', () => {
        expect(
            hostBrowserRoutes([
                { config: base({ genName: 'moic.gen', browserExposed: true, upstreamHost: 'localhost' }), port: 8001 },
            ]),
        ).toEqual([{ genName: 'moic.gen', port: 8001, upstreamHost: 'localhost' }]);
    });

    it('EXCLUDES a host-native site that was not opted in', () => {
        expect(hostBrowserRoutes([{ config: base({ browserExposed: false }), port: 8001 }])).toEqual([]);
        expect(hostBrowserRoutes([{ config: base({}), port: 8001 }])).toEqual([]); // undefined ⇒ off
    });

    it('EXCLUDES a container site even when opted in (host-native only)', () => {
        // A container site is served by the sandbox Caddy; the host reconcile is
        // for host-native sites, which run no container.
        const container = base({ runMode: 'explicit', command: ['npm', 'run', 'dev'], browserExposed: true });
        expect(hostBrowserRoutes([{ config: container, port: 8001 }])).toEqual([]);
    });

    it('EXCLUDES a non-http (tcp) site', () => {
        expect(hostBrowserRoutes([{ config: base({ kind: 'tcp', browserExposed: true }), port: 8001 }])).toEqual([]);
    });

    it('accepts the external-hostPort form of host-native too', () => {
        const external = base({ runMode: 'explicit', hostPort: 8001, browserExposed: true, genName: 'api.gen' });
        expect(hostBrowserRoutes([{ config: external, port: 8001 }])).toEqual([{ genName: 'api.gen', port: 8001 }]);
    });

    it('dedupes by genName (last live entry wins) and sorts, so the reconcile is deterministic', () => {
        const rows = hostBrowserRoutes([
            { config: base({ genName: 'b.gen', browserExposed: true }), port: 2 },
            { config: base({ genName: 'a.gen', browserExposed: true }), port: 1 },
            { config: base({ genName: 'b.gen', browserExposed: true }), port: 3 },
        ]);
        expect(rows).toEqual([
            { genName: 'a.gen', port: 1 },
            { genName: 'b.gen', port: 3 },
        ]);
    });
});

import { describe, expect, it } from 'vitest';
import { hostBrowserNames, hostBrowserRoutes } from '../host-browser-routes';
import type { DevSiteConfig } from '../sites-config';

/**
 * Which live sites the host reconcile (CA + hosts-file + host Caddy :443) should
 * serve to REAL external browsers (story #238 P2). Every browser-exposed `http`
 * site is included — host-native AND container/image alike — with the upstream
 * SCHEME set per type (plain http for host-native, https-insecure for a container
 * reached through its self-signed sandbox Caddy). The in-app Testing Browser is
 * unaffected — it serves every `.gen` site through its own carrier regardless.
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

    it('INCLUDES a browser-exposed container site, reached via https-insecure (the fixed bug)', () => {
        // A container site is reachable from the host only through its sandbox Caddy
        // (self-signed, routes by Host). It used to be dropped here, so it loaded in
        // the Testing Browser but 502'd in the real browser. Now it is included with
        // the https-insecure upstream, and its `port` is the published sandbox port.
        const container = base({ runMode: 'explicit', command: ['npm', 'run', 'dev'], browserExposed: true, genName: 'moic.gen' });
        expect(hostBrowserRoutes([{ config: container, port: 49_001 }])).toEqual([
            { genName: 'moic.gen', port: 49_001, upstreamScheme: 'https-insecure' },
        ]);
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

/**
 * The other half of the split (genie#624): which `.gen` names the OS HOSTS FILE
 * carries. That question is answered from CONFIG alone — no port, no live entry —
 * because the hosts file is the one artifact whose write costs an administrator
 * prompt, and it must therefore not move when a site merely starts or stops.
 *
 * A name resolving to 127.0.0.1 with nothing listening is a connection refused,
 * which is a better error than a DNS failure and was never a claim that the
 * service was up.
 */
describe('hostBrowserNames', () => {
    it('names a browser-exposed http site from CONFIG — no port, nothing running', () => {
        expect(hostBrowserNames([base({ genName: 'moic.gen', browserExposed: true })])).toEqual(['moic.gen']);
    });

    it('names container and host-native sites alike — the hosts file does not care how it is served', () => {
        const container = base({ genName: 'shop.gen', runMode: 'explicit', command: ['npm', 'run', 'dev'], browserExposed: true });
        const native = base({ genName: 'api.gen', runMode: 'explicit', hostPort: 8001, browserExposed: true });
        expect(hostBrowserNames([container, native])).toEqual(['api.gen', 'shop.gen']);
    });

    it('EXCLUDES a site that was not browser-opted-in', () => {
        expect(hostBrowserNames([base({ browserExposed: false })])).toEqual([]);
        expect(hostBrowserNames([base({})])).toEqual([]); // undefined ⇒ off
    });

    it('EXCLUDES a non-http (tcp) site', () => {
        expect(hostBrowserNames([base({ kind: 'tcp', browserExposed: true })])).toEqual([]);
    });

    it('EXCLUDES a site that is not enabled — `enabled` is the ask that it be SERVED at all', () => {
        // `enabled` is the CONFIGURED axis (genie#407): persisted in the git-tracked
        // envelope, and explicitly not "running right now". So it belongs on this
        // side of the split, where a stop does not.
        expect(hostBrowserNames([base({ browserExposed: true, enabled: false })])).toEqual([]);
    });

    it('dedupes and sorts, so an unchanged configuration yields a byte-identical block', () => {
        expect(
            hostBrowserNames([
                base({ genName: 'b.gen', browserExposed: true }),
                base({ genName: 'a.gen', browserExposed: true }),
                base({ genName: 'b.gen', browserExposed: true }),
            ]),
        ).toEqual(['a.gen', 'b.gen']);
    });
});

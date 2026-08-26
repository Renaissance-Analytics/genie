import { describe, expect, it } from 'vitest';
import { buildCaddyfile, CADDY_HTTPS_PORT } from '../caddyfile';

/**
 * The per-workspace Caddy proxy config. Caddy runs INSIDE the workspace sandbox,
 * publishes ONE stable port, and for each enabled site TLS-terminates `<name>.gen`
 * (forcing https) and reverse-proxies to the app's plain-http localhost port. This
 * is what masks the app ports and forces https — the two things the model needs.
 * Pure string builder ⇒ deterministically testable.
 */
describe('buildCaddyfile', () => {
    it('serves each site on the shared https port, TLS-terminated, proxied to its localhost port', () => {
        const cf = buildCaddyfile([
            { host: 'moic-suite.acme.gen', port: 5173 },
            { host: 'api.acme.gen', port: 8000 },
        ]);
        // One vhost block per site, bound to the shared https listener.
        expect(cf).toContain(`moic-suite.acme.gen:${CADDY_HTTPS_PORT} {`);
        expect(cf).toContain(`api.acme.gen:${CADDY_HTTPS_PORT} {`);
        // TLS is terminated at Caddy (forces https); the carrier ignores the leaf,
        // so Caddy's internal issuer is fine.
        expect(cf).toContain('tls internal');
        // The app is reached over plain http on loopback inside the sandbox.
        expect(cf).toContain('reverse_proxy 127.0.0.1:5173');
        expect(cf).toContain('reverse_proxy 127.0.0.1:8000');
    });

    it('never serves plain http — no :80 listener, and every http:// is a rewrite SOURCE mapped to https', () => {
        const cf = buildCaddyfile([{ host: 'x.acme.gen', port: 3000 }]);
        // No bare http listener.
        expect(cf).not.toMatch(/:80\b/);
        // The config legitimately CONTAINS `http://<host>` — but ONLY as the left
        // side of a rewrite pair mapped to the https:// of the SAME host. There are
        // two such pairs now: the body `replace` (a literal match) and the `Link`
        // header rewrite (a regex, so the host's dots arrive escaped). Both exist
        // solely to be rewritten away; neither is ever served as an origin.
        expect(cf).toContain('"http://x.acme.gen" "https://x.acme.gen"');
        expect(cf).toContain('"http://x\\.acme\\.gen" "https://x.acme.gen"');
        // Every http:// in the file, with any regex escaping normalised away, must
        // be this site's own host AND be immediately mapped to its https twin — so a
        // future directive cannot smuggle in a plain-http origin unnoticed.
        const pairs = [...cf.matchAll(/"(http:\/\/[a-z0-9.\\-]+)" "(https:\/\/[a-z0-9.-]+)"/g)];
        expect(pairs.map((m) => m[1]!.replace(/\\/g, ''))).toEqual([
            'http://x.acme.gen',
            'http://x.acme.gen',
        ]);
        expect(pairs.map((m) => m[2])).toEqual(['https://x.acme.gen', 'https://x.acme.gen']);
        expect([...cf.matchAll(/http:\/\//g)]).toHaveLength(pairs.length);
    });

    it('rewrites the app\'s own in-body http://<host> up to https via a streamed `replace`', () => {
        const cf = buildCaddyfile([{ host: 'app.acme.gen', port: 4000 }]);
        expect(cf).toContain('replace {');
        expect(cf).toContain('stream');
        expect(cf).toContain('"http://app.acme.gen" "https://app.acme.gen"');
        // `replace` is auto-ordered AFTER encode (hence before reverse_proxy), so
        // it sits at site level and precedes the proxy in the emitted config.
        const replaceIdx = cf.indexOf('replace {');
        const proxyIdx = cf.indexOf('reverse_proxy 127.0.0.1:4000');
        expect(replaceIdx).toBeGreaterThan(-1);
        expect(proxyIdx).toBeGreaterThan(replaceIdx);
    });

    it('strips upstream Accept-Encoding so the body is plaintext for the rewrite', () => {
        const cf = buildCaddyfile([{ host: 'app.acme.gen', port: 4000 }]);
        expect(cf).toContain('header_up -Accept-Encoding');
    });

    it('is stable/deterministic for the same sites (so a no-op reload is a no-op)', () => {
        const a = buildCaddyfile([
            { host: 'b.acme.gen', port: 2 },
            { host: 'a.acme.gen', port: 1 },
        ]);
        const b = buildCaddyfile([
            { host: 'a.acme.gen', port: 1 },
            { host: 'b.acme.gen', port: 2 },
        ]);
        expect(a).toBe(b); // sorted, order-independent
    });

    it('rewrites the upstream Host when a site pins one (SNI stays the .gen name)', () => {
        // The carrier dials with SNI = Host = the `.gen` name so Caddy can route;
        // a framework that checks Host (Django ALLOWED_HOSTS) needs the UPSTREAM
        // Host rewritten to a name it accepts. `header_up Host` does exactly that.
        const cf = buildCaddyfile([{ host: 'web.acme.gen', port: 5173, upstreamHost: 'localhost' }]);
        expect(cf).toContain('header_up Host localhost');
        expect(cf).toContain('reverse_proxy 127.0.0.1:5173 {');
        // The vhost Caddy routes by is still the `.gen` name, unchanged.
        expect(cf).toContain(`web.acme.gen:${CADDY_HTTPS_PORT} {`);
    });

    it('adds no upstream Host rewrite when none is pinned, but STILL rewrites body + redirect scheme', () => {
        const cf = buildCaddyfile([{ host: 'web.acme.gen', port: 5173 }]);
        // No HOST rewrite (that's only for host-checking frameworks). The
        // `header_up -Accept-Encoding` strip is always present, so assert on the
        // precise `header_up Host` rather than any `header_up`.
        expect(cf).not.toContain('header_up Host');
        // Both scheme rewrites are on EVERY site: the response BODY (in-request
        // self-links) and the `Location` header (redirects), so an app that builds
        // URLs off the plain-http proxy hop still reaches the browser as https.
        expect(cf).toContain('reverse_proxy 127.0.0.1:5173 {');
        expect(cf).toContain('header_down Location "^http:" "https:"');
        expect(cf).toContain('"http://web.acme.gen" "https://web.acme.gen"');
    });

    it('forces https on redirects for a site WITH a pinned upstream Host too', () => {
        const cf = buildCaddyfile([{ host: 'web.acme.gen', port: 5173, upstreamHost: 'localhost' }]);
        expect(cf).toContain('header_up Host localhost');
        expect(cf).toContain('header_down Location "^http:" "https:"');
    });

    it('REFUSES an injectable upstream host', () => {
        expect(() =>
            buildCaddyfile([{ host: 'ok.gen', port: 3000, upstreamHost: 'bad host {' }]),
        ).toThrow();
    });

    it('produces a valid empty config when there are no sites', () => {
        const cf = buildCaddyfile([]);
        expect(cf).not.toContain('reverse_proxy');
        expect(typeof cf).toBe('string');
    });

    it('REFUSES a bad host or port rather than emit an injectable/again-broken config', () => {
        expect(() => buildCaddyfile([{ host: 'ok.gen', port: 0 }])).toThrow();
        expect(() => buildCaddyfile([{ host: 'ok.gen', port: 70000 }])).toThrow();
        expect(() => buildCaddyfile([{ host: 'bad host {', port: 3000 }])).toThrow();
        expect(() => buildCaddyfile([{ host: '', port: 3000 }])).toThrow();
    });
});

/**
 * The same `Link`-header gap the HOST front door had (see host-caddyfile.test.ts).
 * A container site is reached through THIS Caddy, so a Laravel/FrankenPHP app in
 * the sandbox emits its Vite preloads as `http://<name>.gen` in one `Link` header
 * and the browser blocks every one of them as mixed content. The body `replace`
 * cannot see a header, so the rewrite has to be stated here too — otherwise the
 * container path keeps the bug the host path just lost.
 */
describe('buildCaddyfile — https forcing reaches the Link preload header', () => {
    it('rewrites every http://<host> in the Link header', () => {
        const cf = buildCaddyfile([{ host: 'moic-suite.acme.gen', port: 5173 }]);
        expect(cf).toContain(
            'header_down Link "http://moic-suite\\.acme\\.gen" "https://moic-suite.acme.gen"',
        );
    });

    it('escapes the host so the pattern cannot match a look-alike origin', () => {
        const cf = buildCaddyfile([{ host: 'api.acme.gen', port: 8000 }]);
        // Scoped to the Link line — the BODY `replace` is a literal match and keeps
        // the unescaped host, so an unscoped assertion here would fail on that.
        expect(cf).toContain('header_down Link "http://api\\.acme\\.gen" "https://api.acme.gen"');
        expect(cf).not.toContain('header_down Link "http://api.acme.gen"');
    });
});

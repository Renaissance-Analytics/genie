import { describe, expect, it } from 'vitest';
import { buildHostCaddyfile, HOST_CADDY_HTTPS_PORT } from '../host-caddyfile';

/**
 * The HOST reverse-proxy config for host-native `.gen` sites (story #238, task
 * #673). Unlike the sandbox Caddy (in-container, :8443, `tls internal`, dialled
 * by the in-app carrier), this Caddy runs on the HOST, owns :443, and serves a
 * leaf from the Genie local CA — because the machine's REAL browser must trust
 * it. Pure string builder ⇒ deterministically testable.
 */
const TLS = { certPath: '/genie/ca/gen.crt', keyPath: '/genie/ca/gen.key' };

describe('buildHostCaddyfile', () => {
    it('serves each site on :443 with the Genie CA leaf, proxied to its HOST loopback port', () => {
        const cf = buildHostCaddyfile(
            [
                { host: 'moic.gen', port: 8080 },
                { host: 'app.gen', port: 5173 },
            ],
            TLS,
        );
        expect(HOST_CADDY_HTTPS_PORT).toBe(443);
        expect(cf).toContain(`moic.gen:${HOST_CADDY_HTTPS_PORT} {`);
        expect(cf).toContain(`app.gen:${HOST_CADDY_HTTPS_PORT} {`);
        // Real-browser trust ⇒ the Genie CA leaf, NOT Caddy's internal issuer.
        expect(cf).toContain('tls "/genie/ca/gen.crt" "/genie/ca/gen.key"');
        expect(cf).not.toContain('tls internal');
        expect(cf).toContain('reverse_proxy 127.0.0.1:8080');
        expect(cf).toContain('reverse_proxy 127.0.0.1:5173');
    });

    it('redirects plain http → https so a bare <name>.gen typed in the browser lands on TLS', () => {
        const cf = buildHostCaddyfile([{ host: 'moic.gen', port: 8080 }], TLS);
        expect(cf).toContain('http://moic.gen:80');
        expect(cf).toContain('redir https://moic.gen{uri}');
    });

    it('carries the beta.236 https-forcing — body replace + Location rewrite — per site', () => {
        const cf = buildHostCaddyfile([{ host: 'app.gen', port: 4000 }], TLS);
        expect(cf).toMatch(/replace @[A-Za-z0-9_]+ \{/);
        expect(cf).toContain('stream');
        expect(cf).toContain('"http://app.gen" "https://app.gen"');
        expect(cf).toContain('header_up -Accept-Encoding');
        expect(cf).toContain('header_down Location "^http:" "https:"');
    });

    /**
     * A `.gen` page opened a WebSocket, the socket OPENED, and then no frame ever
     * arrived — Echo sat at "unavailable" forever, which reads exactly like a
     * broken upgrade and is not one.
     *
     * Measured on this machine against a real browser, four ways. The body
     * `replace` and HTTP/2 are BOTH necessary; neither alone does it:
     *
     *   h1 + replace      -> OPEN + frame
     *   h1 + no replace   -> OPEN + frame
     *   h2 + replace      -> OPEN, then SILENT   <- the bug
     *   h2 + no replace   -> OPEN + frame
     *
     * h2 is not an edge case here. Every `.gen` name shares ONE leaf certificate
     * on ONE address, so Chromium COALESCES a WebSocket to `reverb.<ws>.gen` onto
     * the h2 connection it already holds for the page and sends it as an Extended
     * CONNECT stream. The same applies to a site's OWN same-origin `wss://` —
     * Vite HMR, or Echo pointed at the app's own host.
     *
     * So the rewriter must never see an upgraded connection. It has nothing to do
     * on one: there is no HTML body with self-links inside a WebSocket.
     */
    it('keeps the body rewriter off WebSocket upgrades — over h2 it swallows every frame', () => {
        const cf = buildHostCaddyfile([{ host: 'app.gen', port: 4000 }], TLS);
        // An h1 upgrade carries `Connection: Upgrade`. An h2 WebSocket carries no
        // such header — it is a CONNECT — so BOTH have to be excluded or the h2
        // case (the broken one) sails straight through the matcher.
        expect(cf).toContain('not header Connection *Upgrade*');
        expect(cf).toContain('not method CONNECT');
        // `replace` runs BEHIND that matcher, never unconditionally.
        expect(cf).toMatch(/replace @[A-Za-z0-9_]+ \{/);
        expect(cf).not.toMatch(/replace \{/);
        // The rewrite itself is unchanged for ordinary responses.
        expect(cf).toContain('"http://app.gen" "https://app.gen"');
    });

    it('rewrites the upstream Host when a site pins one', () => {
        const cf = buildHostCaddyfile([{ host: 'web.gen', port: 5173, upstreamHost: 'localhost' }], TLS);
        expect(cf).toContain('header_up Host localhost');
        expect(cf).toContain('reverse_proxy 127.0.0.1:5173 {');
    });

    it('a CONTAINER site proxies over https-insecure to the sandbox Caddy (Host = the gen name)', () => {
        // A container site is reachable from the host ONLY through its sandbox Caddy,
        // which serves a self-signed leaf and routes by Host. So the host Caddy dials
        // it over https, skips verification, and sends Host = the gen name — the same
        // way the in-app carrier reaches it. Without this, the container site loads in
        // the Testing Browser but 502s in the real browser.
        const cf = buildHostCaddyfile(
            [{ host: 'moic.gen', port: 49001, upstreamScheme: 'https-insecure' }],
            TLS,
        );
        expect(cf).toContain('reverse_proxy https://127.0.0.1:49001 {');
        expect(cf).toContain('header_up Host moic.gen');
        expect(cf).toContain('tls_insecure_skip_verify');
    });

    it('a host-native site stays PLAIN-http reverse_proxy (no tls transport)', () => {
        const cf = buildHostCaddyfile([{ host: 'web.gen', port: 5173 }], TLS);
        expect(cf).toContain('reverse_proxy 127.0.0.1:5173');
        expect(cf).not.toContain('tls_insecure_skip_verify');
        expect(cf).not.toContain('https://127.0.0.1');
    });

    it('is deterministic/sorted so an unchanged set is a no-op reload', () => {
        const a = buildHostCaddyfile(
            [
                { host: 'b.gen', port: 2 },
                { host: 'a.gen', port: 1 },
            ],
            TLS,
        );
        const b = buildHostCaddyfile(
            [
                { host: 'a.gen', port: 1 },
                { host: 'b.gen', port: 2 },
            ],
            TLS,
        );
        expect(a).toBe(b);
    });

    it('normalises Windows cert paths to forward slashes and quotes them', () => {
        const cf = buildHostCaddyfile([{ host: 'x.gen', port: 3000 }], {
            certPath: 'C:\\ProgramData\\Genie\\ca\\gen.crt',
            keyPath: 'C:\\ProgramData\\Genie\\ca\\gen.key',
        });
        expect(cf).toContain('tls "C:/ProgramData/Genie/ca/gen.crt" "C:/ProgramData/Genie/ca/gen.key"');
    });

    it('produces a valid empty config with no sites', () => {
        const cf = buildHostCaddyfile([], TLS);
        expect(cf).not.toContain('reverse_proxy');
        expect(typeof cf).toBe('string');
    });

    it('tolerates empty TLS paths when there are no sites (nothing references a cert)', () => {
        // The reconcile engine writes an empty config before any leaf exists, so a
        // site-less config must not demand a cert it has no vhost to use.
        expect(() => buildHostCaddyfile([], { certPath: '', keyPath: '' })).not.toThrow();
    });

    it('REFUSES a bad host/port, an injectable upstream host, or an injectable cert path', () => {
        expect(() => buildHostCaddyfile([{ host: 'ok.gen', port: 0 }], TLS)).toThrow();
        expect(() => buildHostCaddyfile([{ host: 'ok.gen', port: 70000 }], TLS)).toThrow();
        expect(() => buildHostCaddyfile([{ host: 'bad host {', port: 3000 }], TLS)).toThrow();
        expect(() => buildHostCaddyfile([{ host: 'ok.gen', port: 3000, upstreamHost: 'bad {' }], TLS)).toThrow();
        expect(() =>
            buildHostCaddyfile([{ host: 'ok.gen', port: 3000 }], { certPath: 'a"\nevil', keyPath: 'k' }),
        ).toThrow();
    });
});

/**
 * The gap beta.236 left, MEASURED on the owner's own `.gen` sites (biz.gen):
 * https forcing covered the response BODY (`replace`) and the `Location` header,
 * but NOTHING covered `Link`.
 *
 * Laravel's Vite integration advertises its preloads as an HTTP `Link` header, one
 * header carrying every asset — and it builds those URLs with `url()`/`asset()`, so
 * an app that does not know it is behind TLS emits `http://<name>.gen/...` there.
 * That header never passes through the body rewriter, so on biz.gen the browser
 * blocked 36 font/style/script preloads as mixed content while the (rewritten)
 * markup looked perfect. It is PHP-shaped in practice: a Node dev server emits no
 * preload `Link` header at all, which is why only PHP sites reported it.
 *
 * `Location` matches `^http:` because it holds ONE url; `Link` holds MANY, so this
 * is a scoped replace-all of the site's own host — third-party preloads untouched.
 */
describe('buildHostCaddyfile — https forcing reaches the Link preload header', () => {
    it('rewrites every http://<host> in the Link header, not just the first', () => {
        const cf = buildHostCaddyfile([{ host: 'biz.gen', port: 57661 }], TLS);
        expect(cf).toContain('header_down Link "http://biz\\.gen" "https://biz.gen"');
    });

    it('escapes the host so the pattern cannot match a look-alike name', () => {
        // Unescaped, `http://biz.gen` is a regex whose `.` matches ANY character —
        // so it would also rewrite `http://bizXgen`, a different origin entirely.
        const cf = buildHostCaddyfile([{ host: 'karma.imp.gen', port: 62396 }], TLS);
        expect(cf).toContain('header_down Link "http://karma\\.imp\\.gen" "https://karma.imp.gen"');
        // Scoped to the Link line: the BODY `replace` above legitimately carries the
        // unescaped host, because that one is a literal string match, not a regex.
        expect(cf).not.toContain('header_down Link "http://karma.imp.gen"');
    });

    it('applies to a CONTAINER site too — the preload header is stack-agnostic', () => {
        const cf = buildHostCaddyfile(
            [{ host: 'wallet.imp.gen', port: 51160, upstreamScheme: 'https-insecure' }],
            TLS,
        );
        expect(cf).toContain('header_down Link "http://wallet\\.imp\\.gen" "https://wallet.imp.gen"');
    });
});

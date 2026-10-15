import { describe, expect, it } from 'vitest';
import {
    CERT_ACCEPT,
    CERT_REFUSE,
    CERT_USE_CHROMIUM,
    absoluteFormAnswer,
    certificateVerdict,
    genProxyConfig,
    genProxyPac,
    isGenHost,
    resolveConnect,
    siteOrigin,
} from '../src/core/browser-origins.js';
import type { GenRoute } from '../src/core/gen-router.js';

/**
 * EACH `.gen` SITE AT ITS OWN HTTPS ORIGIN (S7) — the pure rules. The pane's session sends `*.gen` (and nothing else)
 * to the in-app front door as a proxy; the door tunnels `CONNECT <site>.gen:443` for a site it serves and nothing
 * else; and the session trusts a `.gen` certificate only when Genie's CA signed it for that host. Every list here is
 * COUNTED, so a case that silently changes side fails by number, not by vigilance.
 */

const PORT = 4100;
const routes: GenRoute[] = [
    { host: 'site-a.gen', target: '127.0.0.1:4101' },
    { host: 'site-b.gen', target: '127.0.0.1:4102' },
    { host: 'evil.gen', target: '10.0.0.5:80' },
];

/** Run the PAC the way Chromium does: define FindProxyForURL, call it with (url, host). */
function pac(port: number): (url: string) => string {
    const find = new Function(`${genProxyPac(port)}\nreturn FindProxyForURL;`)() as (url: string, host: string) => string;
    return (url) => find(url, new URL(url).hostname);
}

describe('the proxy rule covers *.gen and only *.gen', () => {
    it('`.gen` names go to the front door — counted', () => {
        const route = pac(PORT);
        const proxied = ['https://site-a.gen/', 'https://SITE-B.GEN/x', 'https://web.acme.gen/', 'http://site-a.gen/'].map(route);
        expect(proxied.filter((p) => p === `PROXY 127.0.0.1:${PORT}`)).toHaveLength(4);
    });

    it('everything else is DIRECT, including names that only CONTAIN "gen" — counted', () => {
        const route = pac(PORT);
        const direct = ['https://example.com/', 'https://example.gen.com/', 'https://gen/', 'https://agen/', 'https://example.org/gen', 'http://localhost:5173/', 'http://127.0.0.1:4101/'].map(route);
        expect(direct.filter((p) => p === 'DIRECT')).toHaveLength(7);
    });

    it('Electron gets it as ProxyConfig { mode: pac_script, pacScript: data: URL } holding exactly that script', () => {
        const config = genProxyConfig(PORT);
        expect(config.mode).toBe('pac_script');
        const prefix = 'data:application/x-ns-proxy-autoconfig;base64,';
        expect(config.pacScript.startsWith(prefix)).toBe(true);
        expect(atob(config.pacScript.slice(prefix.length))).toBe(genProxyPac(PORT));
    });

    it('a port the front door cannot have is refused, not written into the script', () => {
        for (const bad of [0, -1, 65536, 1.5, Number.NaN]) expect(() => genProxyPac(bad)).toThrow(/not a port/);
    });

    it('isGenHost and siteOrigin agree with the script', () => {
        expect(['site-a.gen', 'SITE-A.GEN', 'web.acme.gen', 'site-a.gen.'].filter(isGenHost)).toHaveLength(4);
        expect(['example.com', 'example.gen.com', 'gen', '', undefined].filter((h) => isGenHost(h))).toHaveLength(0);
        expect(siteOrigin('Site-A.gen')).toBe('https://site-a.gen');
        expect(() => siteOrigin('example.com')).toThrow(/not a \.gen name/);
    });
});

describe('the tunnel: CONNECT is answered for a served .gen site on 443, and refused for everything else', () => {
    it('a served site on 443 → the site and its loopback target', () => {
        expect(resolveConnect('site-a.gen:443', routes)).toEqual({ kind: 'site', host: 'site-a.gen', target: '127.0.0.1:4101' });
        expect(resolveConnect('SITE-B.gen:443', routes)).toEqual({ kind: 'site', host: 'site-b.gen', target: '127.0.0.1:4102' });
    });

    it('refused — counted, each for its own reason: not .gen (not an open proxy), not 443, nobody serves it, a non-loopback route, not host:port', () => {
        const cases: Array<[string | undefined, number]> = [
            ['example.com:443', 421],
            ['127.0.0.1:4101', 421],
            ['site-a.gen:80', 421],
            ['ghost.gen:443', 404],
            ['evil.gen:443', 404],
            ['site-a.gen', 400],
            ['', 400],
            [undefined, 400],
        ];
        const answers = cases.map(([a]) => resolveConnect(a, routes));
        expect(answers.filter((r) => r.kind === 'refused')).toHaveLength(cases.length);
        expect(answers.map((r) => (r.kind === 'refused' ? r.status : 0))).toEqual(cases.map(([, s]) => s));
    });

    it('a proxied plain-http .gen request is upgraded to the site’s https origin; any other proxied request is refused; origin-form passes', () => {
        expect(absoluteFormAnswer('http://site-a.gen/x?y=1')).toEqual({ kind: 'upgrade', location: 'https://site-a.gen/x?y=1' });
        expect(absoluteFormAnswer('/dashboard?x=1')).toEqual({ kind: 'origin-form' });
        const refused = ['http://example.com/', 'https://site-a.gen/', 'ftp://site-a.gen/', 'not a url'].map(absoluteFormAnswer);
        expect(refused.filter((r) => r.kind === 'refused')).toHaveLength(4);
    });
});

describe('the certificate verdict (the facts come from main/browser-trust.ts)', () => {
    const good = { signedByGenieCa: true, namesHost: true, inDate: true } as const;

    it('a .gen host is trusted ONLY with all three facts; any one missing, or an unreadable certificate, is refused — counted', () => {
        expect(certificateVerdict('site-a.gen', good)).toBe(CERT_ACCEPT);
        const refused = [
            certificateVerdict('site-a.gen', { ...good, signedByGenieCa: false }),
            certificateVerdict('site-a.gen', { ...good, namesHost: false }),
            certificateVerdict('site-a.gen', { ...good, inDate: false }),
            certificateVerdict('site-a.gen', null),
        ];
        expect(refused.filter((v) => v === CERT_REFUSE)).toHaveLength(4);
    });

    it('outside .gen nothing is loosened: Chromium decides — and a Genie-signed certificate is refused there outright', () => {
        expect(certificateVerdict('example.com', { signedByGenieCa: false, namesHost: true, inDate: true })).toBe(CERT_USE_CHROMIUM);
        expect(certificateVerdict('example.com', null)).toBe(CERT_USE_CHROMIUM);
        expect(certificateVerdict('example.com', good)).toBe(CERT_REFUSE);
        // Never ACCEPT outside .gen, whatever the facts.
        const all = [true, false].flatMap((s) => [true, false].flatMap((n) => [true, false].map((d) => certificateVerdict('example.com', { signedByGenieCa: s, namesHost: n, inDate: d }))));
        expect(all.filter((v) => v === CERT_ACCEPT)).toHaveLength(0);
    });

    it('the three answers are Electron’s documented codes', () => {
        expect([CERT_ACCEPT, CERT_REFUSE, CERT_USE_CHROMIUM]).toEqual([0, -2, -3]);
    });
});

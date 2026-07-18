import { describe, expect, it } from 'vitest';
import {
    parseHostsFile,
    isLoopbackIp,
    deriveGenName,
    siteIdFor,
    mergeSites,
    companionSiteIdFor,
    sanitizeTunnelPatch,
    parseTunnelSites,
    DEFAULT_PROBE,
    type SiteProbe,
    type TunnelSites,
} from '../hosts';

/**
 * Local-site discovery is the Herd-agnostic source of truth (§1), so the PURE
 * parse + merge must be exact — like `tailnet.test.ts` we drive every branch
 * directly (no fs / no probe): comment stripping, multi-name lines, the WHOLE
 * 127.0.0.0/8, `::1`, IPv4+IPv6 merge, noise + `0.0.0.0` exclusion, infra
 * flagging (default off), case-insensitive dedupe, and the settings merge.
 */

describe('isLoopbackIp', () => {
    it('accepts the whole 127.0.0.0/8, not just 127.0.0.1', () => {
        expect(isLoopbackIp('127.0.0.1')).toBe(true);
        expect(isLoopbackIp('127.0.0.2')).toBe(true);
        expect(isLoopbackIp('127.53.1.9')).toBe(true);
        expect(isLoopbackIp('127.255.255.255')).toBe(true);
    });
    it('accepts IPv6 loopback', () => {
        expect(isLoopbackIp('::1')).toBe(true);
        expect(isLoopbackIp('0:0:0:0:0:0:0:1')).toBe(true);
    });
    it('rejects 0.0.0.0, LAN, and non-loopback addresses', () => {
        expect(isLoopbackIp('0.0.0.0')).toBe(false); // all-interfaces / ad-block sink
        expect(isLoopbackIp('10.0.0.5')).toBe(false);
        expect(isLoopbackIp('192.168.1.4')).toBe(false);
        expect(isLoopbackIp('126.0.0.1')).toBe(false);
        expect(isLoopbackIp('128.0.0.1')).toBe(false);
        expect(isLoopbackIp('999.0.0.1')).toBe(false);
        expect(isLoopbackIp('not-an-ip')).toBe(false);
    });
});

describe('parseHostsFile', () => {
    it('strips comments and keeps only loopback-mapped names', () => {
        const text = [
            '# a comment line',
            '127.0.0.1  tynn.test   # trailing comment',
            '10.0.0.9   lan.test',
            '',
            '   ',
        ].join('\n');
        const sites = parseHostsFile(text);
        expect(sites.map((s) => s.hostname)).toEqual(['tynn.test']);
        expect(sites[0].kind).toBe('site');
    });

    it('handles multiple names on one line (all kept)', () => {
        const sites = parseHostsFile('127.0.0.1 app.test api.test admin.test');
        expect(sites.map((s) => s.hostname)).toEqual(['app.test', 'api.test', 'admin.test']);
    });

    it('keeps sites split across 127.0.0.2 / 127.0.0.3', () => {
        const sites = parseHostsFile(
            ['127.0.0.2 a.test', '127.0.0.3 b.test'].join('\n'),
        );
        expect(sites.map((s) => s.hostname)).toEqual(['a.test', 'b.test']);
    });

    it('merges the IPv4 + IPv6 rows for one name into a single site', () => {
        const sites = parseHostsFile(
            ['127.0.0.1 tynn.test', '::1 tynn.test'].join('\n'),
        );
        expect(sites).toHaveLength(1);
        expect(sites[0].hostname).toBe('tynn.test');
    });

    it('drops noise names and never surfaces 0.0.0.0 entries', () => {
        const text = [
            '127.0.0.1 localhost localhost.localdomain',
            '255.255.255.255 broadcasthost',
            '::1 ip6-localhost ip6-loopback',
            '127.0.0.1 foo.localhost', // bare *.localhost → noise
            '0.0.0.0 ads.example.com', // ad-block sink, not loopback
        ].join('\n');
        expect(parseHostsFile(text)).toEqual([]);
    });

    it('flags docker / minikube / *.internal helpers as infra (default off)', () => {
        const text = [
            '127.0.0.1 host.docker.internal',
            '127.0.0.1 gateway.docker.internal',
            '127.0.0.1 kubernetes.docker.internal',
            '127.0.0.1 host.minikube.internal',
            '127.0.0.1 my-wsl-box.internal',
            '127.0.0.1 tynn.test',
        ].join('\n');
        const sites = parseHostsFile(text);
        const infra = sites.filter((s) => s.kind === 'infra').map((s) => s.hostname);
        expect(infra).toEqual([
            'host.docker.internal',
            'gateway.docker.internal',
            'kubernetes.docker.internal',
            'host.minikube.internal',
            'my-wsl-box.internal',
        ]);
        expect(sites.find((s) => s.hostname === 'tynn.test')?.kind).toBe('site');
        // Nothing is enabled by parse — enable is a stored setting (default off).
        const merged = mergeSites(sites, {});
        expect(merged.every((m) => m.enabled === false)).toBe(true);
    });

    it('dedupes case-insensitively (Tynn.Test == tynn.test)', () => {
        const sites = parseHostsFile(
            ['127.0.0.1 Tynn.Test', '::1 tynn.test'].join('\n'),
        );
        expect(sites).toHaveLength(1);
        expect(sites[0].hostname).toBe('tynn.test'); // canonical lowercase
    });

    it('ignores a line with an IP but no names', () => {
        expect(parseHostsFile('127.0.0.1')).toEqual([]);
    });
});

describe('deriveGenName', () => {
    it('replaces the TLD label with gen', () => {
        expect(deriveGenName('tynn.test')).toBe('tynn.gen');
        expect(deriveGenName('app.test')).toBe('app.gen');
        expect(deriveGenName('mail.tynn.test')).toBe('mail.tynn.gen');
        expect(deriveGenName('TYNN.TEST')).toBe('tynn.gen');
    });
    it('appends .gen to a bare label', () => {
        expect(deriveGenName('tynn')).toBe('tynn.gen');
    });
});

describe('siteIdFor', () => {
    it('is stable and case-insensitive', () => {
        expect(siteIdFor('tynn.test')).toBe(siteIdFor('TYNN.TEST'));
        expect(siteIdFor('tynn.test')).toHaveLength(16);
    });
    it('differs per hostname', () => {
        expect(siteIdFor('a.test')).not.toBe(siteIdFor('b.test'));
    });
});

describe('mergeSites', () => {
    const discovered = parseHostsFile('127.0.0.1 tynn.test');
    const id = discovered[0].siteId;

    it('applies the convention default when unprobed + unconfigured', () => {
        const [m] = mergeSites(discovered, {});
        expect(m).toEqual({
            hostname: 'tynn.test',
            scheme: DEFAULT_PROBE.scheme,
            port: DEFAULT_PROBE.port,
            kind: 'site',
            enabled: false,
            genName: 'tynn.gen',
            siteId: id,
        });
    });

    it('prefers a probe over the default, and a stored override over the probe', () => {
        const probes: Record<string, SiteProbe> = { 'tynn.test': { scheme: 'http', port: 80 } };
        const [probed] = mergeSites(discovered, {}, probes);
        expect(probed.scheme).toBe('http');
        expect(probed.port).toBe(80);

        const settings: TunnelSites = {
            [id]: { enabled: true, genName: 'custom.gen', scheme: 'https', port: 8443 },
        };
        const [overridden] = mergeSites(discovered, settings, probes);
        expect(overridden.scheme).toBe('https');
        expect(overridden.port).toBe(8443);
        expect(overridden.genName).toBe('custom.gen');
        expect(overridden.enabled).toBe(true);
    });

    it('treats only enabled===true as enabled (default off)', () => {
        expect(mergeSites(discovered, { [id]: {} })[0].enabled).toBe(false);
        expect(mergeSites(discovered, { [id]: { enabled: false } })[0].enabled).toBe(false);
        expect(mergeSites(discovered, { [id]: { enabled: true } })[0].enabled).toBe(true);
    });
});

describe('sanitizeTunnelPatch', () => {
    it('keeps well-typed fields and clamps the port', () => {
        expect(
            sanitizeTunnelPatch({ enabled: true, scheme: 'https', port: 8443, genName: '  x.gen ' }),
        ).toEqual({ enabled: true, scheme: 'https', port: 8443, genName: 'x.gen' });
    });
    it('keeps only explicitly enabled, loopback companion endpoints', () => {
        expect(
            sanitizeTunnelPatch({
                companions: [
                    {
                        id: 'vite',
                        enabled: true,
                        hostname: 'vite.test',
                        scheme: 'http',
                        port: 5173,
                    },
                    {
                        id: 'docs',
                        enabled: true,
                        hostname: 'docs.api.example.dev',
                        scheme: 'http',
                        port: 3001,
                        loopback: '::1',
                    },
                    {
                        id: '../escape',
                        enabled: true,
                        hostname: 'not a hostname',
                        scheme: 'http',
                        port: 80,
                    },
                ],
            }),
        ).toEqual({
            companions: [
                {
                    id: 'vite',
                    enabled: true,
                    hostname: 'vite.test',
                    scheme: 'http',
                    port: 5173,
                },
                {
                    id: 'docs',
                    enabled: true,
                    hostname: 'docs.api.example.dev',
                    scheme: 'http',
                    port: 3001,
                    loopback: '::1',
                },
            ],
        });
    });
    it('drops junk (bad scheme, out-of-range port, empty name, non-object)', () => {
        expect(
            sanitizeTunnelPatch({
                enabled: 'yes',
                scheme: 'ftp',
                port: 70000,
                genName: '   ',
            } as unknown as Parameters<typeof sanitizeTunnelPatch>[0]),
        ).toEqual({});
        expect(sanitizeTunnelPatch(null)).toEqual({});
        expect(sanitizeTunnelPatch(undefined)).toEqual({});
    });
});

describe('companion endpoint identity', () => {
    it('is stable and scoped to both the owning site and endpoint id', () => {
        expect(companionSiteIdFor('site-a', 'vite')).toBe(
            companionSiteIdFor('site-a', 'vite'),
        );
        expect(companionSiteIdFor('site-a', 'vite')).not.toBe(
            companionSiteIdFor('site-b', 'vite'),
        );
        expect(companionSiteIdFor('site-a', 'vite')).toHaveLength(16);
    });
});

describe('parseTunnelSites', () => {
    it('reads NULL / corrupt JSON as an empty (nothing-enabled) map', () => {
        expect(parseTunnelSites(null)).toEqual({});
        expect(parseTunnelSites('')).toEqual({});
        expect(parseTunnelSites('{ not json')).toEqual({});
        expect(parseTunnelSites('[1,2,3]')).toEqual({});
    });
    it('sanitizes each entry', () => {
        const raw = JSON.stringify({
            abc: { enabled: true, port: 8080, scheme: 'http', junk: 1 },
        });
        expect(parseTunnelSites(raw)).toEqual({
            abc: { enabled: true, port: 8080, scheme: 'http' },
        });
    });
});

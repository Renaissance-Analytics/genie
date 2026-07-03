import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Identity-first discovery: two IP-observations of the SAME hostId collapse to one
 * entry (an IP change / a host reachable at two addresses isn't a duplicate),
 * while an old host with no hostId stays keyed by ip:port. Mocks the tailnet status
 * + `/api/ping` fetch so no real network is touched.
 */

vi.mock('../../tailscale', () => ({
    getTailscaleStatus: vi.fn(async () => ({
        installed: true,
        running: true,
        self: null,
        peers: [
            { hostname: 'alpha', ip: '100.0.0.1', online: true, os: 'linux' },
            { hostname: 'alpha', ip: '100.0.0.2', online: true, os: 'linux' }, // same host, moved IP
            { hostname: 'legacy', ip: '100.0.0.9', online: true, os: 'macOS' }, // old build, no hostId
        ],
    })),
}));

import { discoverHosts } from '../index';

afterEach(() => vi.restoreAllMocks());

describe('discoverHosts — merge by stable identity', () => {
    it('collapses two IPs of one hostId into a single entry, keeps an old host as ip:port, records port', async () => {
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
            const url = String(input);
            const body =
                url.includes('100.0.0.1') || url.includes('100.0.0.2')
                    ? { genie: true, hostId: 'SAME', name: 'alpha', dnsName: 'alpha.ts.net' }
                    : url.includes('100.0.0.9')
                        ? { genie: true, name: 'legacy' } // no hostId → ip:port fallback
                        : {};
            return new Response(JSON.stringify(body), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        });

        const hosts = await discoverHosts();

        // 3 online peers, but the two same-hostId ones merge → 2 entries.
        expect(hosts).toHaveLength(2);

        const byKey = new Map(hosts.map((h) => [h.connKey, h]));
        expect(byKey.has('host:SAME')).toBe(true);
        expect(byKey.has('100.0.0.9:51718')).toBe(true);

        const merged = byKey.get('host:SAME')!;
        expect(merged.hostId).toBe('SAME');
        expect(merged.dnsName).toBe('alpha.ts.net');
        expect(merged.port).toBe(51718); // per-host port is recorded

        const legacy = byKey.get('100.0.0.9:51718')!;
        expect(legacy.hostId).toBeUndefined();
    });
});

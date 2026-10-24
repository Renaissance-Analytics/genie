import { createServer, type Server } from 'node:https';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchLocalSite } from '../scripts/local-site-probe.mjs';
import { x509Issuer } from '../src/main/gen-ca.js';

describe('the VM acceptance HTTPS probe authenticates the local front door', () => {
    let server: Server;
    let port: number;
    let ca: string;
    let unrelatedCa: string;
    const host = 'acceptance-proof.gen';

    beforeAll(async () => {
        const now = Date.now();
        const authority = x509Issuer.ca(now);
        const leaf = x509Issuer.leaf(authority, [host], now);
        ca = authority.certPem;
        unrelatedCa = x509Issuer.ca(now).certPem;
        server = createServer({ key: leaf.keyPem, cert: leaf.certPem }, (_request, response) => response.end('fixture site'));
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('expected a loopback TCP listener');
        port = address.port;
    });

    afterAll(async () => {
        server?.closeAllConnections();
        if (server?.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    });

    it('accepts the actual local CA and matching hostname without installing an OS root', async () => {
        await expect(fetchLocalSite(host, ca, port)).resolves.toEqual({ status: 200, body: 'fixture site' });
    });

    it('refuses an unrelated CA even when the fixture page answers', async () => {
        const result = await fetchLocalSite(host, unrelatedCa, port);
        expect(result.status, 'an untrusted signer must not produce an accepted response').toBe(0);
        expect(result.body).toMatch(/certificate|issuer|verify/i);
    });

    it('refuses a different hostname even with the correct CA', async () => {
        const result = await fetchLocalSite('other-proof.gen', ca, port);
        expect(result.status, 'a wrong hostname must not produce an accepted response').toBe(0);
        expect(result.body).toMatch(/altnames|hostname/i);
    });
});

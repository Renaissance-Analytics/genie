import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStaticRuntime } from '../static';
import { createLocalSiteCarrier } from '../../sites/local-carrier';
import { mergeHostedSites } from '../../sites/local-sites';
import { hostedSiteIdFor } from '../sites-config';
import type { BoundServer, HostedSite, HttpListener, ListenOptions } from '../types';
import type { EnabledGenSite } from '../../remote';
import type { LocalTarget } from '../../sites/local-carrier';

/**
 * The serve path, END TO END, over a real socket.
 *
 * Every other test in this directory drives a seam. This one does not: it writes
 * a real built site to disk, binds a real loopback listener, and fetches it
 * through the SAME `createLocalSiteCarrier` + `/api/site/<siteId>/<path>` dial
 * the Testing Browser's site shim performs. So it covers the join the unit tests
 * cannot — that a `HostedStatus.target` is actually dialable as a `LocalTarget`,
 * and that a hosted site's opaque id survives `mergeHostedSites` into the map
 * the carrier resolves against.
 *
 * Deliberately STATIC-only. The PHP path needs a ~170 MB FrankenPHP download,
 * which would make this suite depend on GitHub being up — the definition of a
 * flaky test. That path is covered by the adapters' seam tests plus the manual
 * end-to-end run recorded in the P2 PR.
 *
 * The listener is wrapped to bind port 0 rather than the site's derived port:
 * `assignPort` is deterministic by design, and a fixed port in a shared CI
 * runner is a collision waiting to happen. The runtime reports whatever was
 * actually bound, so the rest of the path is unchanged.
 */

let dir: string;
let site: HostedSite;

/** The real listener, forced onto an ephemeral port. */
const ephemeral: HttpListener = {
    async listen(handler, opts: ListenOptions): Promise<BoundServer> {
        const server = http.createServer(handler as never);
        return new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, opts.host, () => {
                const addr = server.address();
                resolve({
                    port: typeof addr === 'object' && addr ? addr.port : 0,
                    close: () => new Promise<void>((done) => server.close(() => done())),
                });
            });
        });
    },
};

beforeAll(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'genie-hosting-'));
    await fsp.mkdir(path.join(dir, 'assets'), { recursive: true });
    await fsp.writeFile(
        path.join(dir, 'index.html'),
        '<!doctype html><title>hosted</title><script type="module" src="/assets/app-abc123.js"></script>',
    );
    await fsp.writeFile(path.join(dir, 'assets', 'app-abc123.js'), 'export const hosted = true;\n');
    // The file a traversal attempt would be after.
    await fsp.writeFile(path.join(path.dirname(dir), 'genie-hosting-secret.txt'), 'TOP SECRET');
    site = {
        id: hostedSiteIdFor('proof.test'),
        hostname: 'proof.test',
        root: dir,
        kind: 'static',
    };
});

afterAll(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.rm(path.join(path.dirname(dir), 'genie-hosting-secret.txt'), { force: true });
});

/** Issue the exact request the Testing Browser's site shim issues. */
function viaCarrier(
    carrier: ReturnType<typeof createLocalSiteCarrier>,
    siteId: string,
    upstreamPath: string,
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
    const call = carrier.forward({
        workspaceId: 'ws1',
        siteId,
        method: 'GET',
        path: `/api/site/${siteId}${upstreamPath}`,
        headers: { host: 'testing-browser.local' },
        body: Readable.from([]),
    });
    return call.response.then(
        (res) =>
            new Promise((resolve) => {
                const chunks: Buffer[] = [];
                res.body.on('data', (c: Buffer) => chunks.push(c));
                res.body.on('end', () =>
                    resolve({
                        status: res.status,
                        headers: res.headers,
                        body: Buffer.concat(chunks).toString('utf8'),
                    }),
                );
            }),
    );
}

describe('a hosted site, loaded the way the Testing Browser loads it', () => {
    it('serves the app, its hashed asset and its client routes from ONE origin', async () => {
        const runtime = createStaticRuntime({ listener: ephemeral });
        const status = await runtime.start(site);
        expect(status.state).toBe('running');
        expect(status.target).not.toBeNull();

        // What refreshSites does: overlay the hosted rows, then reduce to the
        // siteId → LocalTarget map the carrier resolves against.
        const hosted: EnabledGenSite = {
            workspaceId: 'ws1',
            genName: 'proof.gen',
            siteId: status.siteId,
            hostname: site.hostname,
            scheme: status.target!.scheme,
            port: status.target!.port,
            loopback: '127.0.0.1',
        };
        const targets = new Map<string, LocalTarget>(
            mergeHostedSites([], [hosted]).map((s) => [
                s.siteId,
                { scheme: s.scheme, hostname: s.hostname, port: s.port, loopback: s.loopback },
            ]),
        );
        const carrier = createLocalSiteCarrier((id) => targets.get(id) ?? null);

        try {
            const home = await viaCarrier(carrier, status.siteId, '/');
            expect(home.status).toBe(200);
            expect(home.headers['content-type']).toContain('text/html');
            expect(home.body).toContain('<title>hosted</title>');

            // The asset the page references — SAME origin, no companion port.
            const asset = await viaCarrier(carrier, status.siteId, '/assets/app-abc123.js');
            expect(asset.status).toBe(200);
            expect(asset.headers['content-type']).toContain('text/javascript');
            expect(asset.body).toContain('export const hosted');

            // A client-side route is a legitimate URL of this origin, so the
            // shell is served with 200 rather than a 404.
            const route = await viaCarrier(carrier, status.siteId, '/settings/profile');
            expect(route.status).toBe(200);
            expect(route.body).toContain('<title>hosted</title>');
        } finally {
            await runtime.stopAll();
        }
    });

    it('refuses to serve anything outside the document root', async () => {
        // The traversal guard is unit-tested against `resolveStaticFile`, but
        // only a real request proves nothing between the socket and that
        // function un-escapes the path first.
        const runtime = createStaticRuntime({ listener: ephemeral });
        const status = await runtime.start(site);
        const carrier = createLocalSiteCarrier(() => ({
            scheme: status.target!.scheme,
            hostname: site.hostname,
            port: status.target!.port,
            loopback: '127.0.0.1',
        }));
        try {
            for (const attempt of [
                '/../genie-hosting-secret.txt',
                '/%2e%2e/genie-hosting-secret.txt',
                '/..%5cgenie-hosting-secret.txt',
            ]) {
                const res = await viaCarrier(carrier, status.siteId, attempt);
                expect(res.body).not.toContain('TOP SECRET');
                // Asserting the STATUS as well, so this cannot pass simply
                // because the request never reached the handler.
                expect(res.status).toBe(403);
                expect(res.body).toBe('forbidden');
            }
        } finally {
            await runtime.stopAll();
        }
    });

    it('stops serving once the site is stopped', async () => {
        const runtime = createStaticRuntime({ listener: ephemeral });
        const status = await runtime.start(site);
        const port = status.target!.port;
        await runtime.stop(status.siteId);
        const carrier = createLocalSiteCarrier(() => ({
            scheme: 'http',
            hostname: site.hostname,
            port,
            loopback: '127.0.0.1',
        }));
        await expect(viaCarrier(carrier, status.siteId, '/')).rejects.toThrow();
    });
});

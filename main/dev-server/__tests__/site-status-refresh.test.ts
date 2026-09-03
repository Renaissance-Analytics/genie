import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createDevSiteManager } from '../site-manager';
import { devSiteIdFor } from '../sites-config';
import type { DevSiteConfig, DevSites } from '../sites-config';
import type { ContainerRuntime, RuntimeDetection } from '../container-runtime';

/**
 * READINESS IS A LIVE QUESTION, NOT A START-TIME SNAPSHOT (genie#305).
 *
 * A `hostServe: php` site is TWO host processes: Genie's bundled Caddy on the
 * site port, and a `php-cgi` FastCGI worker on a second one. The reported bug is
 * what happens when the worker dies AFTER a good start — Caddy stays up, answers
 * every request with `502 dial tcp 127.0.0.1:<fcgi>: actively refused`, and
 * `manageSite status` keeps reporting `ready: true` because nothing re-asks.
 *
 * Two things have to be true to end that, and NEITHER is sufficient alone:
 *
 *  1. **Something must re-run.** `ready` was written only on the start path, so
 *     the value outlived the thing it measured.
 *  2. **The re-run must ask the process that actually died.** `waitForHttp`
 *     counts ANY status as "a server answered" — deliberately, see below — so
 *     re-probing Caddy over HTTP would return `true` against a 502 and retire
 *     nothing.
 *
 * ## Why the fix is NOT "reject 502 in waitForHttp"
 *
 * `waitForHttp` is shared by both host paths, and they probe different things:
 *
 *  - a `hostServe` site's port is Genie's OWN Caddy, from a Caddyfile Genie
 *    wrote — the only 502 it originates is a refused dial to the FastCGI port;
 *  - a NON-`hostServe` host-native site's port is THE APP'S OWN dev server, and
 *    a Next.js rewrite, a BFF or a Vite proxy can answer 502/503/504 while
 *    perfectly healthy.
 *
 * A blanket rejection would report those healthy apps as not-ready. So the
 * FastCGI backend is asked directly instead, in the only protocol it speaks: a
 * TCP connect. The false-negative guard at the bottom of this file is the test
 * that proves the gate went in the right place rather than everywhere.
 */

const NO_RUNTIME: RuntimeDetection = { kind: 'none', probes: [] };

const WS = { id: 'acme', path: '/work/acme', label: 'acme' };
const SITE_ID = devSiteIdFor('acme', 'web');

/** The probe requests the manager issued, in order. */
type ProbeReq = {
    port: number;
    kind: 'http' | 'tcp';
    servername?: string;
    hostHeader?: string;
    timeoutMs: number;
};

/** A `hostServe: php` site — Genie's Caddy in front of its own php-cgi worker. */
const PHP_SITE: DevSiteConfig = {
    name: 'web',
    genName: 'web.acme.gen',
    repo: 'app',
    runMode: 'host',
    kind: 'http',
    enabled: true,
    hostServe: { mode: 'php', root: 'public' },
};

/** A host-native site running THE REPO'S OWN dev server — no `hostServe`. */
const DEV_SERVER_SITE: DevSiteConfig = {
    name: 'web',
    genName: 'web.acme.gen',
    repo: 'app',
    runMode: 'host',
    kind: 'http',
    enabled: true,
    command: ['npm', 'run', 'dev'],
    port: 3000,
};

/** A hostSpawn whose started processes stay up — the ordinary case. */
function fakeHostSpawn() {
    const started: string[] = [];
    return {
        started,
        start: async (i: { siteId: string }) => {
            started.push(i.siteId);
            return { ok: true as const, pid: 4242 };
        },
        stop: async () => {},
        alive: async (id: string) => started.includes(id),
        readLog: async () => '',
    };
}

const PHP_CGI = '/gd/toolchain/php/8.3.33/bin/php-cgi';

/** The site's Caddy port, then the FastCGI worker port. */
const SITE_PORT = 5301;
const FCGI_PORT = 5302;

function phpManager(
    probeReady: (req: ProbeReq) => Promise<boolean>,
    extra: Partial<Parameters<typeof createDevSiteManager>[0]> = {},
) {
    const ports = [SITE_PORT, FCGI_PORT];
    const sites: DevSites = { [SITE_ID]: PHP_SITE };
    return createDevSiteManager({
        resolveRuntime: async () => ({ runtime: null as ContainerRuntime | null, detection: NO_RUNTIME }),
        listWorkspaces: () => [WS],
        devSitesFor: () => sites,
        platform: 'linux',
        hostIds: null,
        hostSpawn: fakeHostSpawn(),
        probeReady,
        allocateFreePort: async () => ports.shift() ?? 5999,
        caddyBin: '/opt/genie/caddy',
        writeServeConfig: (siteId: string) => `/cfg/${siteId}.caddyfile`,
        resolveEngine: async () => ({
            ok: true as const,
            version: '8.3.33',
            install: {
                tool: 'php' as const,
                version: '8.3.33',
                dir: '/gd/toolchain/php/8.3.33',
                exe: '/gd/toolchain/php/8.3.33/bin/php',
                source: 'genie' as const,
                removable: true,
            },
            exe: PHP_CGI,
        }),
        ...extra,
    });
}

describe('refresh — status re-asks, instead of replaying the start-time answer (genie#305)', () => {
    it('flips a hostServe php site to NOT ready when its FastCGI backend has gone — no restart involved', async () => {
        // The reported machine: the site started fine, served, and then the
        // php-cgi worker died. Caddy is still up and still answering.
        const probes: ProbeReq[] = [];
        let backendUp = true;
        const changes: number[] = [];
        const m = phpManager(
            async (req) => {
                probes.push(req);
                // Caddy answers whatever happens — with a 502 once the backend is
                // gone, which `waitForHttp` counts as "a server answered".
                if (req.kind === 'http') return true;
                return backendUp;
            },
            { onChanged: () => changes.push(1) },
        );

        const status = await m.start('acme', SITE_ID);
        expect(status.state).toBe('running');
        expect(status.ready).toBe(true);

        // The worker dies. NOTHING else happens — no restart, no reconfigure.
        backendUp = false;
        probes.length = 0;
        const before = changes.length;
        await m.refresh('acme');

        // The FastCGI port was asked directly, over TCP — the only question that
        // can tell a dead backend from a live one behind a 502.
        expect(probes.some((p) => p.kind === 'tcp' && p.port === FCGI_PORT)).toBe(true);
        expect(m.list('acme')[0]?.ready).toBe(false);
        // And the change was announced, so the UI stops asserting something false.
        expect(changes.length).toBeGreaterThan(before);
    });

    it('POSITIVE CONTROL — a HEALTHY hostServe php site is still ready after a refresh', async () => {
        // A probe that always says no would pass the test above and be worthless.
        const probes: ProbeReq[] = [];
        const m = phpManager(async (req) => {
            probes.push(req);
            return true;
        });

        await m.start('acme', SITE_ID);
        probes.length = 0;
        await m.refresh('acme');

        // It really re-probed (not a cached value) AND it came back ready.
        expect(probes.some((p) => p.kind === 'tcp' && p.port === FCGI_PORT)).toBe(true);
        expect(m.list('acme')[0]?.ready).toBe(true);
    });

    it('marks a hostServe php site NOT ready at START when the backend never answers, even though Caddy does', async () => {
        // The same gate on the start path: a Caddy that comes up in front of a
        // backend that is not there must not report a serving site.
        const m = phpManager(async (req) => req.kind === 'http');
        const status = await m.start('acme', SITE_ID);
        expect(status.state).toBe('running');
        expect(status.ready).toBe(false);
    });

    it('ADOPTS a php site whose worker did NOT survive the restart as NOT ready', async () => {
        // Genie restarts (an update is a quit), the detached Caddy outlives it and
        // is re-attached — but the php-cgi worker is gone. Its port died with the
        // last process, so there is nothing to connect to; the worker is still a
        // process Genie TRACKS, though, so the registry can answer instead. Asking
        // Caddy here would report a serving site: it answers 502 either way.
        const sites: DevSites = { [SITE_ID]: PHP_SITE };
        const m = createDevSiteManager({
            resolveRuntime: async () => ({ runtime: null, detection: NO_RUNTIME }),
            listWorkspaces: () => [WS],
            devSitesFor: () => sites,
            platform: 'linux',
            hostIds: null,
            hostSpawn: {
                start: async () => ({ ok: true as const, pid: 1 }),
                stop: async () => {},
                // The Caddy survived; the worker did not.
                alive: async (id: string) => id === SITE_ID,
                readLog: async () => '',
                // Only the run whose pid is still alive comes back, so the worker's
                // recorded port is not among them.
                running: async () => [{ siteId: SITE_ID, port: SITE_PORT }],
            },
            probeReady: async () => true,
        });

        await m.adopt();

        expect(m.list('acme')[0]?.state).toBe('running');
        expect(m.list('acme')[0]?.ready).toBe(false);
    });

    it('ADOPTS a php site whose worker DID survive as ready — re-learning its FastCGI port from the run', async () => {
        // The positive control for the case above, and the reason the worker's port
        // travels with its run: a restart must not cost the site its readiness.
        const probes: ProbeReq[] = [];
        const sites: DevSites = { [SITE_ID]: PHP_SITE };
        const m = createDevSiteManager({
            resolveRuntime: async () => ({ runtime: null, detection: NO_RUNTIME }),
            listWorkspaces: () => [WS],
            devSitesFor: () => sites,
            platform: 'linux',
            hostIds: null,
            hostSpawn: {
                start: async () => ({ ok: true as const, pid: 1 }),
                stop: async () => {},
                alive: async () => true,
                readLog: async () => '',
                running: async () => [
                    { siteId: SITE_ID, port: SITE_PORT },
                    { siteId: `${SITE_ID}-fcgi`, port: FCGI_PORT },
                ],
            },
            probeReady: async (req) => {
                probes.push(req);
                return true;
            },
        });

        await m.adopt();

        expect(probes.some((p) => p.kind === 'tcp' && p.port === FCGI_PORT)).toBe(true);
        expect(m.list('acme')[0]?.ready).toBe(true);
    });

    it('re-probes a NON-hostServe host-native site over PLAIN http with no servername (genie#160)', async () => {
        // The repo's own dev server speaks plain http on the host port. A
        // servername would route the probe to the HTTPS-SNI path, whose handshake
        // fails against it — a site that is up reading not-ready.
        const probes: ProbeReq[] = [];
        const sites: DevSites = { [SITE_ID]: DEV_SERVER_SITE };
        const m = createDevSiteManager({
            resolveRuntime: async () => ({ runtime: null, detection: NO_RUNTIME }),
            listWorkspaces: () => [WS],
            devSitesFor: () => sites,
            platform: 'linux',
            hostIds: null,
            hostSpawn: fakeHostSpawn(),
            probeReady: async (req) => {
                probes.push(req);
                return true;
            },
            allocateFreePort: async () => 5321,
        });

        await m.start('acme', SITE_ID);
        probes.length = 0;
        await m.refresh('acme');

        expect(probes).toHaveLength(1);
        expect(probes[0]?.kind).toBe('http');
        expect(probes[0]?.port).toBe(5321);
        expect(probes[0]?.servername).toBeUndefined();
        expect(m.list('acme')[0]?.ready).toBe(true);
    });
});

// --- the false-negative guard, against a REAL socket ------------------------

const servers: Array<http.Server | net.Server> = [];

afterEach(() => {
    for (const server of servers.splice(0)) server.close();
});

/** A real HTTP server on an ephemeral loopback port, answering `status`. */
function serveStatus(status: number): Promise<number> {
    const server = http.createServer((_req, res) => {
        res.writeHead(status);
        res.end();
    });
    servers.push(server);
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
    });
}

describe('the 502 false-negative guard — a healthy app that answers 502 is STILL ready', () => {
    it('keeps a NON-hostServe host-native site ready through a refresh against a real 502', async () => {
        // NO injected probe: the manager runs its REAL `waitForHttp` against a real
        // socket. This is the assertion that proves the FastCGI gate went in the
        // right place — a 502 rejection applied to this path would report a
        // Next.js rewrite / BFF / Vite proxy as dead.
        const port = await serveStatus(502);
        const sites: DevSites = {
            [SITE_ID]: {
                name: 'web',
                genName: 'web.acme.gen',
                repo: 'app',
                runMode: 'explicit',
                kind: 'http',
                enabled: true,
                // An EXTERNAL host-native site: `.gen` points straight at a dev
                // server the user already runs. No hostServe, no Genie Caddy.
                hostPort: port,
            },
        };
        const m = createDevSiteManager({
            resolveRuntime: async () => ({ runtime: null, detection: NO_RUNTIME }),
            listWorkspaces: () => [WS],
            devSitesFor: () => sites,
            platform: 'linux',
            hostIds: null,
            readyTimeoutMs: 4_000,
        });

        const status = await m.start('acme', SITE_ID);
        expect(status.ready).toBe(true);

        await m.refresh('acme');
        expect(m.list('acme')[0]?.ready).toBe(true);
    });
});

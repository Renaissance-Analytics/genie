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
        // A php site is given the upload directory its worker spools into (genie#534);
        // without one it does not start at all, which is the point of that refusal.
        prepareUploadTmpDir: (siteId: string) => `/gd/host-site-uploads/${siteId}`,
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

/**
 * NOTICING IS NOT ENOUGH — THE WORKER HAS TO COME BACK (genie#305, genie#626).
 *
 * Everything above proves Genie stops LYING about a dead FastCGI worker. It does
 * not bring it back, and the owner's requirement is the other half:
 *
 *   "nothing should ever crash that, and if that is an inevitable thing, then
 *    something needs to be able to bring it back when it crashed. This keeps
 *    jamming up agents trying to test their work."
 *
 * An honest `ready:false` still leaves the site 502ing until a person notices, and
 * the reporter's workstation had accumulated DOZENS of orphaned php-cgi processes
 * — so the failure is routine, not exotic. A supervised child with no restart
 * policy is the whole defect.
 *
 * ## Why a bounded restart, and not an unconditional one
 *
 * A worker that dies because its PHP install is broken dies again immediately.
 * Restarting it forever turns one dead site into a spawn loop that competes with
 * the agents it was meant to unblock — which is the same resource failure, with
 * more processes. So revival is capped, and when the cap is reached the site is
 * left honestly not-ready with the reason recorded, which is the state a person
 * can actually act on.
 */
describe('a dead FastCGI worker is brought back', () => {
    /** The worker's spawn id for the site under test. */
    const WORKER = `${SITE_ID}-fcgi`;

    it('respawns the worker when the backend has gone', async () => {
        const spawn = fakeHostSpawn();
        let fcgiUp = true;
        const m = phpManager(
            async (req) => (req.port === FCGI_PORT ? fcgiUp : true),
            { hostSpawn: spawn },
        );

        await m.start('acme', SITE_ID);
        const before = spawn.started.filter((id) => id === WORKER).length;
        expect(before).toBe(1);

        // The worker dies the way it actually dies: the process is gone and the
        // port refuses. Caddy is untouched and still answers.
        fcgiUp = false;
        spawn.started.splice(spawn.started.indexOf(WORKER), 1);

        await m.refresh('acme');

        expect(
            spawn.started.filter((id) => id === WORKER).length,
            'the worker must be started again, not merely reported dead',
        ).toBe(1);
    });

    it('stops restarting a worker that will not stay up, instead of looping', async () => {
        const spawn = fakeHostSpawn();
        const m = phpManager(async (req) => req.port !== FCGI_PORT, { hostSpawn: spawn });

        await m.start('acme', SITE_ID).catch(() => {});
        const startsAfterBoot = spawn.started.filter((id) => id === WORKER).length;

        // Ten refreshes against a backend that never comes up.
        for (let i = 0; i < 10; i += 1) {
            spawn.started = spawn.started.filter((id) => id !== WORKER);
            await m.refresh('acme');
        }

        const attempts = spawn.started.filter((id) => id === WORKER).length + startsAfterBoot;
        expect(attempts, 'a flapping worker must not be respawned once per refresh forever')
            .toBeLessThanOrEqual(6);
    });

    it('POSITIVE CONTROL: a healthy worker is left alone', async () => {
        // Without this, "respawns when dead" would also pass for an
        // implementation that restarts the worker on every single refresh.
        const spawn = fakeHostSpawn();
        const m = phpManager(async () => true, { hostSpawn: spawn });

        await m.start('acme', SITE_ID);
        await m.refresh('acme');
        await m.refresh('acme');

        expect(spawn.started.filter((id) => id === WORKER).length).toBe(1);
    });
});

/**
 * A WORKER THAT IS NOT BROKEN IS NEVER LEFT DEAD (genie#664).
 *
 * `php-cgi` in FastCGI mode EXITS ON ITS OWN after `PHP_FCGI_MAX_REQUESTS`
 * requests — 500 unless something says otherwise. Measured against a real
 * `php-cgi`, started exactly the way Genie starts it: it served 500 requests,
 * exited with status 0, and refused the 501st. With `PHP_FCGI_MAX_REQUESTS=0` it
 * served 700 of 700 and was still running.
 *
 * One Laravel page load is dozens of FastCGI requests, and an agent testing its
 * work reloads constantly, so every PHP `.gen` site crossed 500 within minutes.
 * That is not a crash anyone can fix in the app: it is the worker's own recycling
 * policy, which exists for a supervisor that respawns it — and Genie's worker
 * has none, because it is a single `php-cgi -b` with no parent to restart it.
 *
 * Three things together left sites dead instead of briefly blinking:
 *
 *  1. **The limit itself.** Genie never set it, so the default 500 applied.
 *  2. **The revival cap was a LIFETIME count.** Five routine exits — five hundred
 *     requests each — and Genie stopped bringing the worker back for good, which
 *     is the flapping-install guard firing on a healthy worker.
 *  3. **An ADOPTED php site had no way back at all.** A Genie that restarts (every
 *     update) re-attaches the surviving processes but holds no recipe for the
 *     worker, and `resumeEnabledSites` skips anything already live — so after an
 *     update the worker a PREVIOUS Genie started (limit and all) was the last one
 *     that site would ever get.
 */
describe('a php-cgi worker is never left dead by its own request limit', () => {
    const WORKER = `${SITE_ID}-fcgi`;

    /** A hostSpawn that remembers each start's env, and whose processes are up
     *  until they are stopped or killed — optionally already running at boot. */
    function recordingHostSpawn(running: Array<{ siteId: string; port: number }> = []) {
        const spawns: Array<{ siteId: string; env: Record<string, string> }> = [];
        const up = new Set(running.map((r) => r.siteId));
        const log: string[] = [];
        return {
            spawns,
            up,
            log,
            start: async (i: { siteId: string; env: Record<string, string> }) => {
                spawns.push({ siteId: i.siteId, env: i.env });
                log.push(`start ${i.siteId}`);
                up.add(i.siteId);
                return { ok: true as const, pid: 4242 };
            },
            stop: async (id: string) => {
                log.push(`stop ${id}`);
                up.delete(id);
            },
            alive: async (id: string) => up.has(id),
            readLog: async () => '',
            running: async () => running.filter((r) => up.has(r.siteId)),
        };
    }

    it('starts the worker with PHP_FCGI_MAX_REQUESTS=0, so it does not exit after 500 requests', async () => {
        const spawn = recordingHostSpawn();
        const m = phpManager(async () => true, { hostSpawn: spawn });

        await m.start('acme', SITE_ID);

        const worker = spawn.spawns.find((s) => s.siteId === WORKER);
        expect(worker?.env.PHP_FCGI_MAX_REQUESTS).toBe('0');
        // The Caddy in front of it is not php-cgi and has no such limit: the
        // setting is the worker's, not blanket noise in every site's env.
        expect(spawn.spawns.find((s) => s.siteId === SITE_ID)?.env.PHP_FCGI_MAX_REQUESTS).toBeUndefined();
    });

    it('a REVIVED worker is started with the same setting', async () => {
        const spawn = recordingHostSpawn();
        const m = phpManager(async (req) => (req.port === FCGI_PORT ? spawn.up.has(WORKER) : true), {
            hostSpawn: spawn,
        });

        await m.start('acme', SITE_ID);
        spawn.up.delete(WORKER);
        await m.refresh('acme');

        const workers = spawn.spawns.filter((s) => s.siteId === WORKER);
        expect(workers).toHaveLength(2);
        expect(workers[1]?.env.PHP_FCGI_MAX_REQUESTS).toBe('0');
    });

    it('keeps bringing back a worker that comes back HEALTHY — the cap counts consecutive failures, not a lifetime', async () => {
        const spawn = recordingHostSpawn();
        const m = phpManager(async (req) => (req.port === FCGI_PORT ? spawn.up.has(WORKER) : true), {
            hostSpawn: spawn,
        });
        await m.start('acme', SITE_ID);

        // More exits than the flapping guard allows in a row. Each revival WORKS —
        // the worker comes back and the site answers — so none of them is the
        // broken install that guard exists for.
        for (let death = 1; death <= 8; death += 1) {
            spawn.up.delete(WORKER);
            await m.refresh('acme');
            expect(m.list('acme')[0]?.ready, `the site must be serving again after exit #${death}`).toBe(true);
        }
        expect(spawn.spawns.filter((s) => s.siteId === WORKER)).toHaveLength(9);
    });

    it('RESTARTS an adopted php site into one this Genie can bring back', async () => {
        // A previous Genie started this pair, and both survived its exit. Genie
        // cannot see the env that worker runs with — it may be carrying the 500
        // request limit — and holds no recipe to revive it. So it is replaced.
        const spawn = recordingHostSpawn([
            { siteId: SITE_ID, port: 6101 },
            { siteId: WORKER, port: 6102 },
        ]);
        const m = phpManager(async (req) => (req.port === FCGI_PORT ? spawn.up.has(WORKER) : true), {
            hostSpawn: spawn,
        });

        await m.adopt();

        // The old pair is stopped BEFORE the new one starts: they share spawn ids,
        // so the other order would stop the replacement.
        expect(spawn.log.indexOf(`stop ${WORKER}`)).toBeGreaterThanOrEqual(0);
        expect(spawn.log.indexOf(`stop ${WORKER}`)).toBeLessThan(spawn.log.indexOf(`start ${WORKER}`));
        expect(spawn.log.indexOf(`stop ${SITE_ID}`)).toBeLessThan(spawn.log.indexOf(`start ${SITE_ID}`));
        expect(spawn.spawns.find((s) => s.siteId === WORKER)?.env.PHP_FCGI_MAX_REQUESTS).toBe('0');
        expect(m.list('acme')[0]?.state).toBe('running');
        expect(m.list('acme')[0]?.ready).toBe(true);
        expect(m.genSites()[0]?.port).toBe(SITE_PORT);

        // …and it is now a site whose worker comes back.
        spawn.up.delete(WORKER);
        await m.refresh('acme');
        expect(spawn.spawns.filter((s) => s.siteId === WORKER)).toHaveLength(2);
        expect(m.list('acme')[0]?.ready).toBe(true);
    });

    it('RESTARTS an adopted php site whose worker did NOT survive, instead of leaving it answering 502', async () => {
        // Caddy outlived the last Genie; the worker did not. Adopting that pair as
        // it stands is a site that 502s with nothing able to bring it back.
        const spawn = recordingHostSpawn([{ siteId: SITE_ID, port: 6101 }]);
        const m = phpManager(async (req) => (req.port === FCGI_PORT ? spawn.up.has(WORKER) : true), {
            hostSpawn: spawn,
        });

        await m.adopt();

        expect(spawn.spawns.filter((s) => s.siteId === WORKER)).toHaveLength(1);
        expect(m.list('acme')[0]?.ready).toBe(true);
    });

    it('a start on an already-running php site keeps its way back', async () => {
        // A reconcile, or a second start, re-records the running site. That used to
        // drop the revive recipe — the same dead end as adoption, one call later.
        const spawn = recordingHostSpawn();
        const m = phpManager(async (req) => (req.port === FCGI_PORT ? spawn.up.has(WORKER) : true), {
            hostSpawn: spawn,
        });
        await m.start('acme', SITE_ID);
        await m.start('acme', SITE_ID);
        expect(spawn.spawns.filter((s) => s.siteId === WORKER), 'a running pair is not respawned').toHaveLength(1);

        spawn.up.delete(WORKER);
        await m.refresh('acme');
        expect(spawn.spawns.filter((s) => s.siteId === WORKER)).toHaveLength(2);
        expect(m.list('acme')[0]?.ready).toBe(true);
    });
});

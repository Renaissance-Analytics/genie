import { describe, expect, it } from 'vitest';
import { createDevSiteManager } from '../site-manager';
import {
    defaultGenNameFor,
    devSiteIdFor,
    devSiteReconfigureNeedsRestart,
    parseDevSites,
    parseDevSitesValue,
    sanitizeDevSitePatch,
} from '../sites-config';
import { devContainerNameFor } from '../argv';
import { CADDY_HTTPS_PORT } from '../caddyfile';
import type { DevSiteConfig, DevSites } from '../sites-config';
import type {
    ContainerRuntime,
    ContainerSpec,
    ContainerSummary,
    PortMapping,
    RuntimeDetection,
} from '../container-runtime';

/**
 * The DEV SITE MANAGER, sandbox-serve model — the piece that turns "this
 * workspace defines a site" into a user command running against the LIVE repo
 * inside the ONE workspace sandbox, fronted by that sandbox's Caddy over https,
 * and into the ONE row the Genie Browser already routes.
 *
 * What is proven here:
 *   1. A site is the user's `command`, run DETACHED in the sandbox, in the repo's
 *      LIVE-mounted dir — no copy, no build, no per-site container.
 *   2. The sandbox's Caddy is pointed at each site (host → app loopback port), so
 *      ports are masked and https is forced.
 *   3. A running site emits an `EnabledGenSite` whose target is the sandbox's
 *      shared published Caddy port, distinguished by TLS SNI = its `.gen` name —
 *      exactly what the local carrier already dials.
 */

// --- a fake runtime ---------------------------------------------------------

const DOCKER_OK: RuntimeDetection = { kind: 'docker', version: '29.6.1', probes: [] };

/** The host port the fake publishes the sandbox's Caddy port on. */
const CADDY_HOST_PORT = 49_800;

interface Fake extends ContainerRuntime {
    readonly ran: ContainerSpec[];
    readonly removed: string[];
    /** Every `exec` the manager issued (start / caddy / stop / probe-alive). */
    readonly execs: Array<{ id: string; argv: string[]; env?: Record<string, string> }>;
    readonly containers: Map<string, ContainerSummary>;
    readonly ports: Map<string, PortMapping[]>;
}

function fakeRuntime(opts: { detection?: RuntimeDetection; existing?: ContainerSummary[] } = {}): Fake {
    const ran: ContainerSpec[] = [];
    const removed: string[] = [];
    const execs: Array<{ id: string; argv: string[]; env?: Record<string, string> }> = [];
    const containers = new Map<string, ContainerSummary>(
        (opts.existing ?? []).map((c) => [c.name, c]),
    );
    const ports = new Map<string, PortMapping[]>();
    // Seed port mappings for any pre-existing container (an adopted sandbox).
    for (const c of containers.values()) {
        ports.set(c.id, [
            { container: CADDY_HTTPS_PORT, protocol: 'tcp', hostIp: '127.0.0.1', hostPort: CADDY_HOST_PORT },
        ]);
    }

    return {
        kind: 'docker',
        ran,
        removed,
        execs,
        containers,
        ports,
        async detect() {
            return opts.detection ?? DOCKER_OK;
        },
        async networkEnsure(workspaceId) {
            return { name: `genie-ws-${workspaceId}`, created: false };
        },
        async networkRemove() {},
        async networkEnsureNamed(name) {
            return { name, created: false };
        },
        async networkConnect() {},
        async networkDisconnect() {},
        async volumeRemove() {},
        async imageExists() {
            return true;
        },
        async pullImage(image) {
            return { ok: true, image };
        },
        async buildImage(spec) {
            return { ok: true, image: spec.tag };
        },
        async runContainer(spec) {
            ran.push(spec);
            const id = `id-${spec.name}`;
            containers.set(spec.name, {
                id,
                name: spec.name,
                image: spec.image,
                state: 'running',
                ...(spec.workspaceId === null ? {} : { workspaceId: spec.workspaceId }),
            });
            ports.set(
                id,
                (spec.ports ?? []).map((p) => ({
                    container: p.container,
                    protocol: 'tcp' as const,
                    hostIp: p.hostIp ?? '127.0.0.1',
                    hostPort: p.host ?? CADDY_HOST_PORT,
                })),
            );
            return { id, name: spec.name };
        },
        async start() {},
        async stop() {},
        async remove(id) {
            removed.push(id);
            for (const [name, c] of containers) if (c.id === id) containers.delete(name);
        },
        async exec(id, argv, opts) {
            execs.push({ id, argv, ...(opts?.env ? { env: opts.env } : {}) });
            // `siteProcessAlive` reads a pidfile + kill -0; answer "alive" so the
            // re-entrant-start guard treats a live site as adopt-in-place.
            return { code: 0, stdout: 'listening\n', stderr: '' };
        },
        async logs() {
            return '';
        },
        followLogs() {
            return { stop() {}, exited: Promise.resolve(0) };
        },
        async psServices() {
            return [];
        },
        async ps(workspaceId) {
            return [...containers.values()].filter((c) => !workspaceId || c.workspaceId === workspaceId);
        },
        async portMappings(id) {
            return ports.get(id) ?? [];
        },
    };
}

// --- fixtures ---------------------------------------------------------------

const WS = { id: 'acme', path: '/work/acme', label: 'acme' };
const SANDBOX = devContainerNameFor('acme');
const SANDBOX_ID = `id-${SANDBOX}`;

const SITE: DevSiteConfig = {
    name: 'web',
    genName: 'web.acme.gen',
    repo: 'app',
    runMode: 'explicit',
    // The whole model: the user's own startup argv, run against the live source.
    command: ['npm', 'run', 'dev'],
    port: 5173,
    kind: 'http',
    enabled: true,
};

const SITE_ID = devSiteIdFor('acme', 'web');

function manager(
    runtime: ContainerRuntime,
    sites: DevSites = { [SITE_ID]: SITE },
    extra: Partial<Parameters<typeof createDevSiteManager>[0]> = {},
) {
    return createDevSiteManager({
        resolveRuntime: async () => ({ runtime, detection: await runtime.detect() }),
        listWorkspaces: () => [WS],
        devSitesFor: () => sites,
        platform: 'linux',
        image: 'genie-dev-base:1',
        hostIds: null,
        // Deterministic: the real one opens a TLS socket to Caddy.
        probeReady: async () => true,
        ...extra,
    });
}

/**
 * A Genie-owned PHP install, shaped as `scanToolchain` reports one.
 *
 * The manager never scans the machine — it asks the injected resolver which
 * version this site runs on (genie#207) — so this is only ever the answer a test
 * hands back. `exe` is the primary binary; the worker spawns `php-cgi` beside it.
 */
const PHP_83 = {
    tool: 'php' as const,
    version: '8.3.33',
    dir: '/gd/toolchain/php/8.3.33',
    exe: '/gd/toolchain/php/8.3.33/bin/php',
    source: 'genie' as const,
    removable: true,
};

const PHP_83_CGI = '/gd/toolchain/php/8.3.33/bin/php-cgi';

/** The engine resolver the host layer injects, answering with {@link PHP_83}. */
const resolvesPhp83 = async () => ({
    ok: true as const,
    version: PHP_83.version,
    install: PHP_83,
    exe: PHP_83_CGI,
});

/** The `sh -c` script of the exec that STARTED a site (positional argv carries
 *  `genie-site <cwd> <command…>`). */
function startExec(runtime: Fake) {
    return runtime.execs.find((e) => e.argv[3] === 'genie-site');
}

/** Decode the Caddyfile from the most recent `applyCaddyConfig` exec. */
function lastCaddyfile(runtime: Fake): string {
    const caddy = [...runtime.execs].reverse().find((e) => (e.argv[2] ?? '').includes('caddy reload'));
    const script = caddy?.argv[2] ?? '';
    const m = script.match(/printf %s '([^']+)' \| base64 -d/);
    return m ? Buffer.from(m[1]!, 'base64').toString('utf8') : '';
}

// --- the stored model -------------------------------------------------------

describe('sites-config', () => {
    it('scopes a site id to its workspace, so two workspaces can both have a "web"', () => {
        expect(devSiteIdFor('acme', 'web')).not.toBe(devSiteIdFor('other', 'web'));
        expect(devSiteIdFor('acme', 'web')).toBe(devSiteIdFor('acme', 'web'));
    });

    it('derives a per-workspace `.gen` name so sites cannot collide across workspaces', () => {
        expect(defaultGenNameFor('acme', 'web')).toBe('web.acme.gen');
        expect(defaultGenNameFor('', 'web')).toBe('web.gen');
    });

    it('refuses a name that is not a DNS label — it becomes part of an origin', () => {
        expect(sanitizeDevSitePatch({ name: 'my web!' }).name).toBeUndefined();
        expect(sanitizeDevSitePatch({ name: 'web-2' }).name).toBe('web-2');
    });

    it('refuses a `.gen` name that is not one', () => {
        expect(sanitizeDevSitePatch({ genName: 'web.example.com' }).genName).toBeUndefined();
        expect(sanitizeDevSitePatch({ genName: 'WEB.acme.GEN' }).genName).toBe('web.acme.gen');
    });

    it('keeps a command as literal argv and drops anything that is not', () => {
        expect(sanitizeDevSitePatch({ command: ['npm', 'run', 'dev'] }).command).toEqual([
            'npm',
            'run',
            'dev',
        ]);
        expect(sanitizeDevSitePatch({ command: 'npm run dev' as never }).command).toBeUndefined();
        expect(sanitizeDevSitePatch({ command: ['a\0b'] }).command).toBeUndefined();
    });

    it('clamps the port and drops env entirely — env is NEVER persisted (genie #168)', () => {
        expect(sanitizeDevSitePatch({ port: 0 }).port).toBeUndefined();
        expect(sanitizeDevSitePatch({ port: 70_000 }).port).toBeUndefined();
        expect(sanitizeDevSitePatch({ port: 5173 }).port).toBe(5173);
        // env is dropped WHOLE (not filtered) — it belongs in the repo .env, never
        // the tracked project.json manifest.
        expect(sanitizeDevSitePatch({ env: { GOOD: 'y' } }).env).toBeUndefined();
    });

    it('reads a corrupt blob as "no sites" rather than throwing', () => {
        expect(parseDevSites('not json')).toEqual({});
        expect(parseDevSites(null)).toEqual({});
        expect(parseDevSites('[]')).toEqual({});
    });

    // The `sites` map does not only come from OUR blob: for an `.agi` workspace the
    // envelope's project.json is the source of truth, and that file is git-tracked
    // — it arrives from a clone, a merge, a hand edit, another machine. Read raw it
    // is unsanitized input that becomes a spawned command and a minted certificate,
    // AND a shape we cannot read reads as "this workspace has no sites", which then
    // overwrites the local mirror and loses registrations while the servers keep
    // running (genie#190). Hence a VALUE parser with a third answer: null = "that
    // is not a sites map", distinct from `{}` = "no sites".
    describe('parseDevSitesValue — a sites map from OUTSIDE our own blob', () => {
        it('says null for anything that is not a sites map — never "no sites"', () => {
            expect(parseDevSitesValue(undefined)).toBeNull();
            expect(parseDevSitesValue(null)).toBeNull();
            expect(parseDevSitesValue('web.gen')).toBeNull();
            expect(parseDevSitesValue([{ name: 'web' }])).toBeNull();
            expect(parseDevSitesValue(7)).toBeNull();
        });

        it('says {} for an explicitly EMPTY map — the user removed their last site', () => {
            expect(parseDevSitesValue({})).toEqual({});
        });

        it('sanitizes every row it keeps, exactly like our own blob', () => {
            const parsed = parseDevSitesValue({
                ok: { name: 'web', genName: 'web.acme.gen', repo: 'app', runMode: 'host', kind: 'http', enabled: true },
                // Not a `.gen` name: unroutable, and a certificate must never be
                // minted for it.
                bad: { name: 'evil', genName: 'evil.example.com', kind: 'http', enabled: true },
                // A repo name that climbs out of the workspace mount.
                climb: { name: 'up', genName: 'up.acme.gen', repo: '../../etc', kind: 'http', enabled: true },
            });
            expect(Object.keys(parsed ?? {})).toEqual(['ok', 'climb']);
            expect(parsed?.climb?.repo).toBe('');
        });
    });
});

// --- running a site ---------------------------------------------------------

describe('start', () => {
    it('runs the user command DETACHED in the sandbox, in the repo LIVE dir', async () => {
        const runtime = fakeRuntime();
        const status = await manager(runtime).start('acme', SITE_ID);

        expect(status.state).toBe('running');
        // Exactly one container ran: the WORKSPACE SANDBOX. No per-site container.
        expect(runtime.ran).toHaveLength(1);
        expect(runtime.ran[0]?.name).toBe(SANDBOX);
        // The site is a process exec'd INTO that sandbox…
        const start = startExec(runtime);
        expect(start?.id).toBe(SANDBOX_ID);
        // …detached, keyed by the site id, in the repo's LIVE-mounted dir, with the
        // command riding as POSITIONAL argv (never spliced into the shell).
        expect(start?.argv[2]).toMatch(/setsid/);
        expect(start?.argv[2]).toContain(`${SITE_ID}.pid`);
        expect(start?.argv.slice(3)).toEqual([
            'genie-site',
            '/workspace/repos/app',
            'npm',
            'run',
            'dev',
        ]);
        // The site is told how to reach a HOST manageProcess service — its own
        // localhost is the sandbox, not the host (#130).
        expect(start?.env?.GENIE_HOST_GATEWAY).toBe('host.docker.internal');
    });

    it('serves the LIVE workspace — the sandbox bind-mounts it, nothing is copied', async () => {
        const runtime = fakeRuntime();
        await manager(runtime).start('acme', SITE_ID);
        const sandbox = runtime.ran[0];
        // The whole workspace, bind-mounted live — no build volume, no copy.
        expect(sandbox?.mounts).toEqual([{ source: '/work/acme', target: '/workspace' }]);
        expect(sandbox?.volumes).toBeUndefined();
    });

    it('points the sandbox Caddy at the site (host → the app loopback port)', async () => {
        const runtime = fakeRuntime();
        await manager(runtime).start('acme', SITE_ID);
        const cf = lastCaddyfile(runtime);
        expect(cf).toContain(`web.acme.gen:${CADDY_HTTPS_PORT} {`);
        expect(cf).toContain('reverse_proxy 127.0.0.1:5173');
        expect(cf).toContain('tls internal');
    });

    it('reports the sandbox Caddy port and the https origin', async () => {
        const runtime = fakeRuntime();
        const status = await manager(runtime).start('acme', SITE_ID);
        expect(status.hostPort).toBe(CADDY_HOST_PORT);
        expect(status.origin).toBe('https://web.acme.gen');
    });

    /**
     * genie#195 — the published `hostPort` of a CONTAINER site is the sandbox's
     * Caddy, which speaks TLS and routes by SNI. Reporting an
     * `http://127.0.0.1:<port>` "local origin" beside it sends whoever curls it
     * into `Client sent an HTTP request to an HTTPS server`, which reads like the
     * app is broken when it is the LABEL that is wrong. So the local reach a caller
     * is handed has to be the form that actually answers.
     */
    it('reports a LOCAL reach that actually works: https + SNI, not an http loopback URL (genie#195)', async () => {
        const runtime = fakeRuntime();
        const status = await manager(runtime).start('acme', SITE_ID);

        expect(status.localOrigin).toBe(`https://web.acme.gen:${CADDY_HOST_PORT}`);
        // …and the exact command, because `https://web.acme.gen:<port>` does not
        // resolve on this machine either — the SNI name has to be pinned to loopback.
        expect(status.localCurl).toBe(
            `curl -sk --resolve web.acme.gen:${CADDY_HOST_PORT}:127.0.0.1 https://web.acme.gen:${CADDY_HOST_PORT}/`,
        );
        // The form that produced the bug report is never handed out.
        expect(status.localOrigin).not.toContain(`http://127.0.0.1:${CADDY_HOST_PORT}`);
    });

    it('reports a site whose port never answered through Caddy as running-but-not-ready', async () => {
        const runtime = fakeRuntime();
        const status = await manager(runtime, undefined, { probeReady: async () => false }).start(
            'acme',
            SITE_ID,
        );
        expect(status.state).toBe('running');
        expect(status.ready).toBe(false);
    });

    it('is a FAILED STATUS, never a throw, when there is no container runtime', async () => {
        const runtime = fakeRuntime({
            detection: {
                kind: 'none',
                reason: 'not-installed',
                installHint: 'Install Docker Desktop …',
                probes: [],
            },
        });
        const status = await createDevSiteManager({
            resolveRuntime: async () => ({ runtime: null, detection: await runtime.detect() }),
            listWorkspaces: () => [WS],
            devSitesFor: () => ({ [SITE_ID]: SITE }),
            platform: 'linux',
        }).start('acme', SITE_ID);

        expect(status.state).toBe('failed');
        expect(status.error).toMatch(/Install Docker Desktop/);
    });

    it('is a failed status — and spawns nothing — for a site with no command', async () => {
        const runtime = fakeRuntime();
        const sites: DevSites = { [SITE_ID]: { ...SITE, command: undefined } };
        const status = await manager(runtime, sites).start('acme', SITE_ID);
        expect(status.state).toBe('failed');
        expect(status.error).toMatch(/command/i);
        expect(startExec(runtime)).toBeUndefined();
    });

    it('falls back to the legacy `serve` argv for a pre-rework site', async () => {
        const runtime = fakeRuntime();
        const sites: DevSites = {
            [SITE_ID]: { ...SITE, command: undefined, serve: ['./bin/server'] },
        };
        const status = await manager(runtime, sites).start('acme', SITE_ID);
        expect(status.state).toBe('running');
        expect(startExec(runtime)?.argv.slice(5)).toEqual(['./bin/server']);
    });

    it('is a failed status for a site with no port', async () => {
        const runtime = fakeRuntime();
        const sites: DevSites = { [SITE_ID]: { ...SITE, port: undefined } };
        const status = await manager(runtime, sites).start('acme', SITE_ID);
        expect(status.state).toBe('failed');
        expect(status.error).toMatch(/port/i);
        expect(startExec(runtime)).toBeUndefined();
    });

    it('is a failed status for an unknown site id', async () => {
        const status = await manager(fakeRuntime()).start('acme', 'nope');
        expect(status.state).toBe('failed');
        expect(status.error).toMatch(/not configured/i);
    });
});

// --- THE SALVAGE SEAM -------------------------------------------------------

describe('genSites — the row the Genie Browser already routes', () => {
    it('emits the shared Caddy port, SNI = the .gen name, over https', async () => {
        const runtime = fakeRuntime();
        const m = manager(runtime);
        await m.start('acme', SITE_ID);

        expect(m.genSites()).toEqual([
            {
                workspaceId: 'acme',
                genName: 'web.acme.gen',
                siteId: SITE_ID,
                // SNI = Host = the `.gen` name so Caddy routes by SNI.
                hostname: 'web.acme.gen',
                scheme: 'https',
                port: CADDY_HOST_PORT,
                loopback: '127.0.0.1',
            },
        ]);
    });

    it('rewrites the upstream Host at CADDY for a framework that checks it', async () => {
        // The SNI/Host the carrier sends stays the `.gen` name (so Caddy routes);
        // the upstream Host rewrite is a `header_up` in the Caddyfile.
        const runtime = fakeRuntime();
        const sites: DevSites = { [SITE_ID]: { ...SITE, upstreamHost: 'localhost' } };
        const m = manager(runtime, sites);
        await m.start('acme', SITE_ID);
        // The browser-facing SNI is unchanged…
        expect(m.genSites()[0]?.hostname).toBe('web.acme.gen');
        // …and Caddy is told to send the app `Host: localhost`.
        expect(lastCaddyfile(runtime)).toContain('header_up Host localhost');
    });

    it('advertises NOTHING for a site that is not running', async () => {
        const m = manager(fakeRuntime());
        expect(m.genSites()).toEqual([]);
    });

    it('advertises nothing for a non-HTTP surface', async () => {
        const runtime = fakeRuntime();
        const sites: DevSites = { [SITE_ID]: { ...SITE, kind: 'tcp' } };
        const m = manager(runtime, sites);
        const status = await m.start('acme', SITE_ID);
        expect(status.state).toBe('running');
        expect(m.genSites()).toEqual([]);
        // A tcp site gets no Caddy vhost (secure web only).
        expect(lastCaddyfile(runtime)).not.toContain('web.acme.gen');
    });
});

// --- lifecycle --------------------------------------------------------------

describe('stop / list / logs', () => {
    it('stops the site PROCESS and drops its Caddy vhost — but never the sandbox', async () => {
        const runtime = fakeRuntime();
        const m = manager(runtime);
        await m.start('acme', SITE_ID);
        await m.stop(SITE_ID);

        // The site's process group was killed (by its pidfile)…
        const stopExec = runtime.execs.find((e) => (e.argv[2] ?? '').includes('kill -TERM'));
        expect(stopExec?.argv[2]).toContain(`${SITE_ID}.pid`);
        expect(stopExec?.id).toBe(SANDBOX_ID);
        // …the sandbox container is NEVER removed (it holds the toolchain + others)…
        expect(runtime.removed).not.toContain(SANDBOX_ID);
        // …and Caddy no longer serves the vhost.
        expect(lastCaddyfile(runtime)).not.toContain('reverse_proxy 127.0.0.1:5173');
        expect(m.genSites()).toEqual([]);
        expect(m.list('acme')[0]?.state).toBe('stopped');
    });

    it('lists every CONFIGURED site, running or not', async () => {
        const rows = manager(fakeRuntime()).list('acme');
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            siteId: SITE_ID,
            name: 'web',
            genName: 'web.acme.gen',
            state: 'stopped',
            enabled: true,
            command: ['npm', 'run', 'dev'],
        });
    });

    it('remembers WHY a site failed, instead of reporting it as merely off', async () => {
        const runtime = fakeRuntime();
        const sites: DevSites = { [SITE_ID]: { ...SITE, port: undefined } };
        const m = manager(runtime, sites);
        await m.start('acme', SITE_ID);
        expect(m.list('acme')[0]).toMatchObject({ state: 'failed' });
        expect(m.list('acme')[0]?.error).toMatch(/port/i);
    });

    it('returns the site process log for a running site', async () => {
        const runtime = fakeRuntime();
        const m = manager(runtime);
        await m.start('acme', SITE_ID);
        expect(await m.logs(SITE_ID)).toContain('listening');
    });

    it('says so rather than throwing when logs are asked for a stopped site', async () => {
        expect(await manager(fakeRuntime()).logs(SITE_ID)).toMatch(/not running/i);
    });
});

describe('refresh — a CONTAINER site is re-asked THROUGH Caddy (genie#305)', () => {
    it('re-probes over TLS+SNI, where a gateway status still means "the app has not bound"', async () => {
        // The container half of the live-readiness fix. This port is the SANDBOX'S
        // Caddy, so the probe has to be the SNI one — the same one the start used —
        // and NOT the plain-http probe a host-native site gets. Sending it down the
        // host path would both fail the TLS handshake and lose the 502 rejection
        // that is correct for a proxy port.
        const runtime = fakeRuntime();
        const probes: Array<{ port: number; kind: string; servername?: string }> = [];
        let appUp = true;
        const m = manager(runtime, { [SITE_ID]: SITE }, {
            probeReady: async (req) => {
                probes.push(req);
                return appUp;
            },
        });
        await m.start('acme', SITE_ID);
        expect(m.list('acme')[0]?.ready).toBe(true);

        probes.length = 0;
        appUp = false;
        await m.refresh('acme');

        expect(probes).toHaveLength(1);
        expect(probes[0]?.kind).toBe('http');
        expect(probes[0]?.port).toBe(CADDY_HOST_PORT);
        expect(probes[0]?.servername).toBe('web.acme.gen');
        expect(m.list('acme')[0]?.ready).toBe(false);
    });
});

describe('reconcile', () => {
    it('starts every ENABLED site and leaves disabled ones alone', async () => {
        const runtime = fakeRuntime();
        const other = devSiteIdFor('acme', 'api');
        const sites: DevSites = {
            [SITE_ID]: SITE,
            [other]: { ...SITE, name: 'api', genName: 'api.acme.gen', port: 8000, enabled: false },
        };
        const m = manager(runtime, sites);
        await m.reconcile();
        expect(m.genSites().map((g) => g.genName)).toEqual(['web.acme.gen']);
    });

    it('stops a site that is live but no longer enabled', async () => {
        const runtime = fakeRuntime();
        const sites: DevSites = { [SITE_ID]: { ...SITE } };
        const m = manager(runtime, sites);
        await m.start('acme', SITE_ID);
        sites[SITE_ID] = { ...SITE, enabled: false };
        await m.reconcile();
        expect(m.genSites()).toEqual([]);
    });
});

// --- adopt ------------------------------------------------------------------

describe('adopt — re-attach to processes still running after a Genie restart', () => {
    it('re-learns a site whose process is alive in an already-running sandbox', async () => {
        const runtime = fakeRuntime({
            existing: [
                {
                    id: SANDBOX_ID,
                    name: SANDBOX,
                    image: 'genie-dev-base:1',
                    state: 'running',
                    workspaceId: 'acme',
                },
            ],
        });
        const m = manager(runtime);
        await m.adopt();
        // No sandbox was created (it was adopted), and the live site is advertised.
        expect(runtime.ran).toHaveLength(0);
        expect(m.genSites().map((g) => g.siteId)).toEqual([SITE_ID]);
    });

    it('reports an adopted SLOW-but-healthy site as ready — the probe budget clears real latency', async () => {
        // A single-threaded dev server (`php artisan serve`) re-bootstraps per
        // request: ~2.5s every response. An adopted site is serving 200s the whole
        // time — but if the adopt probe's budget is shorter than one real request,
        // it reads not-ready forever (the `ready:false` false-negative). Model the
        // probe as ready only when its budget covers real per-request latency.
        const runtime = fakeRuntime({
            existing: [
                {
                    id: SANDBOX_ID,
                    name: SANDBOX,
                    image: 'genie-dev-base:1',
                    state: 'running',
                    workspaceId: 'acme',
                },
            ],
        });
        const m = manager(runtime, { [SITE_ID]: SITE }, {
            probeReady: async ({ timeoutMs }) => timeoutMs >= 2_500,
        });
        await m.adopt();
        expect(m.list('acme')[0]?.ready).toBe(true);
    });

    // genie#190 — the HOST-NATIVE half of the same promise. A host-native dev
    // server is spawned to outlive the call that started it, so it outlives Genie
    // too; unadopted it keeps serving on its port while `genSites()` does not know
    // it exists, which is the orphan the container path already guards against.
    // And it must not depend on Docker: a host-native site's whole point is that
    // there is no container, so adopt used to return before it ever looked.
    it('re-attaches a HOST-NATIVE site still serving after the restart — with NO container runtime at all', async () => {
        const runtime = fakeRuntime({ detection: { kind: 'none', probes: [] } });
        const hostSpawn = {
            start: async () => ({ ok: true as const, pid: 4242 }),
            stop: async () => {},
            alive: async () => true,
            readLog: async () => '',
            // The persisted registry: this run survived, on this port.
            running: async () => [{ siteId: SITE_ID, port: 5321 }],
        };
        const sites: DevSites = {
            [SITE_ID]: {
                name: 'web',
                genName: 'web.acme.gen',
                repo: 'app',
                runMode: 'host',
                command: ['php', 'artisan', 'serve'],
                port: 8001,
                kind: 'http',
                enabled: true,
            },
        };
        const m = manager(runtime, sites, {
            resolveRuntime: async () => ({ runtime: null, detection: { kind: 'none', probes: [] } }),
            hostSpawn,
            probeReady: async () => true,
        });
        await m.adopt();

        expect(m.list('acme')[0]?.state).toBe('running');
        // Routed at the port it is ACTUALLY serving on — not the stored 8001, and
        // not a fresh one from a needless restart.
        expect(m.genSites()).toEqual([
            {
                workspaceId: 'acme',
                genName: 'web.acme.gen',
                siteId: SITE_ID,
                hostname: 'web.acme.gen',
                scheme: 'http',
                port: 5321,
                loopback: '127.0.0.1',
            },
        ]);
    });

    it('leaves a host-native site whose dev server did NOT survive reported as stopped', async () => {
        const runtime = fakeRuntime({ detection: { kind: 'none', probes: [] } });
        const hostSpawn = {
            start: async () => ({ ok: true as const, pid: 4242 }),
            stop: async () => {},
            alive: async () => false,
            readLog: async () => '',
            running: async () => [],
        };
        const sites: DevSites = {
            [SITE_ID]: {
                name: 'web',
                genName: 'web.acme.gen',
                repo: 'app',
                runMode: 'host',
                command: ['php', 'artisan', 'serve'],
                port: 8001,
                kind: 'http',
                enabled: true,
            },
        };
        const m = manager(runtime, sites, {
            resolveRuntime: async () => ({ runtime: null, detection: { kind: 'none', probes: [] } }),
            hostSpawn,
            probeReady: async () => true,
        });
        await m.adopt();
        expect(m.list('acme')[0]?.state).toBe('stopped');
        expect(m.genSites()).toEqual([]);
    });
});

// --- reconfigure ------------------------------------------------------------

describe('devSiteReconfigureNeedsRestart', () => {
    it('is true when a command / port / routing field changed', () => {
        expect(devSiteReconfigureNeedsRestart(SITE, { ...SITE, port: 9000 })).toBe(true);
        expect(devSiteReconfigureNeedsRestart(SITE, { ...SITE, command: ['./other'] })).toBe(true);
        expect(devSiteReconfigureNeedsRestart(SITE, { ...SITE, genName: 'web.new.gen' })).toBe(true);
    });

    it('is false for a cosmetic-only change — nothing the process depends on moved', () => {
        expect(devSiteReconfigureNeedsRestart(SITE, { ...SITE, enabled: !SITE.enabled })).toBe(false);
        expect(devSiteReconfigureNeedsRestart(SITE, { ...SITE })).toBe(false);
        // env is not persisted (genie #168), so an env change is not a reconfigure trigger.
        expect(devSiteReconfigureNeedsRestart(SITE, { ...SITE, env: { X: '1' } })).toBe(false);
    });
});

describe('reconfigure', () => {
    it('restarts a RUNNING site when a restart-requiring field changed', async () => {
        const runtime = fakeRuntime();
        const sites: DevSites = { [SITE_ID]: { ...SITE } };
        const m = manager(runtime, sites);
        await m.start('acme', SITE_ID);

        sites[SITE_ID] = { ...SITE, port: 9000 };
        const status = await m.reconfigure('acme', SITE_ID, {
            previousSiteId: SITE_ID,
            restart: true,
        });

        expect(status.state).toBe('running');
        // Caddy now proxies the new app port.
        expect(lastCaddyfile(runtime)).toContain('reverse_proxy 127.0.0.1:9000');
    });

    it('leaves a running site EXACTLY as it is when nothing that matters changed', async () => {
        const runtime = fakeRuntime();
        const m = manager(runtime);
        await m.start('acme', SITE_ID);
        const execsBefore = runtime.execs.length;

        const status = await m.reconfigure('acme', SITE_ID, {
            previousSiteId: SITE_ID,
            restart: false,
        });

        expect(status.state).toBe('running');
        // Nothing re-run: no new process started, no Caddy reapplied.
        expect(runtime.execs.length).toBe(execsBefore);
    });

    it('does NOT start a STOPPED site — an edit is not a start', async () => {
        const runtime = fakeRuntime();
        const m = manager(runtime);
        const status = await m.reconfigure('acme', SITE_ID, {
            previousSiteId: SITE_ID,
            restart: false,
        });
        expect(status.state).toBe('stopped');
        expect(startExec(runtime)).toBeUndefined();
    });

    it('moves a running site onto its new `.gen` when the name changed', async () => {
        const runtime = fakeRuntime();
        const NEW_ID = devSiteIdFor('acme', 'web2');
        const sites: DevSites = { [SITE_ID]: { ...SITE } };
        const m = manager(runtime, sites);
        await m.start('acme', SITE_ID);

        delete sites[SITE_ID];
        sites[NEW_ID] = { ...SITE, name: 'web2', genName: 'web2.acme.gen' };
        const status = await m.reconfigure('acme', NEW_ID, {
            previousSiteId: SITE_ID,
            restart: true,
        });

        expect(status.state).toBe('running');
        expect(status.genName).toBe('web2.acme.gen');
        expect(m.genSites().map((g) => g.siteId)).toEqual([NEW_ID]);
    });
});

// --- observable startup (Gap 2) ---------------------------------------------

describe('startup progress', () => {
    it('emits pulling → starting → ready as a start proceeds', async () => {
        const runtime = fakeRuntime();
        const phases: string[] = [];
        const m = manager(runtime, undefined, {
            onProgress: (p) => phases.push(p.phase),
        });
        await m.start('acme', SITE_ID);
        expect(phases[0]).toBe('pulling');
        expect(phases).toContain('starting');
        expect(phases.at(-1)).toBe('ready');
        expect(phases.indexOf('pulling')).toBeLessThan(phases.indexOf('starting'));
    });

    it('ends a failed start on a `failed` phase carrying the reason', async () => {
        const runtime = fakeRuntime();
        const events: Array<{ phase: string; error?: string }> = [];
        const sites: DevSites = { [SITE_ID]: { ...SITE, port: undefined } };
        const m = manager(runtime, sites, {
            onProgress: (p) => events.push({ phase: p.phase, error: p.error }),
        });
        await m.start('acme', SITE_ID);
        const last = events.at(-1);
        expect(last?.phase).toBe('failed');
        expect(last?.error).toMatch(/port/i);
    });

    it('surfaces the in-flight phase on `list` for a panel opened mid-start', async () => {
        const runtime = fakeRuntime();
        let phaseFromList: string | undefined;
        const m = manager(runtime, undefined, {
            onProgress: (p) => {
                if (p.phase === 'starting' && phaseFromList === undefined) {
                    phaseFromList = m.list('acme')[0]?.phase;
                }
            },
        });
        await m.start('acme', SITE_ID);
        expect(phaseFromList).toBe('starting');
    });
});

// --- P3: the services a site connects to ------------------------------------

describe('service env injection (#234 P3)', () => {
    it('injects the workspace service env into the site PROCESS', async () => {
        const runtime = fakeRuntime();
        await manager(runtime, undefined, {
            serviceEnvFor: async () => ({ DATABASE_URL: 'postgresql://ws:pw@genie-svc-postgres-16:5432/ws' }),
        }).start('acme', SITE_ID);
        expect(startExec(runtime)?.env?.DATABASE_URL).toBe(
            'postgresql://ws:pw@genie-svc-postgres-16:5432/ws',
        );
    });

    it('lets the workspace SERVICE env win over a colliding site env', async () => {
        const runtime = fakeRuntime();
        await manager(
            runtime,
            { [SITE_ID]: { ...SITE, env: { DB_HOST: '127.0.0.1' } } },
            { serviceEnvFor: async () => ({ DB_HOST: 'genie-svc-postgres-17' }) },
        ).start('acme', SITE_ID);
        expect(startExec(runtime)?.env?.DB_HOST).toBe('genie-svc-postgres-17');
    });

    it('starts the site anyway when the services cannot be brought up', async () => {
        const runtime = fakeRuntime();
        const status = await manager(runtime, undefined, {
            serviceEnvFor: async () => {
                throw new Error('engine exploded');
            },
        }).start('acme', SITE_ID);
        expect(status.state).toBe('running');
    });

    it('carries only the host-gateway by default — no injected SERVICE env for a plain site', async () => {
        const runtime = fakeRuntime();
        await manager(runtime).start('acme', SITE_ID);
        // The host-gateway is ALWAYS present (#130); a plain site with no
        // manageService still carries no DB_HOST/DATABASE_URL etc.
        expect(startExec(runtime)?.env).toEqual({ GENIE_HOST_GATEWAY: 'host.docker.internal' });
    });

    /**
     * REGRESSION — genie #125.
     *
     * A site created with a custom `image` + an explicit legacy `serve` (and NO
     * `command`), `runMode: 'explicit'` — the FrankenPHP-on-managed-Postgres shape
     * from the bug report. `image` is a pre-rework per-site-container concept; in
     * the sandbox-serve model there is no per-site container, so this must route
     * through the SAME sandbox path every other site does:
     *
     *   (a) it runs in the ONE workspace sandbox (the custom image spawns NO
     *       second container), as the migrated dev command (`frankenphp` is not in
     *       the sandbox — `sandboxCommandFor` rewrites it to `php artisan serve`);
     *   (b) its start receives the workspace SERVICE env (so a managed-Postgres app
     *       gets `DB_HOST=genie-svc-…`, not an empty value that falls back to
     *       127.0.0.1:5432); and
     *   (c) its reported `hostPort` is the sandbox's published Caddy port — the one
     *       door every `.gen` is reached through — never a per-site/IDE port.
     *
     * The bug report described (b)/(c) failing (serve ran env-less in the dev
     * container, `hostPort` pointed at 8443); this pins the sandbox-serve model's
     * correct behaviour so that path can never regress to it.
     */
    it('routes a custom-image + explicit-serve site through the sandbox WITH service env and the Caddy port', async () => {
        const runtime = fakeRuntime();
        const sites: DevSites = {
            [SITE_ID]: {
                name: 'web',
                genName: 'web.acme.gen',
                repo: 'app',
                runMode: 'explicit',
                // A custom runtime image (FrankenPHP + pdo_pgsql) and the exact
                // legacy serve from the report — NOT a `command`.
                image: 'ghcr.io/acme/frankenphp-pg:latest',
                serve: ['frankenphp', 'php-server', '--listen', '0.0.0.0:8080', '--root', 'public/'],
                port: 8080,
                kind: 'http',
                enabled: true,
            },
        };
        const status = await manager(runtime, sites, {
            serviceEnvFor: async () => ({
                DB_CONNECTION: 'pgsql',
                DB_HOST: 'genie-svc-postgres-17',
                DB_PORT: '5432',
            }),
        }).start('acme', SITE_ID);

        // (a) one container — the WORKSPACE SANDBOX — and the process runs INTO it
        //     as the migrated dev command (frankenphp is not in the sandbox).
        expect(status.state).toBe('running');
        expect(runtime.ran).toHaveLength(1);
        expect(runtime.ran[0]?.name).toBe(SANDBOX);
        const start = startExec(runtime);
        expect(start?.id).toBe(SANDBOX_ID);
        expect(start?.argv.slice(5)).toEqual([
            'php',
            'artisan',
            'serve',
            '--host=0.0.0.0',
            '--port=8080',
        ]);

        // (b) the workspace service env reaches the site process.
        expect(start?.env?.DB_CONNECTION).toBe('pgsql');
        expect(start?.env?.DB_HOST).toBe('genie-svc-postgres-17');
        expect(start?.env?.DB_PORT).toBe('5432');

        // (c) the reported port is the sandbox's published Caddy port.
        expect(status.hostPort).toBe(CADDY_HOST_PORT);
        expect(status.origin).toBe('https://web.acme.gen');
    });

    it('hosts a HOST-NATIVE site by ROUTING .gen at a host dev-server port — no container, no runtime (story #238)', async () => {
        // The owner's model: run the repo's dev server as a HOST process (e.g. via
        // manageProcess) on 127.0.0.1:<hostPort> and just POINT the site at it. No
        // container, no build, no runtime needed.
        const runtime = fakeRuntime({ detection: { kind: 'none', probes: [] } });
        const sites: DevSites = {
            [SITE_ID]: {
                name: 'web',
                genName: 'web.acme.gen',
                repo: 'app',
                runMode: 'explicit',
                hostPort: 8001,
                kind: 'http',
                enabled: true,
            },
        };
        const m = manager(runtime, sites, { probeReady: async () => true });
        const status = await m.start('acme', SITE_ID);

        // (a) running + ready, and NOTHING was spawned — no container at all, even
        //     though the runtime reports `none` (host-native needs no Docker).
        expect(status.state).toBe('running');
        expect(status.ready).toBe(true);
        expect(runtime.ran).toHaveLength(0);

        // (b) the .gen route points STRAIGHT at the host loopback dev-server port,
        //     plain http (the Testing Browser's session-CA shim adds TLS at .gen).
        expect(m.genSites()).toEqual([
            {
                workspaceId: 'acme',
                genName: 'web.acme.gen',
                siteId: SITE_ID,
                hostname: 'web.acme.gen',
                scheme: 'http',
                port: 8001,
                loopback: '127.0.0.1',
            },
        ]);
    });

    it('reports a HOST-NATIVE site as plain http on loopback — there is no Caddy in front of it (genie#195)', async () => {
        // The other half of #195: a host-native dev server holds the port ITSELF and
        // speaks plain http, so the working local form is the bare loopback URL. One
        // label for both shapes is what made the container form unusable.
        const runtime = fakeRuntime({ detection: { kind: 'none', probes: [] } });
        const sites: DevSites = {
            [SITE_ID]: {
                name: 'web',
                genName: 'web.acme.gen',
                repo: 'app',
                runMode: 'explicit',
                hostPort: 8001,
                kind: 'http',
                enabled: true,
            },
        };
        const status = await manager(runtime, sites, { probeReady: async () => true }).start(
            'acme',
            SITE_ID,
        );
        expect(status.localOrigin).toBe('http://127.0.0.1:8001');
        // NO curl command for a host-native site. `curl -s <localOrigin>/` is the
        // origin on the line above with a verb in front of it, and the card was
        // printing both. The command is for the container case, where the URL
        // cannot be dialed unaided (genie#195).
        expect(status.localCurl).toBeUndefined();
    });

    it('exposes a browser-opted-in host-native site to the external-browser reconcile (story #238 P2)', async () => {
        const runtime = fakeRuntime({ detection: { kind: 'none', probes: [] } });
        const sites: DevSites = {
            [SITE_ID]: {
                name: 'web',
                genName: 'web.acme.gen',
                repo: 'app',
                runMode: 'explicit',
                hostPort: 8001,
                kind: 'http',
                enabled: true,
                browserExposed: true,
            },
        };
        const m = manager(runtime, sites, { probeReady: async () => true });
        await m.start('acme', SITE_ID);
        // The route the host Caddy :443 fronts, on the LIVE loopback port.
        expect(m.hostBrowserRoutes()).toEqual([{ genName: 'web.acme.gen', port: 8001 }]);
    });

    it('does NOT expose a host-native site that was not browser-opted-in (story #238 P2)', async () => {
        const runtime = fakeRuntime({ detection: { kind: 'none', probes: [] } });
        const sites: DevSites = {
            [SITE_ID]: {
                name: 'web',
                genName: 'web.acme.gen',
                repo: 'app',
                runMode: 'explicit',
                hostPort: 8001,
                kind: 'http',
                enabled: true,
            },
        };
        const m = manager(runtime, sites, { probeReady: async () => true });
        await m.start('acme', SITE_ID);
        expect(m.hostBrowserRoutes()).toEqual([]);
    });

    it('runs a MANAGED HOST-NATIVE site (runMode=host) as a HOST process — no container, host-form env, routed (story #238)', async () => {
        const runtime = fakeRuntime({ detection: { kind: 'none', probes: [] } });
        const spawned: Array<{ siteId: string; command: string[]; cwd: string; env: Record<string, string> }> = [];
        const hostSpawn = {
            start: async (i: { siteId: string; workspaceId: string; command: string[]; cwd: string; env: Record<string, string> }) => {
                spawned.push(i);
                return { ok: true as const, pid: 4242 };
            },
            stop: async () => {},
            alive: async () => false,
            readLog: async () => 'dev server log',
        };
        const sites: DevSites = {
            [SITE_ID]: {
                name: 'web',
                genName: 'web.acme.gen',
                repo: 'app',
                runMode: 'host',
                command: ['php', 'artisan', 'serve', '--host=127.0.0.1', '--port=8001'],
                port: 8001,
                kind: 'http',
                enabled: true,
            },
        };
        const m = manager(runtime, sites, {
            hostSpawn,
            serviceHostEnvFor: async () => ({ DB_HOST: '127.0.0.1', DB_PORT: '54329' }),
            probeReady: async () => true,
            // The HOST owns the port now — allocate a free one at start and IGNORE
            // the stored config.port (a fixed stored port is the collision vector).
            allocateFreePort: async () => 5321,
        });
        const status = await m.start('acme', SITE_ID);

        // Genie ran the repo's dev server as a HOST process — NOTHING containerised.
        expect(status.state).toBe('running');
        expect(status.ready).toBe(true);
        expect(runtime.ran).toHaveLength(0);
        expect(spawned).toHaveLength(1);
        // The command's port was rewritten to the ALLOCATED port, not the stored 8001.
        expect(spawned[0]?.command).toEqual(['php', 'artisan', 'serve', '--host=127.0.0.1', '--port=5321']);
        // Host-form service env (beta.237) reached the dev server.
        expect(spawned[0]?.env.DB_HOST).toBe('127.0.0.1');
        expect(spawned[0]?.env.DB_PORT).toBe('54329');
        // .gen routes straight at the ALLOCATED host dev-server port.
        expect(m.genSites()).toEqual([
            {
                workspaceId: 'acme',
                genName: 'web.acme.gen',
                siteId: SITE_ID,
                hostname: 'web.acme.gen',
                scheme: 'http',
                port: 5321,
                loopback: '127.0.0.1',
            },
        ]);
    });

    it('a host-native site whose services resolve to EMPTY host-env logs a diagnostic instead of serving DB-less (moic beta.245)', async () => {
        // The reported blocker: a workspace with services ENABLED but no host env
        // reaching the dev server. It fell back to its repo `.env`, pointed at a
        // local DB that did not exist, and 500'd — with NO signal from Genie. The
        // start must now record WHY the env is empty to the site log.
        const runtime = fakeRuntime({ detection: { kind: 'none', probes: [] } });
        const spawned: Array<{ note?: string; env: Record<string, string> }> = [];
        const hostSpawn = {
            start: async (i: {
                siteId: string;
                workspaceId: string;
                command: string[];
                cwd: string;
                env: Record<string, string>;
                note?: string;
            }) => {
                spawned.push(i);
                return { ok: true as const, pid: 4242 };
            },
            stop: async () => {},
            alive: async () => false,
            readLog: async () => '',
        };
        const sites: DevSites = {
            [SITE_ID]: { name: 'web', genName: 'web.acme.gen', repo: 'app', runMode: 'host', command: ['php', 'artisan', 'serve'], port: 8001, kind: 'http', enabled: true },
        };
        const m = manager(runtime, sites, {
            hostSpawn,
            probeReady: async () => true,
            allocateFreePort: async () => 5321,
            // Services ENABLED and live, but none publish a reachable loopback port,
            // so the host-form env is empty — the exact "up but DB-less" shape.
            serviceHostEnvReportFor: async () => ({
                env: {},
                enabled: 3,
                live: 3,
                withHostPort: 0,
                gaps: [
                    { engine: 'postgres', version: '17', reason: 'no-host-port' as const },
                    { engine: 'redis', version: '7', reason: 'no-host-port' as const },
                    { engine: 'minio', version: 'latest', reason: 'no-host-port' as const },
                ],
            }),
        });
        await m.start('acme', SITE_ID);

        expect(spawned).toHaveLength(1);
        // No DB env reached the process (the reported failure) …
        expect(spawned[0]?.env.DB_HOST).toBeUndefined();
        // … but it did NOT happen in silence: the site log gets an actionable note
        // that names the engines and connects the emptiness to the 500.
        expect(spawned[0]?.note).toBeTruthy();
        expect(spawned[0]?.note).toContain('postgres');
        expect(spawned[0]?.note).toMatch(/\.env/);
    });

    it('a host-native site missing ONE of its services still logs the diagnostic (genie#204)', async () => {
        // First-hand on beta.257: the site had a correct DB_HOST/DB_PORT and no
        // REDIS_PORT at all, so Laravel used 6379 and every request died on
        // `RedisException: … actively refused it`. The site bound, reported ready
        // and logged NOTHING, because one healthy engine silenced the warning.
        const runtime = fakeRuntime({ detection: { kind: 'none', probes: [] } });
        const spawned: Array<{ note?: string; env: Record<string, string> }> = [];
        const hostSpawn = {
            start: async (i: {
                siteId: string;
                workspaceId: string;
                command: string[];
                cwd: string;
                env: Record<string, string>;
                note?: string;
            }) => {
                spawned.push(i);
                return { ok: true as const, pid: 4242 };
            },
            stop: async () => {},
            alive: async () => false,
            readLog: async () => '',
        };
        const sites: DevSites = {
            [SITE_ID]: { name: 'web', genName: 'web.acme.gen', repo: 'app', runMode: 'host', command: ['php', 'artisan', 'serve'], port: 8001, kind: 'http', enabled: true },
        };
        const m = manager(runtime, sites, {
            hostSpawn,
            probeReady: async () => true,
            allocateFreePort: async () => 5321,
            serviceHostEnvReportFor: async () => ({
                env: { DB_HOST: '127.0.0.1', DB_PORT: '58783' },
                enabled: 2,
                live: 1,
                withHostPort: 1,
                gaps: [{ engine: 'redis', version: '7', reason: 'not-live' as const }],
            }),
        });
        const status = await m.start('acme', SITE_ID);

        // The site really does come up — that is what made this invisible.
        expect(status.state).toBe('running');
        expect(spawned[0]?.env.DB_PORT).toBe('58783');
        expect(spawned[0]?.env.REDIS_PORT).toBeUndefined();
        // …and the log now names the engine that is missing.
        expect(spawned[0]?.note).toContain('redis');
    });

    it('a host-native site with healthy service env starts with NO diagnostic note', async () => {
        const runtime = fakeRuntime({ detection: { kind: 'none', probes: [] } });
        const spawned: Array<{ note?: string; env: Record<string, string> }> = [];
        const hostSpawn = {
            start: async (i: {
                siteId: string;
                workspaceId: string;
                command: string[];
                cwd: string;
                env: Record<string, string>;
                note?: string;
            }) => {
                spawned.push(i);
                return { ok: true as const, pid: 4242 };
            },
            stop: async () => {},
            alive: async () => false,
            readLog: async () => '',
        };
        const sites: DevSites = {
            [SITE_ID]: { name: 'web', genName: 'web.acme.gen', repo: 'app', runMode: 'host', command: ['php', 'artisan', 'serve'], port: 8001, kind: 'http', enabled: true },
        };
        const m = manager(runtime, sites, {
            hostSpawn,
            probeReady: async () => true,
            allocateFreePort: async () => 5321,
            serviceHostEnvReportFor: async () => ({
                env: { DB_HOST: '127.0.0.1', DB_PORT: '54329' },
                enabled: 1,
                live: 1,
                withHostPort: 1,
                gaps: [],
            }),
        });
        await m.start('acme', SITE_ID);

        // The env reached the process, and there is nothing to warn about.
        expect(spawned[0]?.env.DB_HOST).toBe('127.0.0.1');
        expect(spawned[0]?.note).toBeUndefined();
    });

    it('serves a host-native STATIC/SPA site with Genie’s own Caddy — the agent writes NO server config', async () => {
        // The owner's screenshot: an agent hand-rolled `printf "server { … try_files …
        // /index.html }" > default.conf; exec nginx` just to serve a built SPA. Now
        // the agent declares `hostServe: static` and Genie renders + runs the config.
        const runtime = fakeRuntime({ detection: { kind: 'none', probes: [] } });
        const spawned: Array<{ command: string[]; cwd: string }> = [];
        const hostSpawn = {
            start: async (i: {
                siteId: string;
                workspaceId: string;
                command: string[];
                cwd: string;
                env: Record<string, string>;
                note?: string;
            }) => {
                spawned.push(i);
                return { ok: true as const, pid: 4242 };
            },
            stop: async () => {},
            alive: async () => false,
            readLog: async () => '',
        };
        const written: Array<{ siteId: string; content: string }> = [];
        const sites: DevSites = {
            [SITE_ID]: {
                name: 'wallet',
                genName: 'wallet.acme.gen',
                repo: 'imp-wallet',
                runMode: 'host',
                kind: 'http',
                enabled: true,
                hostServe: { mode: 'static', root: 'dist', spa: true },
            },
        };
        const m = manager(runtime, sites, {
            hostSpawn,
            probeReady: async () => true,
            allocateFreePort: async () => 5321,
            caddyBin: '/opt/genie/caddy',
            writeServeConfig: (siteId, content) => {
                written.push({ siteId, content });
                return `/cfg/${siteId}.caddyfile`;
            },
        });
        const status = await m.start('acme', SITE_ID);

        expect(status.state).toBe('running');
        expect(runtime.ran).toHaveLength(0); // nothing containerised
        // Genie wrote the Caddyfile serving the built dir WITH the SPA fallback.
        expect(written).toHaveLength(1);
        expect(written[0]?.content).toContain('file_server');
        expect(written[0]?.content).toContain('try_files {path} /index.html');
        expect(written[0]?.content).toContain(':5321 {');
        expect(written[0]?.content).toContain('dist');
        // …and ran GENIE'S Caddy against it, not a repo command.
        expect(spawned[0]?.command).toEqual([
            '/opt/genie/caddy',
            'run',
            '--config',
            `/cfg/${SITE_ID}.caddyfile`,
            '--adapter',
            'caddyfile',
        ]);
        // Routed at the allocated port exactly like any host-native site.
        expect(m.genSites()).toEqual([
            {
                workspaceId: 'acme',
                genName: 'wallet.acme.gen',
                siteId: SITE_ID,
                hostname: 'wallet.acme.gen',
                scheme: 'http',
                port: 5321,
                loopback: '127.0.0.1',
            },
        ]);
    });

    it('a static serve fails CLEARLY when this build has no bundled Caddy', async () => {
        const runtime = fakeRuntime({ detection: { kind: 'none', probes: [] } });
        const hostSpawn = {
            start: async () => ({ ok: true as const, pid: 1 }),
            stop: async () => {},
            alive: async () => false,
            readLog: async () => '',
        };
        const sites: DevSites = {
            [SITE_ID]: {
                name: 'wallet',
                genName: 'wallet.acme.gen',
                repo: 'imp-wallet',
                runMode: 'host',
                kind: 'http',
                enabled: true,
                hostServe: { mode: 'static', root: 'dist' },
            },
        };
        // No caddyBin / writeServeConfig injected — the serve mode is unavailable.
        const m = manager(runtime, sites, { hostSpawn, probeReady: async () => true, allocateFreePort: async () => 5321 });
        const status = await m.start('acme', SITE_ID);
        expect(status.state).toBe('failed');
    });

    it('serves a host-native PHP site with a php-cgi FastCGI worker + Genie’s Caddy (2 processes, nginx model)', async () => {
        // PHP is the one stack that is not its own web server: Genie runs a php-cgi
        // FastCGI worker AND its bundled Caddy (php_fastcgi over public/), both host
        // processes on allocated ports. The worker is a companion keyed <siteId>-fcgi
        // so the one-process registry manages it beside the site's Caddy.
        const runtime = fakeRuntime({ detection: { kind: 'none', probes: [] } });
        const spawned: Array<{ siteId: string; command: string[]; cwd: string; env: Record<string, string> }> = [];
        const stopped: string[] = [];
        const hostSpawn = {
            start: async (i: {
                siteId: string;
                workspaceId: string;
                command: string[];
                cwd: string;
                env: Record<string, string>;
                note?: string;
            }) => {
                spawned.push(i);
                return { ok: true as const, pid: 4242 };
            },
            stop: async (id: string) => {
                stopped.push(id);
            },
            // A started process STAYS UP — the ordinary case. (The fake used to say
            // nothing was ever alive, which quietly modelled a machine where every
            // worker dies; genie#206 is what happens when that is real.)
            alive: async (id: string) => spawned.some((s) => s.siteId === id),
            readLog: async () => '',
        };
        const written: Array<{ siteId: string; content: string }> = [];
        let nextPort = 5300;
        const sites: DevSites = {
            [SITE_ID]: {
                name: 'moic',
                genName: 'moic.acme.gen',
                repo: 'moicsuite',
                runMode: 'host',
                kind: 'http',
                enabled: true,
                hostServe: { mode: 'php', root: 'public' },
            },
        };
        const asked: Array<{ tool: string; bin: string; version?: string }> = [];
        const m = manager(runtime, sites, {
            hostSpawn,
            probeReady: async () => true,
            // Distinct ports per call: the site (Caddy) port, then the worker port.
            allocateFreePort: async () => (nextPort += 1),
            caddyBin: '/opt/genie/caddy',
            writeServeConfig: (siteId, content) => {
                written.push({ siteId, content });
                return `/cfg/${siteId}.caddyfile`;
            },
            resolveEngine: async (req) => {
                asked.push(req);
                return {
                    ok: true as const,
                    version: '8.3.33',
                    install: PHP_83,
                    exe: '/gd/toolchain/php/8.3.33/bin/php-cgi',
                };
            },
            serviceHostEnvReportFor: async () => ({
                env: { DB_HOST: '127.0.0.1', DB_PORT: '58783' },
                enabled: 1,
                live: 1,
                withHostPort: 1,
                gaps: [],
            }),
        });
        const status = await m.start('acme', SITE_ID);

        expect(status.state).toBe('running');
        expect(runtime.ran).toHaveLength(0); // nothing containerised
        // TWO processes: the FastCGI worker (companion key) + Genie's Caddy (site key).
        expect(spawned).toHaveLength(2);
        const worker = spawned.find((s) => s.siteId === `${SITE_ID}-fcgi`);
        const caddy = spawned.find((s) => s.siteId === SITE_ID);
        // The worker is the TOOLCHAIN'S php-cgi (genie#207) — the absolute executable
        // inside the version this site resolves to, never a bare name PATH decides —
        // bound to a loopback FastCGI port, run in the repo cwd with the DB env so
        // PHP reaches the managed database.
        expect(asked).toEqual([{ tool: 'php', bin: 'php-cgi' }]);
        expect(worker?.command).toEqual([
            '/gd/toolchain/php/8.3.33/bin/php-cgi',
            '-b',
            expect.stringMatching(/^127\.0\.0\.1:\d+$/),
        ]);
        expect(worker?.env.DB_HOST).toBe('127.0.0.1');
        const fcgiPort = worker?.command[2]?.split(':')[1];
        // Genie's Caddy serves public/ and routes PHP to that same worker port.
        expect(caddy?.command[0]).toBe('/opt/genie/caddy');
        const caddyfile = written.find((w) => w.siteId === SITE_ID)?.content ?? '';
        expect(caddyfile).toContain(`php_fastcgi 127.0.0.1:${fcgiPort}`);
        expect(caddyfile).toContain('public');
        // .gen routes to the Caddy's site port like any host-native site.
        expect(m.genSites()[0]?.genName).toBe('moic.acme.gen');

        // Stopping the site tears down BOTH processes.
        await m.stop(SITE_ID);
        expect(stopped).toContain(SITE_ID);
        expect(stopped).toContain(`${SITE_ID}-fcgi`);
    });

    it('FAILS the site when the php-cgi worker dies instantly, and says why (genie#206)', async () => {
        // The owner's beta.249 report. `php-cgi` was not on PATH, and on Windows the
        // command runs through a SHELL (it must — php/npm are `.cmd` shims), so the
        // spawn SUCCEEDS: cmd.exe gets a pid, prints "'php-cgi' is not recognized",
        // and exits. The old check only asked for a pid, so Genie brought Caddy up in
        // front of a dead backend and reported "Serving." while every request 502'd.
        //
        // A pid is not proof it ran. The worker has to still be there a moment later,
        // and when it is not the site must fail carrying the WORKER'S OWN output —
        // that line is the whole diagnosis, and it lives in a log nothing else reads.
        const runtime = fakeRuntime({ detection: { kind: 'none', probes: [] } });
        const spawned: string[] = [];
        const stopped: string[] = [];
        const hostSpawn = {
            start: async (i: { siteId: string }) => {
                spawned.push(i.siteId);
                return { ok: true as const, pid: 4242 };
            },
            stop: async (id: string) => {
                stopped.push(id);
            },
            // The worker exited; nothing is alive.
            alive: async () => false,
            readLog: async () =>
                "'php-cgi' is not recognized as an internal or external command,\noperable program or batch file.",
        };
        let nextPort = 5400;
        const sites: DevSites = {
            [SITE_ID]: {
                name: 'moic',
                genName: 'moic.acme.gen',
                repo: 'moicsuite',
                runMode: 'host',
                kind: 'http',
                enabled: true,
                hostServe: { mode: 'php', root: 'public' },
            },
        };
        const m = manager(runtime, sites, {
            hostSpawn,
            probeReady: async () => true,
            allocateFreePort: async () => (nextPort += 1),
            caddyBin: '/opt/genie/caddy',
            writeServeConfig: (siteId: string) => `/cfg/${siteId}.caddyfile`,
            resolveEngine: resolvesPhp83,
        });

        const status = await m.start('acme', SITE_ID);

        expect(status.state).toBe('failed');
        // The actual reason, verbatim from the worker — not "the site failed".
        expect(status.error).toContain('is not recognized');
        // ...WHICH php it ran (genie#207 — PATH is no longer the story, so a message
        // blaming PATH would send someone to fix the wrong thing)...
        expect(status.error).toContain('8.3.33');
        expect(status.error).toContain(PHP_83_CGI);
        // ...and what to do about it.
        expect(status.error).toMatch(/Toolchain/i);
        // Caddy was NEVER started in front of a backend that cannot answer.
        expect(spawned).toEqual([`${SITE_ID}-fcgi`]);
        // The dead worker is cleaned up rather than left tracked.
        expect(stopped).toContain(`${SITE_ID}-fcgi`);
    });

    it('asks the toolchain for the site’s PINNED php version (genie#207)', async () => {
        // The Toolchain page lets a site name its runtime; the spawn has to READ it.
        // A pin that is honoured nowhere is a UI promising a choice it never makes.
        const runtime = fakeRuntime({ detection: { kind: 'none', probes: [] } });
        const asked: Array<{ tool: string; bin: string; version?: string }> = [];
        const hostSpawn = {
            start: async () => ({ ok: true as const, pid: 4242 }),
            stop: async () => {},
            alive: async () => true,
            readLog: async () => '',
        };
        let nextPort = 5500;
        const sites: DevSites = {
            [SITE_ID]: {
                name: 'moic',
                genName: 'moic.acme.gen',
                repo: 'moicsuite',
                runMode: 'host',
                kind: 'http',
                enabled: true,
                hostServe: { mode: 'php', root: 'public', version: '8.4' },
            },
        };
        const m = manager(runtime, sites, {
            hostSpawn,
            probeReady: async () => true,
            allocateFreePort: async () => (nextPort += 1),
            caddyBin: '/opt/genie/caddy',
            writeServeConfig: (siteId: string) => `/cfg/${siteId}.caddyfile`,
            resolveEngine: async (req) => {
                asked.push(req);
                return resolvesPhp83();
            },
        });
        await m.start('acme', SITE_ID);
        expect(asked).toEqual([{ tool: 'php', bin: 'php-cgi', version: '8.4' }]);
    });

    it('FAILS a php site whose version cannot be resolved — BEFORE spawning anything (genie#207)', async () => {
        // Never a silent fallback to another runtime, and never a bare `php-cgi`
        // handed to PATH: a site quietly serving on the wrong PHP is the failure this
        // whole feature exists to prevent. The resolver's message IS the status.
        const runtime = fakeRuntime({ detection: { kind: 'none', probes: [] } });
        const spawned: string[] = [];
        const written: string[] = [];
        const hostSpawn = {
            start: async (i: { siteId: string }) => {
                spawned.push(i.siteId);
                return { ok: true as const, pid: 4242 };
            },
            stop: async () => {},
            alive: async () => true,
            readLog: async () => '',
        };
        const sites: DevSites = {
            [SITE_ID]: {
                name: 'moic',
                genName: 'moic.acme.gen',
                repo: 'moicsuite',
                runMode: 'host',
                kind: 'http',
                enabled: true,
                hostServe: { mode: 'php', root: 'public', version: '8.2' },
            },
        };
        const m = manager(runtime, sites, {
            hostSpawn,
            probeReady: async () => true,
            allocateFreePort: async () => 5321,
            caddyBin: '/opt/genie/caddy',
            writeServeConfig: (siteId: string) => {
                written.push(siteId);
                return `/cfg/${siteId}.caddyfile`;
            },
            resolveEngine: async () => ({
                ok: false as const,
                error: 'This site is pinned to PHP 8.2, which Genie does not manage on this machine. Add it in Settings → Toolchain → Languages.',
            }),
        });

        const status = await m.start('acme', SITE_ID);
        expect(status.state).toBe('failed');
        expect(status.error).toContain('PHP 8.2');
        expect(status.error).toContain('Settings → Toolchain');
        // Nothing ran, and no Caddyfile was written for a site that cannot serve.
        expect(spawned).toEqual([]);
        expect(written).toEqual([]);
    });

    it('a php serve fails CLEARLY when the build wires no engine resolver — never a bare php-cgi', async () => {
        // The absent dep must NOT degrade to the old PATH lookup: that lookup is
        // genie#206, and a "fallback" here would put it back the first time a caller
        // forgot to wire the resolver.
        const runtime = fakeRuntime({ detection: { kind: 'none', probes: [] } });
        const spawned: string[] = [];
        const hostSpawn = {
            start: async (i: { siteId: string }) => {
                spawned.push(i.siteId);
                return { ok: true as const, pid: 4242 };
            },
            stop: async () => {},
            alive: async () => true,
            readLog: async () => '',
        };
        const sites: DevSites = {
            [SITE_ID]: {
                name: 'moic',
                genName: 'moic.acme.gen',
                repo: 'moicsuite',
                runMode: 'host',
                kind: 'http',
                enabled: true,
                hostServe: { mode: 'php', root: 'public' },
            },
        };
        const m = manager(runtime, sites, {
            hostSpawn,
            probeReady: async () => true,
            allocateFreePort: async () => 5321,
            caddyBin: '/opt/genie/caddy',
            writeServeConfig: (siteId: string) => `/cfg/${siteId}.caddyfile`,
        });
        const status = await m.start('acme', SITE_ID);
        expect(status.state).toBe('failed');
        expect(spawned).toEqual([]);
    });

    it('warns in the site log when the repo declares an engine version the host does not match (item 4)', async () => {
        const runtime = fakeRuntime({ detection: { kind: 'none', probes: [] } });
        const spawned: Array<{ note?: string }> = [];
        const hostSpawn = {
            start: async (i: {
                siteId: string;
                workspaceId: string;
                command: string[];
                cwd: string;
                env: Record<string, string>;
                note?: string;
            }) => {
                spawned.push(i);
                return { ok: true as const, pid: 4242 };
            },
            stop: async () => {},
            alive: async () => false,
            readLog: async () => '',
        };
        const sites: DevSites = {
            [SITE_ID]: { name: 'web', genName: 'web.acme.gen', repo: 'app', runMode: 'host', stack: 'node', command: ['npm', 'run', 'dev'], port: 5173, kind: 'http', enabled: true },
        };
        const m = manager(runtime, sites, {
            hostSpawn,
            probeReady: async () => true,
            allocateFreePort: async () => 5321,
            // A host-native site runs on the HOST runtime — a declared/host mismatch
            // is surfaced as a start-time note, not a silent wrong-version run.
            engineMismatchNote: async (_cwd, stack) =>
                stack === 'node' ? "this repo declares node 22 but Genie's host has node 20" : null,
        });
        await m.start('acme', SITE_ID);
        expect(spawned[0]?.note).toMatch(/node 22.*node 20/);
    });

    it('two same-stack host sites NEVER share a port — the moic.gen/fancy collision, closed', async () => {
        // The reported bug: two workspaces ran the same command on the same default
        // port. With the REAL allocator + the live-port exclude set, the two sites
        // must land on DISTINCT ports so `<name>.gen` can never route to the wrong app.
        const runtime = fakeRuntime({ detection: { kind: 'none', probes: [] } });
        const hostSpawn = {
            start: async () => ({ ok: true as const, pid: 4242 }),
            stop: async () => {},
            alive: async () => false,
            readLog: async () => '',
        };
        const webId = devSiteIdFor('acme', 'web');
        const apiId = devSiteIdFor('acme', 'api');
        const sameCommand = ['php', 'artisan', 'serve', '--host=127.0.0.1', '--port=8000'];
        const sites: DevSites = {
            [webId]: { name: 'web', genName: 'web.acme.gen', repo: 'web', runMode: 'host', command: sameCommand, port: 8000, kind: 'http', enabled: true },
            [apiId]: { name: 'api', genName: 'api.acme.gen', repo: 'api', runMode: 'host', command: sameCommand, port: 8000, kind: 'http', enabled: true },
        };
        // REAL allocator (no injection) — proves the invariant end to end.
        const m = manager(runtime, sites, { hostSpawn, probeReady: async () => true });
        await m.start('acme', webId);
        await m.start('acme', apiId);

        const ports = m.genSites().map((g) => g.port);
        expect(ports).toHaveLength(2);
        expect(ports[0]).not.toBe(ports[1]);
    });

    it('a re-entrant start (reconcile) keeps the LIVE allocated port — no re-alloc, no respawn', async () => {
        const runtime = fakeRuntime({ detection: { kind: 'none', probes: [] } });
        let starts = 0;
        let alive = false;
        const hostSpawn = {
            start: async () => {
                starts += 1;
                alive = true;
                return { ok: true as const, pid: 4242 };
            },
            stop: async () => {},
            alive: async () => alive,
            readLog: async () => '',
        };
        const sites: DevSites = {
            [SITE_ID]: { name: 'web', genName: 'web.acme.gen', repo: 'app', runMode: 'host', command: ['php', 'artisan', 'serve', '--port=8000'], port: 8000, kind: 'http', enabled: true },
        };
        let allocations = 0;
        const m = manager(runtime, sites, {
            hostSpawn,
            probeReady: async () => true,
            allocateFreePort: async () => {
                allocations += 1;
                return 5321;
            },
        });
        await m.start('acme', SITE_ID); // allocates 5321, spawns
        await m.start('acme', SITE_ID); // re-entrant: alive → re-record, NO respawn

        expect(starts).toBe(1); // spawned once
        expect(allocations).toBe(1); // allocated once
        expect(m.genSites()[0]?.port).toBe(5321); // still on the live port
    });

    it('a MANAGED host-native site FAILS clearly when host-native hosting is unavailable (no hostSpawn)', async () => {
        const runtime = fakeRuntime({ detection: { kind: 'none', probes: [] } });
        const sites: DevSites = {
            [SITE_ID]: {
                name: 'web',
                genName: 'web.acme.gen',
                repo: 'app',
                runMode: 'host',
                command: ['php', 'artisan', 'serve'],
                port: 8001,
                kind: 'http',
                enabled: true,
            },
        };
        const status = await manager(runtime, sites, {}).start('acme', SITE_ID);
        expect(status.state).toBe('failed');
        expect(status.error).toMatch(/host-native hosting is not available/i);
        expect(runtime.ran).toHaveLength(0);
    });

    it('probes a host-native site over PLAIN HTTP — no servername (the ready:false bug, genie#160)', async () => {
        // A host-native dev server speaks plain http on 127.0.0.1. Passing a
        // servername routes the readiness probe to the HTTPS-SNI path, whose TLS
        // handshake fails against the plain-http port → every host-native site reads
        // ready:false even when it answers. The probe must stay plain http.
        const runtime = fakeRuntime({ detection: { kind: 'none', probes: [] } });
        const hostSpawn = {
            start: async () => ({ ok: true as const, pid: 4242 }),
            stop: async () => {},
            alive: async () => false,
            readLog: async () => '',
        };
        const probeCalls: Array<{ kind: string; servername?: string }> = [];
        const sites: DevSites = {
            [SITE_ID]: { name: 'web', genName: 'web.acme.gen', repo: 'app', runMode: 'host', command: ['php', 'artisan', 'serve'], port: 8001, kind: 'http', enabled: true },
        };
        const m = manager(runtime, sites, {
            hostSpawn,
            allocateFreePort: async () => 5321,
            probeReady: async (args: { kind: string; servername?: string }) => {
                probeCalls.push(args);
                return true;
            },
        });
        await m.start('acme', SITE_ID);
        expect(probeCalls).toHaveLength(1);
        expect(probeCalls[0]?.kind).toBe('http');
        expect(probeCalls[0]?.servername).toBeUndefined(); // plain http → waitForHttp, not waitForHttpsSni
    });
});

// --- genie#226: what a RESTART actually did ---------------------------------
//
// CONTRIBUTING.md, "Never report a success you have not verified" — and the one
// instance the rule cites whose own comment already admitted it:
//
//     // An EXTERNAL host-native site (hostPort, no container) runs no process
//     // Genie owns — dropping its route above IS the stop; the dev server it
//     // points at is the user's own host process, left running.
//
// `restart` is `stop()` then `start()`. For an external host-native site that
// drops a route and re-adds it, then probes a dev server that was never
// stopped. genie#305 made the resulting `ready: true` genuinely true, which
// makes the unqualified "restarted" MORE convincing, not less.
//
// The MANAGED path has the other half: both `hostSpawn.stop` calls are
// `.catch(() => {})`, and the entry is removed from `live` first. A stop that
// fails therefore leaves a process Genie has already forgotten — it is no
// longer in `livePortSet()`, so no later stop can reach it — while the caller
// is told the site restarted.

const HOST_SITE: DevSiteConfig = {
    name: 'web',
    genName: 'web.acme.gen',
    repo: 'app',
    runMode: 'host',
    command: ['php', 'artisan', 'serve'],
    port: 8001,
    kind: 'http',
    enabled: true,
};

/** A host spawn whose `stop` resolves but changes nothing, so `alive` decides. */
function spawnFake(alive: boolean) {
    const stopped: string[] = [];
    const started: string[] = [];
    return {
        stopped,
        started,
        hostSpawn: {
            start: async (o: { siteId: string }) => {
                started.push(o.siteId);
                return { ok: true as const, pid: 4242 };
            },
            stop: async (id: string) => {
                stopped.push(id);
            },
            alive: async () => alive,
            readLog: async () => '',
        },
    };
}

describe('a restart says what it established (genie#226)', () => {
    it('reports the process the stop did NOT kill, rather than a clean restart', async () => {
        const runtime = fakeRuntime({ detection: { kind: 'none', probes: [] } });
        const { hostSpawn, stopped } = spawnFake(true);
        const m = manager(
            runtime,
            { [SITE_ID]: HOST_SITE },
            { hostSpawn, probeReady: async () => true, allocateFreePort: async () => 5321 },
        );
        await m.start('acme', SITE_ID);
        const status = await m.restart('acme', SITE_ID);

        expect(stopped).toContain(SITE_ID);
        const notes = (status.notes ?? []).join(' ');
        // The damage is an ORPHAN: already dropped from `live`, so excluded from
        // livePortSet() and unreachable by any later stop. Say so, and name it.
        expect(notes).toMatch(/still running|did not stop|could not stop/i);
        expect(notes).toContain(SITE_ID);
    });

    it('says nothing when the stop DID take — positive control', async () => {
        const runtime = fakeRuntime({ detection: { kind: 'none', probes: [] } });
        const { hostSpawn, started } = spawnFake(false);
        const m = manager(
            runtime,
            { [SITE_ID]: HOST_SITE },
            { hostSpawn, probeReady: async () => true, allocateFreePort: async () => 5321 },
        );
        await m.start('acme', SITE_ID);
        const status = await m.restart('acme', SITE_ID);

        expect(status.state).toBe('running');
        expect(status.ready).toBe(true);
        // A real restart: the dev server was spawned again.
        expect(started).toEqual([SITE_ID, SITE_ID]);
        expect((status.notes ?? []).join(' ')).not.toMatch(/still running|did not stop|could not stop/i);
    });

    it('tells an EXTERNAL host-native site that its dev server was NOT restarted', async () => {
        const runtime = fakeRuntime({ detection: { kind: 'none', probes: [] } });
        const { hostSpawn, started } = spawnFake(false);
        const external: DevSiteConfig = {
            name: 'web',
            genName: 'web.acme.gen',
            repo: 'app',
            runMode: 'explicit',
            hostPort: 8001,
            kind: 'http',
            enabled: true,
        };
        const m = manager(runtime, { [SITE_ID]: external }, { hostSpawn, probeReady: async () => true });
        await m.start('acme', SITE_ID);
        const status = await m.restart('acme', SITE_ID);

        // The evidence for the claim: Genie spawned NOTHING, either time.
        expect(started).toEqual([]);
        expect(runtime.ran).toHaveLength(0);
        // …and `ready` is now genuinely true (genie#305), which is exactly why an
        // unqualified "restarted" reads as convincing.
        expect(status.ready).toBe(true);
        const notes = (status.notes ?? []).join(' ');
        expect(notes).toMatch(/not restarted|did not restart|Genie does not run/i);
        expect(notes).toContain('8001');
    });

    it('does not claim a managed site was left alone — positive control on the note', async () => {
        // The external note must not fire for a site Genie DOES run, or it would
        // teach the reader to ignore it.
        const runtime = fakeRuntime({ detection: { kind: 'none', probes: [] } });
        const { hostSpawn } = spawnFake(false);
        const m = manager(
            runtime,
            { [SITE_ID]: HOST_SITE },
            { hostSpawn, probeReady: async () => true, allocateFreePort: async () => 5321 },
        );
        await m.start('acme', SITE_ID);
        const status = await m.restart('acme', SITE_ID);
        expect((status.notes ?? []).join(' ')).not.toMatch(/not restarted|Genie does not run/i);
    });

    it('a plain STOP reports the orphan too — the same lie, one action over', async () => {
        const runtime = fakeRuntime({ detection: { kind: 'none', probes: [] } });
        const { hostSpawn } = spawnFake(true);
        const m = manager(
            runtime,
            { [SITE_ID]: HOST_SITE },
            { hostSpawn, probeReady: async () => true, allocateFreePort: async () => 5321 },
        );
        await m.start('acme', SITE_ID);
        const report = await m.stop(SITE_ID);
        expect(report.orphaned).toContain(SITE_ID);
    });

    it('a stop that took reports no orphan — positive control', async () => {
        const runtime = fakeRuntime({ detection: { kind: 'none', probes: [] } });
        const { hostSpawn } = spawnFake(false);
        const m = manager(
            runtime,
            { [SITE_ID]: HOST_SITE },
            { hostSpawn, probeReady: async () => true, allocateFreePort: async () => 5321 },
        );
        await m.start('acme', SITE_ID);
        expect((await m.stop(SITE_ID)).orphaned).toEqual([]);
    });
});

import { describe, expect, it } from 'vitest';
import { createDevSiteManager } from '../site-manager';
import { devSiteIdFor } from '../sites-config';
import type { DevSiteConfig, DevSites } from '../sites-config';
import type { ContainerRuntime, RuntimeDetection } from '../container-runtime';
import { octaneServeCommand, type OctaneServer } from '../octane-serve';

/**
 * STARTING A `hostServe: octane` SITE (genie#668).
 *
 * An Octane site is ONE host process — `php artisan octane:start` supervising its
 * server — and that server is the web server, so there is no Caddy and no FastCGI
 * worker. What Genie owns is what Octane would otherwise make up: the ports its
 * server binds besides the site port, which must come from the same allocator as
 * every other port so they cannot collide with another site's.
 */

const NO_RUNTIME: RuntimeDetection = { kind: 'none', probes: [] };
const WS = { id: 'acme', path: '/work/acme', label: 'acme' };
const PHP = '/gd/toolchain/php/8.4.24/bin/php';
const FRANKENPHP_EXE = '/gd/toolchain/frankenphp/1.12.7/frankenphp';
const RR_EXE = '/gd/toolchain/roadrunner/2025.1.15/roadrunner-2025.1.15-linux-amd64/rr';

const octaneSite = (name: string, server: OctaneServer, version?: string): DevSiteConfig => ({
    name,
    genName: `${name}.acme.gen`,
    repo: name,
    runMode: 'host',
    kind: 'http',
    enabled: true,
    hostServe: { mode: 'octane', server, ...(version ? { version } : {}) },
});

function harness(
    sites: DevSites,
    opts: {
        canWatch?: boolean;
        firstPort?: number;
        platform?: NodeJS.Platform;
        composer?: unknown;
        frankenphp?: { ok: true; exe: string; phpVersion: string } | { ok: false; error: string };
        roadrunner?: { ok: true; exe: string } | { ok: false; error: string };
        noRoadrunner?: boolean;
        baseEnv?: NodeJS.ProcessEnv;
    } = {},
) {
    const spawns: Array<{ siteId: string; command: string[]; cwd: string; env: Record<string, string> }> = [];
    const up = new Set<string>();
    const allocations: Array<{ exclude: number[]; got: number }> = [];
    const engineAsks: Array<{ tool: string; bin: string; version?: string; requires?: unknown }> = [];
    const composerReads: string[] = [];
    let next = opts.firstPort ?? 5300;
    const m = createDevSiteManager({
        resolveRuntime: async () => ({ runtime: null as ContainerRuntime | null, detection: NO_RUNTIME }),
        listWorkspaces: () => [WS],
        devSitesFor: () => sites,
        platform: opts.platform ?? 'linux',
        hostIds: null,
        hostSpawn: {
            start: async (i: { siteId: string; command: string[]; cwd: string; env: Record<string, string> }) => {
                spawns.push({ siteId: i.siteId, command: i.command, cwd: i.cwd, env: i.env });
                up.add(i.siteId);
                return { ok: true as const, pid: 4242 };
            },
            stop: async (id: string) => {
                up.delete(id);
            },
            alive: async (id: string) => up.has(id),
            readLog: async () => '',
        },
        probeReady: async () => true,
        allocateFreePort: async (exclude: Set<number>) => {
            next += 1;
            while (exclude.has(next)) next += 1;
            allocations.push({ exclude: [...exclude].sort(), got: next });
            return next;
        },
        resolveEngine: async (req) => {
            engineAsks.push(req);
            return {
                ok: true as const,
                version: '8.4.24',
                install: {
                    tool: 'php' as const,
                    version: '8.4.24',
                    dir: '/gd/toolchain/php/8.4.24',
                    exe: PHP,
                    source: 'genie' as const,
                    removable: true,
                },
                exe: PHP,
            };
        },
        serviceHostEnvReportFor: async () => ({
            env: { DB_HOST: '127.0.0.1', DB_PORT: '58783' },
            enabled: 1,
            live: 1,
            withHostPort: 1,
            gaps: [],
        }),
        octaneCanWatch: () => opts.canWatch ?? false,
        resolveFrankenphp: async () => opts.frankenphp ?? { ok: true, exe: FRANKENPHP_EXE, phpVersion: '8.5.10' },
        ...(opts.noRoadrunner
            ? {}
            : { resolveRoadrunner: async () => opts.roadrunner ?? { ok: true as const, exe: RR_EXE } }),
        baseEnv: opts.baseEnv ?? { PATH: '/usr/bin:/bin' },
        readComposerJson: (cwd: string) => {
            composerReads.push(cwd.replace(/\\/g, '/'));
            return opts.composer ?? null;
        },
        // Deliberately NO caddyBin / writeServeConfig: Octane's server is the web
        // server, so an Octane site must start in a build with no Caddy at all.
    });
    return { m, spawns, up, allocations, engineAsks, composerReads };
}

describe('hostServe octane — start', () => {
    it('starts FrankenPHP as ONE process, on the site port, with an admin port Genie allocated', async () => {
        const id = devSiteIdFor('acme', 'shop');
        const h = harness({ [id]: octaneSite('shop', 'frankenphp') });

        const status = await h.m.start('acme', id);

        expect(status.state).toBe('running');
        expect(status.ready).toBe(true);
        expect(h.spawns).toHaveLength(1);
        const [run] = h.spawns;
        expect(run?.siteId).toBe(id);
        expect(run?.command).toEqual(
            octaneServeCommand({ phpExe: PHP, server: 'frankenphp', port: 5301, adminPort: 5302, watch: false }),
        );
        // The admin port was allocated with the site port excluded.
        expect(h.allocations[1]).toEqual({ exclude: [5301], got: 5302 });
        // In the repo, with the service env AND Octane's https switch.
        expect(run?.cwd.replace(/\\/g, '/')).toBe('/work/acme/repos/shop');
        expect(run?.env.DB_HOST).toBe('127.0.0.1');
        expect(run?.env.OCTANE_HTTPS).toBe('true');
        // The php CLI — not php-cgi — resolved through the toolchain.
        expect(h.engineAsks).toEqual([{ tool: 'php', bin: 'php' }]);
        // `.gen` routes to the Octane server itself.
        expect(h.m.genSites()[0]?.port).toBe(5301);
    });

    it('starts RoadRunner with an RPC port Genie allocated', async () => {
        const id = devSiteIdFor('acme', 'shop');
        const h = harness({ [id]: octaneSite('shop', 'roadrunner') });
        await h.m.start('acme', id);
        expect(h.spawns[0]?.command).toEqual(
            octaneServeCommand({ phpExe: PHP, server: 'roadrunner', port: 5301, rpcPort: 5302, watch: false }),
        );
    });

    it('starts Swoole with no second port allocated', async () => {
        const id = devSiteIdFor('acme', 'shop');
        const h = harness({ [id]: octaneSite('shop', 'swoole') });
        await h.m.start('acme', id);
        expect(h.spawns[0]?.command).toEqual(
            octaneServeCommand({ phpExe: PHP, server: 'swoole', port: 5301, watch: false }),
        );
        expect(h.allocations).toHaveLength(1);
    });

    it('resolves the PINNED php version', async () => {
        const id = devSiteIdFor('acme', 'shop');
        const h = harness({ [id]: octaneSite('shop', 'swoole', '8.3') });
        await h.m.start('acme', id);
        expect(h.engineAsks).toEqual([{ tool: 'php', bin: 'php', version: '8.3' }]);
    });

    it('watches for file changes when the repo can, so an agent is not testing stale code', async () => {
        const id = devSiteIdFor('acme', 'shop');
        const h = harness({ [id]: octaneSite('shop', 'frankenphp') }, { canWatch: true });
        await h.m.start('acme', id);
        expect(h.spawns[0]?.command).toContain('--watch');
    });

    it('never hands a live Octane site\'s admin port to the next site', async () => {
        // The collision this whole mode exists to prevent. The first site's admin
        // port must be in the exclusion set every later allocation is given.
        const a = devSiteIdFor('acme', 'shop');
        const b = devSiteIdFor('acme', 'blog');
        const h = harness({ [a]: octaneSite('shop', 'frankenphp'), [b]: octaneSite('blog', 'roadrunner') });

        await h.m.start('acme', a);
        const adminPort = h.allocations[1]!.got;
        await h.m.start('acme', b);

        for (const later of h.allocations.slice(2)) {
            expect(later.exclude, 'a later allocation must exclude the live admin port').toContain(adminPort);
            expect(later.got).not.toBe(adminPort);
        }
    });

    it('releases the admin port when the site stops', async () => {
        const a = devSiteIdFor('acme', 'shop');
        const b = devSiteIdFor('acme', 'blog');
        const h = harness({ [a]: octaneSite('shop', 'frankenphp'), [b]: octaneSite('blog', 'swoole') });

        await h.m.start('acme', a);
        const adminPort = h.allocations[1]!.got;
        await h.m.stop(a);
        await h.m.start('acme', b);

        expect(h.allocations.at(-1)!.exclude).not.toContain(adminPort);
    });

    it('REFUSES Swoole on Windows — naming why, what runs here, and the container route — and starts nothing', async () => {
        // Swoole is a PHP extension with no native Windows build. The site
        // definition travels in the git-tracked envelope, so a teammate on macOS
        // may rightly use it; the refusal belongs to THIS machine's start.
        const id = devSiteIdFor('acme', 'shop');
        const h = harness({ [id]: octaneSite('shop', 'swoole') }, { platform: 'win32' });

        const status = await h.m.start('acme', id);

        expect(status.state).toBe('failed');
        expect(status.error).toMatch(/Swoole/);
        expect(status.error).toMatch(/Windows/);
        expect(status.error).toMatch(/FrankenPHP/);
        expect(status.error).toMatch(/RoadRunner/);
        expect(status.error).toMatch(/container/i);
        expect(h.spawns).toHaveLength(0);
    });

    it('POSITIVE CONTROL: FrankenPHP and RoadRunner DO start on Windows, and Swoole does elsewhere', async () => {
        for (const server of ['frankenphp', 'roadrunner'] as const) {
            const id = devSiteIdFor('acme', 'shop');
            const h = harness({ [id]: octaneSite('shop', server) }, { platform: 'win32' });
            expect((await h.m.start('acme', id)).state).toBe('running');
        }
        const id = devSiteIdFor('acme', 'shop');
        const h = harness({ [id]: octaneSite('shop', 'swoole') }, { platform: 'darwin' });
        expect((await h.m.start('acme', id)).state).toBe('running');
    });

    it('FAILS, saying why, when this build cannot resolve a managed PHP', async () => {
        const id = devSiteIdFor('acme', 'shop');
        const sites: DevSites = { [id]: octaneSite('shop', 'frankenphp') };
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
            },
            probeReady: async () => true,
            allocateFreePort: async () => 5301,
        });
        const status = await m.start('acme', id);
        expect(status.state).toBe('failed');
        expect(status.error).toMatch(/PHP/);
    });
});

describe('the PHP a site runs on comes from the REPO (genie#668, owner decision)', () => {
    it('hands the resolver what composer.json requires when the site pins nothing', async () => {
        const id = devSiteIdFor('acme', 'shop');
        const h = harness({ [id]: octaneSite('shop', 'frankenphp') }, { composer: { require: { php: '^8.3' } } });

        await h.m.start('acme', id);

        expect(h.composerReads).toEqual(['/work/acme/repos/shop']);
        expect(h.engineAsks).toEqual([
            { tool: 'php', bin: 'php', requires: { constraint: '^8.3', source: 'require.php' } },
        ]);
    });

    it('prefers config.platform.php, the platform the lock file was resolved for', async () => {
        const id = devSiteIdFor('acme', 'shop');
        const h = harness(
            { [id]: octaneSite('shop', 'roadrunner') },
            { composer: { require: { php: '^8.2' }, config: { platform: { php: '8.3.4' } } } },
        );
        await h.m.start('acme', id);
        expect(h.engineAsks[0]?.requires).toEqual({ constraint: '8.3.*', source: 'config.platform.php' });
    });

    it('asks for nothing extra when the repo states no PHP — the machine default applies', async () => {
        const id = devSiteIdFor('acme', 'shop');
        const h = harness({ [id]: octaneSite('shop', 'swoole') }, { composer: { require: {} } });
        await h.m.start('acme', id);
        expect(h.engineAsks).toEqual([{ tool: 'php', bin: 'php' }]);
    });

    it('an explicit pin is the override: composer.json is not consulted', async () => {
        const id = devSiteIdFor('acme', 'shop');
        const h = harness({ [id]: octaneSite('shop', 'swoole', '8.4') }, { composer: { require: { php: '^8.2' } } });
        await h.m.start('acme', id);
        expect(h.engineAsks).toEqual([{ tool: 'php', bin: 'php', version: '8.4' }]);
    });

    it('does the same for a php-cgi site', async () => {
        const id = devSiteIdFor('acme', 'moic');
        const asks: unknown[] = [];
        const sites: DevSites = {
            [id]: {
                name: 'moic',
                genName: 'moic.acme.gen',
                repo: 'moic',
                runMode: 'host',
                kind: 'http',
                enabled: true,
                hostServe: { mode: 'php', root: 'public' },
            },
        };
        let port = 5400;
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
            },
            probeReady: async () => true,
            allocateFreePort: async () => (port += 1),
            caddyBin: '/opt/genie/caddy',
            writeServeConfig: (siteId: string) => `/cfg/${siteId}.caddyfile`,
            prepareUploadTmpDir: (siteId: string) => `/gd/uploads/${siteId}`,
            readComposerJson: () => ({ require: { php: '>=8.2 <8.4' } }),
            resolveEngine: async (req) => {
                asks.push(req);
                return {
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
                    exe: '/gd/toolchain/php/8.3.33/bin/php-cgi',
                };
            },
        });

        await m.start('acme', id);

        expect(asks).toEqual([
            { tool: 'php', bin: 'php-cgi', requires: { constraint: '>=8.2 <8.4', source: 'require.php' } },
        ]);
    });
});

describe('Octane on FrankenPHP uses the FrankenPHP Genie installs (genie#668)', () => {
    // Octane looks for `frankenphp` in the project root or on PATH and otherwise
    // prompts to download one — and on Windows refuses outright ("use WSL or
    // Docker"), though FrankenPHP ships a native Windows build. So Genie puts its
    // own install first on the site's PATH, and the app — which runs on
    // FrankenPHP's embedded PHP — is checked against composer.json like any
    // FrankenPHP site.
    it("puts Genie's FrankenPHP first on the site's PATH", async () => {
        const id = devSiteIdFor('acme', 'shop');
        const h = harness({ [id]: octaneSite('shop', 'frankenphp') }, { baseEnv: { PATH: '/usr/bin:/bin' } });
        await h.m.start('acme', id);
        const pathValue = h.spawns[0]?.env.PATH ?? '';
        expect(pathValue.split(':')[0]).toBe('/gd/toolchain/frankenphp/1.12.7');
        expect(pathValue).toContain('/usr/bin');
    });

    it("keeps Windows' own spelling of the PATH key, so the child does not get two", async () => {
        const id = devSiteIdFor('acme', 'shop');
        const h = harness(
            { [id]: octaneSite('shop', 'frankenphp') },
            { platform: 'win32', baseEnv: { Path: 'C:\\Windows\\system32' } },
        );
        await h.m.start('acme', id);
        const env = h.spawns[0]?.env ?? {};
        expect(env.PATH).toBeUndefined();
        expect((env.Path ?? '').split(';')[0]).toBe('/gd/toolchain/frankenphp/1.12.7');
    });

    it("REFUSES a repo whose composer.json excludes FrankenPHP's PHP", async () => {
        const id = devSiteIdFor('acme', 'shop');
        const h = harness({ [id]: octaneSite('shop', 'frankenphp') }, { composer: { require: { php: '<8.5' } } });
        const status = await h.m.start('acme', id);
        expect(status.state).toBe('failed');
        expect(status.error).toContain('<8.5');
        expect(h.spawns).toHaveLength(0);
    });

    it("FAILS with the installer's reason when FrankenPHP cannot be installed", async () => {
        const id = devSiteIdFor('acme', 'shop');
        const h = harness({ [id]: octaneSite('shop', 'frankenphp') }, { frankenphp: { ok: false, error: 'HTTP 503' } });
        const status = await h.m.start('acme', id);
        expect(status.state).toBe('failed');
        expect(status.error).toContain('HTTP 503');
    });

    it('POSITIVE CONTROL: RoadRunner and Swoole do not touch FrankenPHP', async () => {
        for (const server of ['roadrunner', 'swoole'] as const) {
            const id = devSiteIdFor('acme', 'shop');
            const h = harness({ [id]: octaneSite('shop', server) }, { composer: { require: { php: '<8.5' } } });
            const status = await h.m.start('acme', id);
            expect(status.state, server).toBe('running');
            expect(h.spawns[0]?.env.PATH ?? '', server).not.toContain('frankenphp');
        }
    });
});

describe('Octane on RoadRunner uses the rr Genie installs (genie#668)', () => {
    // Octane looks for `rr` in the project root or on PATH and otherwise asks to
    // download one, and `vendor/bin/rr get-binary` then drops the binary INTO the
    // user's repo. Genie installs the pinned release and puts it first on PATH.
    it("puts Genie's rr first on the site's PATH", async () => {
        const id = devSiteIdFor('acme', 'shop');
        const h = harness({ [id]: octaneSite('shop', 'roadrunner') }, { baseEnv: { PATH: '/usr/bin:/bin' } });
        const status = await h.m.start('acme', id);
        expect(status.state).toBe('running');
        const pathValue = h.spawns[0]?.env.PATH ?? '';
        expect(pathValue.split(':')[0]).toBe('/gd/toolchain/roadrunner/2025.1.15/roadrunner-2025.1.15-linux-amd64');
        expect(pathValue).toContain('/usr/bin');
    });

    it("FAILS with the installer's reason when rr cannot be installed", async () => {
        const id = devSiteIdFor('acme', 'shop');
        const h = harness({ [id]: octaneSite('shop', 'roadrunner') }, { roadrunner: { ok: false, error: 'HTTP 503' } });
        const status = await h.m.start('acme', id);
        expect(status.state).toBe('failed');
        expect(status.error).toContain('HTTP 503');
        expect(h.spawns).toHaveLength(0);
    });

    it('refuses rather than letting Octane download rr into the repo, in a build that cannot install it', async () => {
        const id = devSiteIdFor('acme', 'shop');
        const h = harness({ [id]: octaneSite('shop', 'roadrunner') }, { noRoadrunner: true });
        const status = await h.m.start('acme', id);
        expect(status.state).toBe('failed');
        expect(status.error).toMatch(/RoadRunner/);
        expect(h.spawns).toHaveLength(0);
    });

    it('POSITIVE CONTROL: FrankenPHP and Swoole do not touch rr', async () => {
        for (const server of ['frankenphp', 'swoole'] as const) {
            const id = devSiteIdFor('acme', 'shop');
            const h = harness({ [id]: octaneSite('shop', server) }, { noRoadrunner: true });
            const status = await h.m.start('acme', id);
            expect(status.state, server).toBe('running');
            expect(h.spawns[0]?.env.PATH ?? '', server).not.toContain('roadrunner');
        }
    });
});

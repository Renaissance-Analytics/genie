import { describe, expect, it } from 'vitest';
import path from 'path';
import { createDevSiteManager } from '../site-manager';
import { devSiteIdFor, sanitizeDevSitePatch, siteEngineUse } from '../sites-config';
import type { DevSiteConfig, DevSites } from '../sites-config';
import type { ContainerRuntime, RuntimeDetection } from '../container-runtime';
import { frankenphpCaddyfile, frankenphpRunArgv } from '../frankenphp';

/**
 * STARTING A `hostServe: frankenphp` SITE (genie#668).
 *
 * One process — FrankenPHP running the Caddyfile Genie writes — where the php
 * mode runs two (Caddy in front of a php-cgi worker). There is no worker to die
 * and nothing to revive, which is the point.
 *
 * Its PHP is the one FrankenPHP embeds, so the repo's composer.json is checked
 * BEFORE the binary is fetched: a repo that cannot run on it is refused naming
 * the mode that can, and nobody downloads 160 MB to find that out.
 */

const NO_RUNTIME: RuntimeDetection = { kind: 'none', probes: [] };
const WS = { id: 'acme', path: '/work/acme', label: 'acme' };
const EXE = '/gd/toolchain/frankenphp/1.12.7/frankenphp';
const SITE: DevSiteConfig = {
    name: 'shop',
    genName: 'shop.acme.gen',
    repo: 'shop',
    runMode: 'host',
    kind: 'http',
    enabled: true,
    hostServe: { mode: 'frankenphp', root: 'public' },
};

function harness(opts: { composer?: unknown; resolve?: () => Promise<unknown> } = {}) {
    const id = devSiteIdFor('acme', 'shop');
    const sites: DevSites = { [id]: SITE };
    const spawns: Array<{ siteId: string; command: string[]; cwd: string; env: Record<string, string> }> = [];
    const written: Array<{ siteId: string; content: string }> = [];
    let resolves = 0;
    let port = 5500;
    const m = createDevSiteManager({
        resolveRuntime: async () => ({ runtime: null as ContainerRuntime | null, detection: NO_RUNTIME }),
        listWorkspaces: () => [WS],
        devSitesFor: () => sites,
        platform: 'linux',
        hostIds: null,
        hostSpawn: {
            start: async (i: { siteId: string; command: string[]; cwd: string; env: Record<string, string> }) => {
                spawns.push(i);
                return { ok: true as const, pid: 7 };
            },
            stop: async () => {},
            alive: async () => true,
            readLog: async () => '',
        },
        probeReady: async () => true,
        allocateFreePort: async () => (port += 1),
        writeServeConfig: (siteId: string, content: string) => {
            written.push({ siteId, content });
            return `/cfg/${siteId}.caddyfile`;
        },
        prepareUploadTmpDir: (siteId: string) => `/gd/host-site-uploads/${siteId}`,
        readComposerJson: () => opts.composer ?? null,
        resolveFrankenphp: async () => {
            resolves += 1;
            return (await (opts.resolve ?? (async () => ({ ok: true, exe: EXE, phpVersion: '8.5.10' })))()) as never;
        },
        serviceHostEnvReportFor: async () => ({ env: { DB_HOST: '127.0.0.1' }, enabled: 1, live: 1, withHostPort: 1, gaps: [] }),
        // No caddyBin: FrankenPHP IS the web server.
    });
    return { m, id, spawns, written, resolves: () => resolves };
}

describe('hostServe frankenphp — start', () => {
    it('starts ONE FrankenPHP process running the Caddyfile Genie wrote, on the allocated port', async () => {
        const h = harness({ composer: { require: { php: '^8.3' } } });
        const status = await h.m.start('acme', h.id);

        expect(status.state).toBe('running');
        expect(status.ready).toBe(true);
        expect(h.spawns.map((s) => s.siteId)).toEqual([h.id]);
        expect(h.spawns[0]?.command).toEqual(frankenphpRunArgv(EXE, `/cfg/${h.id}.caddyfile`));
        expect(h.spawns[0]?.env.DB_HOST).toBe('127.0.0.1');
        expect(h.written).toEqual([
            {
                siteId: h.id,
                content: frankenphpCaddyfile({
                    sitePort: 5501,
                    root: path.join('/work/acme/repos/shop', 'public'),
                    uploadTmpDir: `/gd/host-site-uploads/${h.id}`,
                }),
            },
        ]);
        expect(h.m.genSites()[0]?.port).toBe(5501);
    });

    it('REFUSES a repo whose composer.json excludes FrankenPHP\'s PHP — before downloading anything', async () => {
        const h = harness({ composer: { require: { php: '>=8.2 <8.5' } } });
        const status = await h.m.start('acme', h.id);

        expect(status.state).toBe('failed');
        expect(status.error).toContain('>=8.2 <8.5');
        expect(status.error).toContain('`php` mode');
        expect(h.resolves()).toBe(0);
        expect(h.spawns).toHaveLength(0);
    });

    it('FAILS with the installer\'s own reason when FrankenPHP cannot be put on this machine', async () => {
        const h = harness({ resolve: async () => ({ ok: false, error: 'Could not download FrankenPHP 1.12.7: HTTP 503' }) });
        const status = await h.m.start('acme', h.id);
        expect(status.state).toBe('failed');
        expect(status.error).toContain('HTTP 503');
        expect(h.spawns).toHaveLength(0);
    });

    it('re-checks the INSTALLED binary\'s PHP, not only the pinned one', async () => {
        // The binary is asked what it embeds; a repo is judged against that answer.
        const h = harness({
            composer: { require: { php: '~8.5.10' } },
            resolve: async () => ({ ok: true, exe: EXE, phpVersion: '8.6.0' }),
        });
        const status = await h.m.start('acme', h.id);
        expect(status.state).toBe('failed');
        expect(status.error).toContain('8.6.0');
    });
});

describe('hostServe frankenphp — config', () => {
    it('is stored with its document root, and requires one', () => {
        expect(sanitizeDevSitePatch({ hostServe: { mode: 'frankenphp', root: 'public' } }).hostServe).toEqual({
            mode: 'frankenphp',
            root: 'public',
        });
        expect(sanitizeDevSitePatch({ hostServe: { mode: 'frankenphp' } as never }).hostServe).toBeUndefined();
    });

    it('is not moved by the machine\'s PHP default — it runs the PHP FrankenPHP embeds', () => {
        expect(siteEngineUse({ genName: 'shop.acme.gen', hostServe: { mode: 'frankenphp', root: 'public' } })).toBeNull();
    });
});

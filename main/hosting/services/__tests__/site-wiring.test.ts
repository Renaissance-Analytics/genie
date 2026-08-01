import { describe, expect, it } from 'vitest';
import { createHostingManager } from '../../manager';
import { renderCaddyfile } from '../../caddyfile';
import type { HostedSite, HostedStatus, SiteRuntime } from '../../types';

/**
 * The seam where a running service becomes something the hosted APP can use.
 *
 * `services/env.ts` explains why there are two delivery paths and why this one —
 * real environment variables on the server process — is the safe one: it writes
 * nothing to the user's repository. This suite covers that path end to end, from
 * "the workspace has a database" to the `env` directives in the generated
 * Caddyfile, because a break anywhere along it produces the same symptom (a
 * hosted Laravel app that 500s on its first query) with no clue where it came
 * from.
 */

function recordingRuntime(): SiteRuntime & { sites: HostedSite[] } {
    const sites: HostedSite[] = [];
    return {
        sites,
        backend: 'frankenphp',
        async start(site) {
            // Captured by value: the manager mutates the resolved site, and a
            // reference would show the post-hoc state rather than what was
            // actually handed to the runtime.
            sites.push(JSON.parse(JSON.stringify(site)) as HostedSite);
            const status: HostedStatus = {
                siteId: site.id,
                state: 'running',
                backend: 'frankenphp',
                target: { scheme: 'https', hostname: site.hostname, port: 20431 },
                origin: `https://${site.hostname}:20431`,
            };
            return status;
        },
        async stop() {},
        status: (siteId) => ({
            siteId,
            state: 'stopped',
            backend: 'frankenphp',
            target: null,
            origin: null,
        }),
        list: () => [],
        async stopAll() {},
    };
}

const phpSite = {
    enabled: true,
    hostname: 'shop.test',
    kind: 'php' as const,
    docroot: 'public',
};

function harness(serviceEnv: Record<string, string>) {
    const runtime = recordingRuntime();
    const manager = createHostingManager({
        baseDir: '/base',
        platform: 'linux',
        listWorkspaces: () => [{ id: 'w1', path: '/repo/w1' }],
        hostedSitesFor: () => ({ s1: phpSite }),
        ensureRuntime: async () =>
            ({
                binaryPath: '/fp/frankenphp',
                extensionDir: null,
                version: 'v1.12.6',
                installDir: '/fp',
                downloaded: false,
            }) as never,
        createFrankenPhp: () => runtime,
        serviceEnvFor: () => serviceEnv,
    });
    return { manager, runtime };
}

describe('managed services reach the hosted app', () => {
    it('starts a PHP site with the database credentials in its environment', async () => {
        const { manager, runtime } = harness({
            DB_CONNECTION: 'pgsql',
            DB_HOST: '127.0.0.1',
            DB_PORT: '21432',
            DB_DATABASE: 'genie',
            DB_USERNAME: 'genie',
            DB_PASSWORD: 'sekrit',
            REDIS_HOST: '127.0.0.1',
            REDIS_PORT: '21379',
        });
        const status = await manager.start('w1', 'shop.test');
        expect(status.state).toBe('running');
        expect(runtime.sites[0]!.env).toMatchObject({
            DB_CONNECTION: 'pgsql',
            DB_PORT: '21432',
            DB_PASSWORD: 'sekrit',
            REDIS_PORT: '21379',
        });
    });

    it('leaves a site with no services exactly as it was', async () => {
        const { manager, runtime } = harness({});
        await manager.start('w1', 'shop.test');
        expect(runtime.sites[0]!.env).toBeUndefined();
    });

    it('reaches the generated Caddyfile as env directives', async () => {
        // The last link: FrankenPHP only exposes what the config tells it to.
        const { manager, runtime } = harness({
            DB_PORT: '21432',
            DB_PASSWORD: 'sekrit',
            // A value with a space, to pin that the renderer quotes when it has
            // to — an unquoted one would end the directive early and Caddy
            // would refuse the whole config.
            DB_DATABASE: 'my app',
        });
        await manager.start('w1', 'shop.test');
        const caddyfile = renderCaddyfile(runtime.sites[0]!, { port: 20431, storageDir: '/state' });
        expect(caddyfile).toContain('env DB_PORT 21432');
        expect(caddyfile).toContain('env DB_PASSWORD sekrit');
        expect(caddyfile).toContain('env DB_DATABASE "my app"');
        // Inside the php_server block, or FrankenPHP never sees it.
        expect(caddyfile).toMatch(/php_server \{[\s\S]*env DB_PORT 21432[\s\S]*\}/);
    });

    it('does NOT hand a static site database credentials', async () => {
        // A built frontend is served straight off disk to a browser; there is
        // no server-side process that could use them, and nothing that should
        // be carrying a password.
        const runtime = recordingRuntime();
        const manager = createHostingManager({
            baseDir: '/base',
            platform: 'linux',
            listWorkspaces: () => [{ id: 'w1', path: '/repo/w1' }],
            hostedSitesFor: () => ({
                s1: { ...phpSite, kind: 'static' as const, docroot: 'dist' },
            }),
            ensureBuilt: async () => ({ built: false }),
            createStatic: () => runtime,
            serviceEnvFor: () => ({ DB_PASSWORD: 'sekrit' }),
        });
        await manager.start('w1', 'shop.test');
        expect(JSON.stringify(runtime.sites[0])).not.toContain('sekrit');
    });
});

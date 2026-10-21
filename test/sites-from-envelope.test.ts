import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ComposedServices, composeServices } from '../src/main/compose.js';
import { featureSnapshot, handleFeatureAction, type FeatureState } from '../src/main/feature-ipc.js';
import type { HostsIo } from '../src/main/hosts-file.js';
import type { PtyPort } from '../src/main/terminal-host.js';
import { composeTracker } from './support/compose-tracker.js';

/**
 * A WORKSPACE'S SITES LIVE IN ITS ENVELOPE (§6.6, the regression from v1). Every `.agi` envelope's
 * project.json carries a `sites` block — the one Genie 1 hosted from. Genie 2 kept sites in memory only,
 * so Hosting started EMPTY on every launch and a site added in Genie 2 vanished on restart.
 *
 * The contract, through the real composition root and the Hosting actions:
 * - on launch every declared site is LISTED, in every registered workspace;
 * - v1's boot rule: an `enabled` site in an AWAKE workspace is started, unless the person stopped it
 *   (machine-local, survives the launch); a disabled one, or one in a hibernating workspace, is listed
 *   and not started; a waking workspace brings its enabled sites up;
 * - a site Genie 2 cannot serve is LISTED with the reason, never dropped;
 * - a site created or removed in Hosting is written to the envelope, and only the `sites` key changes.
 *
 * Fixtures are invented (`*.example` workspaces); nothing here is anyone's real host.
 */

const opened: Array<{ command: string; cwd: string; env: Readonly<Record<string, string>> }> = [];
const pty: PtyPort = {
    open: (o) => { opened.push({ command: o.command ?? '', cwd: o.cwd ?? '', env: o.env ?? {} }); return { id: `term_${opened.length}`, pid: 1, shell: o.command ?? 'sh', scrollback: '' }; },
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
};
/** The hosts file: what it says now, and every write it took (a write on a real machine may be an admin prompt). */
let hostsContent = '127.0.0.1 localhost\n';
let hostsWrites = 0;
const hostsIo: HostsIo = { read: async () => hostsContent, write: async (n) => { hostsWrites += 1; hostsContent = n; }, stage: async () => ({ command: 'cp', args: [] }) };
const state = (): FeatureState => ({ toolStatuses: null, knowledgeQuery: '' });
const settle = () => new Promise<void>((r) => setTimeout(r, 25));

let dir: string;
let acme: string;
let sleepy: string;
let services: ComposedServices | null = null;
/** Every composition a test starts is shut down before its folder is removed — one still composing when a test timed out included (B13). */
const composed = composeTracker();
let workspaces: Array<{ id: string; path: string; asleep?: boolean }> = [];
const listeners = new Set<() => void>();

/** The manifest as a person's editor left it: 2-space JSON, keys Genie does not own around the sites block. */
const ACME = {
    $schema: 'https://raw.githubusercontent.com/Civicognita/shared-schemas/v0.2.0/schemas/workspace/project.schema.json',
    name: 'Acme',
    type: 'agi',
    repos: [
        { name: 'Shop', slug: 'shop', path: 'repos/shop', role: 'app' },
        { name: 'docs-site', path: 'repos/docs-site' },
        { name: 'api', slug: 'api', path: 'repos/api' },
    ],
    hosting: { enabled: true, type: 'static' },
    sites: {
        aaaa000000000001: { repo: 'shop', runMode: 'host', kind: 'http', enabled: true, name: 'shop', genName: 'shop.gen', stack: 'php', framework: 'laravel', browserExposed: true, hostServe: { mode: 'php', root: 'public' } },
        aaaa000000000002: { repo: 'docs-site', runMode: 'host', kind: 'http', enabled: false, name: 'docs', genName: 'docs.gen', hostServe: { mode: 'static', root: 'dist', spa: true } },
        aaaa000000000003: { repo: 'api', runMode: 'host', kind: 'http', enabled: true, name: 'api', genName: 'api.gen', command: ['npm', 'run', 'dev', '--', '--port', '5173'], port: 5173 },
        aaaa000000000004: { repo: '', runMode: 'host', kind: 'http', enabled: true, name: 'legacy', genName: 'legacy.gen', hostPort: 8085 },
        aaaa000000000005: { repo: 'api', runMode: 'explicit', kind: 'http', enabled: true, name: 'wallet', genName: 'wallet.gen', command: ['node', 'server.js'], port: 3000 },
        aaaa000000000006: { repo: 'shop', runMode: 'host', kind: 'http', enabled: true, name: 'web', genName: 'web.acme.gen', hostServe: { mode: 'php', root: 'public' } },
    },
    tynn: { project: 'acme-example' },
};

const SLEEPY = {
    name: 'Sleepy',
    repos: [{ name: 'blog', slug: 'blog', path: 'repos/blog' }],
    sites: { bbbb000000000001: { repo: 'blog', runMode: 'host', kind: 'http', enabled: true, name: 'blog', genName: 'blog.gen', hostServe: { mode: 'static', root: 'public' } } },
};

async function envelope(path: string, manifest: unknown, repos: string[]): Promise<void> {
    for (const r of repos) await mkdir(join(path, 'repos', r), { recursive: true });
    await writeFile(join(path, 'project.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function launch(): Promise<ComposedServices> {
    services = await composed.compose({
        userData: join(dir, 'genie-home'), pty, v1Settings: () => null, caddyBin: '/opt/genie/runtime/caddy', frontDoorPort: 0,
        hostsIo, elevate: async () => ({ ok: true }), hostsDebounceMs: 1, frontDoorPorts: { probe: async () => 'free', holder: async () => null },
        workspaces: () => workspaces,
        onWorkspacesChange: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
        // One PHP worker: these tests are about which sites start; several workers are test/php-fast.test.ts's.
        phpWorkers: 1,
    } as Parameters<typeof composeServices>[0]);
    await settle();
    return services;
}

async function relaunch(): Promise<ComposedServices> {
    await services?.shutdown();
    listeners.clear();
    opened.length = 0;
    return launch();
}

const sitesOf = async (s: ComposedServices) => (await featureSnapshot(s, state())).hosting!.sites;
const manifestOf = async (path: string) => JSON.parse(await readFile(join(path, 'project.json'), 'utf8')) as Record<string, unknown>;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-sites-envelope-'));
    acme = join(dir, 'acme.example');
    sleepy = join(dir, 'sleepy.example');
    await envelope(acme, ACME, ['shop', 'docs-site', 'api', 'new']);
    await envelope(sleepy, SLEEPY, ['blog']);
    workspaces = [{ id: 'acme', path: acme }, { id: 'sleepy', path: sleepy, asleep: true }];
    opened.length = 0;
    listeners.clear();
    hostsContent = '127.0.0.1 localhost\n';
    hostsWrites = 0;
});

afterEach(async () => {
    await composed.shutdownAll();
    services = null;
    await rm(dir, { recursive: true, force: true });
});

describe('on launch', () => {
    it('lists every site each workspace’s project.json declares — including the ones Genie 2 cannot serve, each with its reason', async () => {
        const s = await launch();
        const sites = await sitesOf(s);
        expect(sites.map((x) => x.host).sort()).toEqual(['api.gen', 'blog.gen', 'docs.gen', 'legacy.gen', 'shop.gen', 'wallet.gen', 'web.acme.gen']);
        const wallet = sites.find((x) => x.host === 'wallet.gen')!;
        expect(wallet).toMatchObject({ workspaceId: 'acme', state: 'unservable' });
        expect(wallet.problem).toMatch(/container/);
        // S5: Genie 1's own default name, `<site>.<workspace>.gen`, is SERVED now (it was listed unservable: "one label").
        const web = sites.find((x) => x.host === 'web.acme.gen')!;
        expect(web).toMatchObject({ workspaceId: 'acme', name: 'web.acme', state: 'running', problem: null });
        // Unservable rows route nothing; the multi-label site is routed under its full name.
        expect(s.routes().map((r) => r.host)).not.toContain('wallet.gen');
        expect(s.routes().map((r) => r.host)).toContain('web.acme.gen');
    });

    it('starts the ENABLED sites of AWAKE workspaces with the serve mode project.json names, in the repo repos[] resolves', async () => {
        const s = await launch();
        const sites = await sitesOf(s);
        const byHost = (h: string) => sites.find((x) => x.host === h)!;
        expect(byHost('shop.gen').state).toBe('running');
        expect(byHost('api.gen').state).toBe('running');
        expect(byHost('legacy.gen').state).toBe('external');
        // php: the FastCGI worker and Caddy, both in repos/shop — for shop.gen, and for web.acme.gen (S5), which serves the same repo.
        expect(opened.filter((o) => o.cwd === join(acme, 'repos', 'shop')).map((o) => o.command.split(' ')[0])).toEqual(['php-cgi', '/opt/genie/runtime/caddy', 'php-cgi', '/opt/genie/runtime/caddy']);
        // proxy: the stored argv with the port Genie allocated in place of the one written down.
        const api = opened.find((o) => o.cwd === join(acme, 'repos', 'api'))!;
        expect(api.command).toBe(`npm run dev -- --port ${byHost('api.gen').port}`);
        expect(s.routes().map((r) => r.host).sort()).toEqual(['api.gen', 'legacy.gen', 'shop.gen', 'web.acme.gen']);
    });

    it('a disabled site, and every site of a hibernating workspace, is listed but NOT started', async () => {
        const s = await launch();
        const sites = await sitesOf(s);
        expect(sites.find((x) => x.host === 'docs.gen')).toMatchObject({ state: 'stopped', processIds: [] });
        expect(sites.find((x) => x.host === 'blog.gen')).toMatchObject({ state: 'stopped', workspaceId: 'sleepy', processIds: [] });
        expect(opened.some((o) => o.cwd.startsWith(sleepy))).toBe(false);
        expect(opened.some((o) => o.cwd === join(acme, 'repos', 'docs-site'))).toBe(false);
        // Positive control in the same run: the scan does find processes started in acme (shop's two, api's one, web.acme's two).
        expect(opened.filter((o) => o.cwd.startsWith(acme)).length).toBe(5);
    });

    it('a waking workspace brings its enabled sites up', async () => {
        const s = await launch();
        workspaces = [{ id: 'acme', path: acme }, { id: 'sleepy', path: sleepy, asleep: false }];
        for (const l of listeners) l();
        await settle();
        expect((await sitesOf(s)).find((x) => x.host === 'blog.gen')).toMatchObject({ state: 'running' });
        expect(opened.some((o) => o.cwd === join(sleepy, 'repos', 'blog'))).toBe(true);
    });
});

describe('the person’s Start and Stop', () => {
    it('Start serves a listed site that was not started; a Stop is remembered on this machine through the next launch', async () => {
        let s = await launch();
        let snap = await handleFeatureAction(s, { kind: 'hosting.startSite', siteId: 'site_docs' } as never, state());
        expect(snap.hosting!.sites.find((x) => x.host === 'docs.gen')).toMatchObject({ state: 'running' });

        await handleFeatureAction(s, { kind: 'hosting.stopSite', siteId: 'site_shop' }, state());
        s = await relaunch();
        expect((await sitesOf(s)).find((x) => x.host === 'shop.gen')).toMatchObject({ state: 'stopped' });
        // shop.gen's own server did not start; web.acme.gen, which serves the same repo, did (the control that the scan sees one).
        expect(opened.filter((o) => o.command.includes(join('site_shop', 'Caddyfile')))).toHaveLength(0);
        expect(opened.filter((o) => o.command.includes(join('site_web.acme', 'Caddyfile')))).toHaveLength(1);
        // The stop is machine-local: the git-tracked envelope still says enabled.
        expect(((await manifestOf(acme)).sites as Record<string, { enabled: boolean }>).aaaa000000000001!.enabled).toBe(true);

        snap = await handleFeatureAction(s, { kind: 'hosting.startSite', siteId: 'site_shop' } as never, state());
        expect(snap.hosting!.sites.find((x) => x.host === 'shop.gen')).toMatchObject({ state: 'running' });
        s = await relaunch();
        expect((await sitesOf(s)).find((x) => x.host === 'shop.gen')).toMatchObject({ state: 'running' });
    });
});

describe('a site created or removed in Hosting is kept in the envelope', () => {
    it('a created site is written to project.json — every other key untouched — and is there on the next launch', async () => {
        let s = await launch();
        const before = await manifestOf(acme);
        await handleFeatureAction(s, {
            kind: 'hosting.createSite', workspaceId: 'acme', repoPath: join(acme, 'repos', 'new'),
            form: { name: 'fresh', mode: 'static', devServer: null, hostPort: null, root: 'build', spa: true },
        }, state());
        const after = await manifestOf(acme);
        const { sites: sitesAfter, ...restAfter } = after;
        const { sites: sitesBefore, ...restBefore } = before;
        expect(restAfter).toEqual(restBefore);
        expect(Object.keys(after)).toEqual(Object.keys(before));
        const added = Object.entries(sitesAfter as Record<string, Record<string, unknown>>).filter(([k]) => !(k in (sitesBefore as object)));
        expect(added).toHaveLength(1);
        expect(added[0]![1]).toMatchObject({ name: 'fresh', genName: 'fresh.gen', repo: 'new', runMode: 'host', kind: 'http', enabled: true, hostServe: { mode: 'static', root: 'build', spa: true } });
        for (const [k, v] of Object.entries(sitesBefore as object)) expect((sitesAfter as Record<string, unknown>)[k]).toEqual(v);

        s = await relaunch();
        expect((await sitesOf(s)).find((x) => x.host === 'fresh.gen')).toMatchObject({ workspaceId: 'acme', state: 'running' });
    });

    it('a removed site is deleted from project.json and does not come back', async () => {
        let s = await launch();
        await handleFeatureAction(s, { kind: 'hosting.removeSite', siteId: 'site_api' }, state());
        const sites = (await manifestOf(acme)).sites as Record<string, unknown>;
        expect(sites).not.toHaveProperty('aaaa000000000003');
        expect(Object.keys(sites)).toHaveLength(5);
        s = await relaunch();
        expect((await sitesOf(s)).map((x) => x.host)).not.toContain('api.gen');
    });

    it('a workspace with no project.json is told to convert first; nothing is created', async () => {
        const bare = join(dir, 'bare.example');
        await mkdir(bare, { recursive: true });
        workspaces = [...workspaces, { id: 'bare', path: bare }];
        const s = await launch();
        await expect(handleFeatureAction(s, {
            kind: 'hosting.createSite', workspaceId: 'bare', repoPath: bare,
            form: { name: 'loose', mode: 'proxy', devServer: null, hostPort: 7000, root: null, spa: false },
        }, state())).rejects.toThrow(/project\.json/);
        expect(existsSync(join(bare, 'project.json'))).toBe(false);
        expect((await sitesOf(s)).map((x) => x.host)).not.toContain('loose.gen');
    });
});

describe('the hosts file follows the CONFIGURED sites (S4)', () => {
    it('carries every servable site not declared disabled — running or not, asleep or awake — written ONCE for the whole boot', async () => {
        const s = await launch();
        // docs is `enabled: false`; wallet cannot be served; web.acme can since S5; blog's workspace is asleep, but blog is configured.
        expect(s.configuredHosts().sort()).toEqual(['api.gen', 'blog.gen', 'legacy.gen', 'shop.gen', 'web.acme.gen']);
        expect(hostsWrites).toBe(1);
        for (const h of ['api.gen', 'blog.gen', 'legacy.gen', 'shop.gen', 'web.acme.gen']) expect(hostsContent).toContain(`127.0.0.1 ${h}\n::1 ${h}\n`);
        expect(hostsContent).not.toContain('docs.gen');
        expect(hostsContent).not.toContain('wallet.gen');
    });

    it('the person’s Stop and Start, and a workspace waking, write nothing; a site created in Hosting is one write', async () => {
        const s = await launch();
        expect(hostsWrites).toBe(1);
        await handleFeatureAction(s, { kind: 'hosting.stopSite', siteId: 'site_shop' }, state());
        await handleFeatureAction(s, { kind: 'hosting.startSite', siteId: 'site_shop' } as never, state());
        workspaces = [{ id: 'acme', path: acme }, { id: 'sleepy', path: sleepy, asleep: false }];
        for (const l of listeners) l();
        await settle();
        expect((await sitesOf(s)).find((x) => x.host === 'blog.gen')).toMatchObject({ state: 'running' });
        expect(hostsWrites).toBe(1);
        // Positive control in the same run: a new site is exactly one write.
        await handleFeatureAction(s, {
            kind: 'hosting.createSite', workspaceId: 'acme', repoPath: join(acme, 'repos', 'new'),
            form: { name: 'fresh', mode: 'static', devServer: null, hostPort: null, root: 'build', spa: true },
        }, state());
        await settle();
        expect(hostsWrites).toBe(2);
        expect(hostsContent).toContain('127.0.0.1 fresh.gen');
    });
});

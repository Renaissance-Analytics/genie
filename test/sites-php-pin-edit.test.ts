import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject } from '@particle-academy/prism-mcp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import { managedCgiCommand } from '../src/core/php-versions.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { handleFeatureAction, type FeaturePorts, type FeatureState } from '../src/main/feature-ipc.js';
import type { TrustStorePort } from '../src/main/gen-ca.js';
import type { HostsIo } from '../src/main/hosts-file.js';
import { hostingTools } from '../src/main/mcp-tools-hosting.js';
import type { Caller, Registration } from '../src/main/mcp-tools.js';
import { resolvePhpCgi, type PhpVersionsFs } from '../src/main/php-versions.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * T4 × S6 — A SITE'S PHP PIN THROUGH EDIT AND THE AGENTS' `sites` TOOL. The pin is project.json `hostServe.version`,
 * carried as the site form's `phpVersion`. Through the REAL composition, with the REAL pin resolver
 * (main/php-versions.ts `resolvePhpCgi`) over a fake toolchain directory holding 8.5.11 and 8.4.26:
 *
 * - an Edit of something else KEEPS the pin (project.json's hostServe.version, counted, unchanged);
 * - an Edit that changes the pin re-serves the site on the NEW version's php-cgi, and a Restart runs it again;
 * - an agent's `update` / `add` with `phpVersion` goes through the person's approval, and a version Genie does not manage
 *   is refused with the start's own reason WITHOUT asking (counted: zero approvals, nothing written or spawned).
 *
 * Every name is invented (`*.example`).
 */

const opened: Array<{ command: string; cwd: string }> = [];
const pty: PtyPort = {
    open: (o) => { opened.push({ command: o.command ?? '', cwd: o.cwd ?? '' }); return { id: `term_${opened.length}`, pid: 1, shell: o.command ?? 'sh', scrollback: '' }; },
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
};
const hostsIo: HostsIo = { read: async () => '127.0.0.1 localhost\n', write: async () => {}, stage: async () => ({ command: 'cp', args: [] }) };
const trustStore: TrustStorePort = { has: async () => true };
const settle = () => new Promise<void>((r) => setTimeout(r, 25));
const state = (): FeatureState => ({ toolStatuses: null, knowledgeQuery: '' });

/** The versions Genie manages in the fake toolchain directory, newest first. */
const MANAGED = ['8.5.11', '8.4.26'];

let dir: string;
let acme: string;
let phpRoot: string;
let services: ComposedServices;
let tools: Registration[];
let caller: Caller;

/** A toolchain directory with MANAGED in it, each with its php-cgi.exe — read-only: nothing here installs. */
const phpFs = (): PhpVersionsFs => {
    const cgi = new Set(MANAGED.map((v) => join(phpRoot, v, 'php-cgi.exe')));
    const no = () => { throw new Error('the pin resolver writes nothing'); };
    return { exists: (p) => cgi.has(p), list: (d) => (d === phpRoot ? [...MANAGED] : []), mkdirp: no, writeText: no, writeBytes: no, rename: no, removeTree: no };
};
const cgiOf = (version: string) => managedCgiCommand(join(phpRoot, version), 'win32');
/** The php workers spawned, in order — the php-cgi each ran. */
const workers = () => opened.filter((o) => o.command.includes(' -b 127.0.0.1:')).map((o) => o.command.replace(/ -b 127\.0\.0\.1:\d+$/, ''));

/** The Add / Edit form's PHP choices: the versions Genie manages. */
const ports = (): FeaturePorts => ({
    toolchain: {
        probe: async () => [],
        update: async () => ({ kind: 'refused', reason: 'n/a' }),
        now: () => 5_000,
        php: {
            list: async () => ({ managed: MANAGED.map((v) => ({ version: v, dir: join(phpRoot, v), usedBy: [] })), system: null, available: [] }),
            install: async () => ({ kind: 'refused', reason: 'n/a' }),
            remove: () => ({ kind: 'refused', reason: 'n/a' }),
        },
    },
});

const manifestOf = async () => JSON.parse(await readFile(join(acme, 'project.json'), 'utf8')) as { sites: Record<string, Record<string, any>> };
const shopEntry = async () => (await manifestOf()).sites.aaaa000000000001!;

async function call(args: JsonObject) {
    const reg = tools.find((t) => t.definition.name === 'sites')!;
    const r = await reg.handler({ ...args, terminalId: 't-acme' }, { server: 'genie', tool: 'sites', headers: {} });
    return { ...r, json: JSON.parse(r.text) as Record<string, any> };
}

async function asked(): Promise<{ id: string; title: string }> {
    for (let i = 0; i < 200 && services.approvals.deckItems().length === 0; i++) await new Promise((r) => setTimeout(r, 0));
    const [item] = services.approvals.deckItems();
    expect(item).toBeDefined();
    return { id: item!.id, title: item!.title };
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-php-pin-edit-'));
    acme = join(dir, 'acme.example');
    phpRoot = join(dir, 'genie2-toolchain', 'php-versions');
    await mkdir(join(acme, 'repos', 'shop'), { recursive: true });
    await writeFile(join(acme, 'project.json'), `${JSON.stringify({
        name: 'Acme',
        repos: [{ name: 'Shop', slug: 'shop', path: 'repos/shop' }],
        sites: { aaaa000000000001: { repo: 'shop', runMode: 'host', kind: 'http', enabled: true, name: 'shop', genName: 'shop.gen', framework: 'laravel', hostServe: { mode: 'php', root: 'public', version: '8.4' } } },
    }, null, 2)}\n`, 'utf8');
    opened.length = 0;
    services = await composeServices({
        userData: join(dir, 'genie-home'), pty, v1Settings: () => null, caddyBin: '/opt/genie/runtime/caddy', frontDoorPort: 0, hostsIo, trustStore,
        elevate: async () => ({ ok: true }), hostsDebounceMs: 1, frontDoorPorts: { probe: async () => 'free', holder: async () => null },
        workspaces: () => [{ id: 'acme', path: acme }],
        resolvePhpCgi: (pin) => resolvePhpCgi(pin, { platform: 'win32', root: phpRoot, fs: phpFs() }),
        // One worker: these tests are about the pin; several workers are test/php-fast.test.ts's.
        phpWorkers: 1,
    } as Parameters<typeof composeServices>[0]);
    await settle();
    caller = { agentId: mintAgentId(), agentName: 'atlas', workspaceId: 'acme', workspacePath: acme };
    tools = hostingTools({ resolveCaller: (id) => (id === 't-acme' ? caller : null), approve: (c, a, d) => services.approvals.gate(c, a, d), services });
});

afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true });
});

describe('Edit carries the pin', () => {
    it('the pinned site is served on its managed PHP — the control every claim below rides on', () => {
        expect(services.sites.get('site_shop')).toMatchObject({ state: 'running', serve: { mode: 'php', root: 'public', version: '8.4' } });
        // `8.4` is a LINE: the newest 8.4.x Genie manages.
        expect(workers()).toEqual([cgiOf('8.4.26')]);
    });

    it('Edit opens on the pin, with the versions Add offers; saving a change to something else KEEPS hostServe.version — counted', async () => {
        const snap = await handleFeatureAction(services, { kind: 'hosting.editSite', siteId: 'site_shop' }, state(), ports());
        const editing = snap.hosting!.editing!;
        expect(editing.defaults).toMatchObject({ name: 'shop', mode: 'php', root: 'public', phpVersion: '8.4' });
        expect(editing.phpVersions).toEqual(MANAGED);

        // The person renames it and saves: the form sends back what it opened on, with the one change.
        await handleFeatureAction(services, { kind: 'hosting.updateSite', siteId: 'site_shop', form: { ...editing.defaults, name: 'store' } }, { ...state(), siteEditing: editing }, ports());
        const manifest = await manifestOf();
        expect(Object.values(manifest.sites).map((e) => e.hostServe?.version)).toEqual(['8.4']);
        expect(await shopEntry()).toMatchObject({ name: 'store', genName: 'store.gen', framework: 'laravel', hostServe: { mode: 'php', root: 'public', version: '8.4' } });
        // Re-served as edited — on the SAME managed PHP, never the PATH one.
        expect(services.sites.get('site_store')).toMatchObject({ state: 'running', serve: { mode: 'php', version: '8.4' } });
        expect(workers()).toEqual([cgiOf('8.4.26'), cgiOf('8.4.26')]);
    });

    it('Edit CHANGES the pin: project.json says the new version, and the re-served site — and a Restart — starts that version’s php-cgi', async () => {
        const target = (await handleFeatureAction(services, { kind: 'hosting.editSite', siteId: 'site_shop' }, state(), ports())).hosting!.editing!;
        const snap = await handleFeatureAction(services, { kind: 'hosting.updateSite', siteId: 'site_shop', form: { ...target.defaults, phpVersion: '8.5.11' } }, { ...state(), siteEditing: target }, ports());
        expect(snap.hosting!.editing).toBeNull();
        expect((await shopEntry()).hostServe).toEqual({ mode: 'php', root: 'public', version: '8.5.11' });
        expect(workers()).toEqual([cgiOf('8.4.26'), cgiOf('8.5.11')]);
        await handleFeatureAction(services, { kind: 'hosting.restartSite', siteId: 'site_shop' }, state(), ports());
        expect(workers()).toEqual([cgiOf('8.4.26'), cgiOf('8.5.11'), cgiOf('8.5.11')]);
    });

    it('Edit back to the PHP on PATH drops the pin from project.json and serves `php-cgi` (the pin is the person’s to clear)', async () => {
        const target = (await handleFeatureAction(services, { kind: 'hosting.editSite', siteId: 'site_shop' }, state(), ports())).hosting!.editing!;
        await handleFeatureAction(services, { kind: 'hosting.updateSite', siteId: 'site_shop', form: { ...target.defaults, phpVersion: null } }, { ...state(), siteEditing: target }, ports());
        expect((await shopEntry()).hostServe).toEqual({ mode: 'php', root: 'public' });
        expect(workers()).toEqual([cgiOf('8.4.26'), 'php-cgi']);
    });
});

describe('the agents’ `sites` tool carries the pin', () => {
    it('update {phpVersion} ASKS the person, naming the change; allowed, it is written and the site runs that version', async () => {
        const pending = call({ action: 'update', site: 'shop', phpVersion: '8.5' });
        const item = await asked();
        expect(item.title).toBe('atlas wants to change a site: shop.gen — PHP version PHP 8.4 → PHP 8.5 — written to this workspace’s project.json and served as changed');
        services.approvals.resolve(item.id, 'allow');
        const r = await pending;
        expect(r.isError).toBe(false);
        expect((await shopEntry()).hostServe).toEqual({ mode: 'php', root: 'public', version: '8.5' });
        expect(workers()).toEqual([cgiOf('8.4.26'), cgiOf('8.5.11')]);
    });

    it('update to a version Genie does NOT manage is refused with the start’s reason, WITHOUT asking — zero approvals, nothing written or spawned', async () => {
        const fileBefore = await readFile(join(acme, 'project.json'), 'utf8');
        const spawnsBefore = opened.length;
        const r = await call({ action: 'update', site: 'shop', phpVersion: '7.4' });
        expect(r.isError).toBe(true);
        expect(r.json.error).toBe('this site is pinned to PHP 7.4, which Genie does not manage on this machine. Install it in Toolchain → PHP versions, or pin the site to one Genie manages: 8.5.11, 8.4.26');
        expect((r.json.problems as Array<{ field: string }>).map((p) => p.field)).toEqual(['phpVersion']);
        expect(services.approvals.deckItems()).toHaveLength(0);
        expect(await readFile(join(acme, 'project.json'), 'utf8')).toBe(fileBefore);
        expect(opened.length).toBe(spawnsBefore);
        // Control: a managed version is put to the person (one approval).
        const pending = call({ action: 'update', site: 'shop', phpVersion: '8.5.11' });
        services.approvals.resolve((await asked()).id, 'deny');
        expect((await pending).json.error).toMatch(/denied/);
    });

    it('update of something else keeps the pin (the agent never names phpVersion) — counted in project.json', async () => {
        const pending = call({ action: 'update', site: 'shop', root: 'web' });
        const item = await asked();
        expect(item.title).not.toMatch(/PHP version/);
        services.approvals.resolve(item.id, 'allow');
        expect((await pending).isError).toBe(false);
        expect((await shopEntry()).hostServe).toEqual({ mode: 'php', root: 'web', version: '8.4' });
    });

    it('add {phpVersion}: a managed version is served pinned; an unmanaged one is refused with the start’s reason and nothing is created', async () => {
        await mkdir(join(acme, 'repos', 'blog'), { recursive: true });
        const refused = await call({ action: 'add', name: 'blog', repoPath: 'repos/blog', mode: 'php', root: 'public', phpVersion: '7.4' });
        expect(refused.isError).toBe(true);
        expect(refused.json.error).toMatch(/^this site is pinned to PHP 7\.4, which Genie does not manage on this machine/);
        expect(services.sites.list().map((s) => s.host)).toEqual(['shop.gen']);
        expect(Object.keys((await manifestOf()).sites)).toHaveLength(1);
        expect(services.approvals.deckItems()).toHaveLength(0);

        const r = await call({ action: 'add', name: 'blog', repoPath: 'repos/blog', mode: 'php', root: 'public', phpVersion: '8.5' });
        expect(r.isError).toBe(false);
        const blog = Object.values((await manifestOf()).sites).find((e) => e.genName === 'blog.gen')!;
        expect(blog.hostServe).toEqual({ mode: 'php', root: 'public', version: '8.5' });
        expect(workers().at(-1)).toBe(cgiOf('8.5.11'));
    });
});

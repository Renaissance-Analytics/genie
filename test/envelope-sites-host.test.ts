import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatLike, withSiteEntry } from '../src/core/envelope-sites.js';
import { EnvelopeSites, type EnvelopeSitesPorts } from '../src/main/envelope-sites-host.js';
import { ProcessSupervisor } from '../src/main/process-supervisor.js';
import { SiteManager } from '../src/main/site-manager.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * THE ENVELOPE'S SITES, MAIN-SIDE — the failure paths and what a write might LOOSEN. A write that fails
 * never leaves Genie claiming a site it did not keep (create) or dropping one it did not delete (remove); an
 * unreadable manifest or stops-record is named and does not take the other workspaces down; and a write
 * changes the `sites` key and nothing else — the other keys (a Tynn token, the repos, hosting) byte-for-byte,
 * in the file's own CRLF and 4-space style. Invented names throughout.
 */

const W = (name: string) => join('/ws', name);

function harness(files: Record<string, string>, over: { failWrite?: boolean; stops?: string[] | Error } = {}) {
    const fs = new Map(Object.entries(files));
    const dirs = new Set<string>();
    const opened: string[] = [];
    const logs: string[] = [];
    const saved: string[][] = [];
    const pty: PtyPort = {
        open: (o) => { opened.push(`${o.cwd} :: ${o.command}`); return { id: `t${opened.length}`, pid: 1, shell: 'sh', scrollback: '' }; },
        write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
    };
    let port = 4100;
    const sites = new SiteManager({ supervisor: new ProcessSupervisor(pty, { now: () => 0, schedule: () => () => {} }), allocatePort: () => ++port, caddyBin: '/opt/caddy', configDir: '/cfg', writeConfig: () => {} });
    const ports: EnvelopeSitesPorts = {
        fs: {
            readText: async (p) => fs.get(p) ?? null,
            writeTextAtomic: async (p, text) => { if (over.failWrite) throw new Error('EROFS: read-only file system'); fs.set(p, text); },
            exists: async (p) => dirs.has(p) || fs.has(p),
        },
        runState: {
            load: async () => { if (over.stops instanceof Error) throw over.stops; return over.stops ?? []; },
            save: async (s) => { saved.push([...s]); },
        },
        envFor: () => ({}),
        log: (l) => logs.push(l),
    };
    return { fs, dirs, opened, logs, saved, sites, envelope: new EnvelopeSites(sites, ports) };
}

const manifest = (sites: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    $schema: 'https://example.invalid/project.schema.json',
    name: 'Acme',
    tynnToken: 'tok-example-not-real',
    repos: [{ name: 'shop', slug: 'shop', path: 'repos/shop' }],
    sites,
    hosting: { enabled: true, type: 'static' },
    ...extra,
});
const shop = { repo: 'shop', runMode: 'host', kind: 'http', enabled: true, name: 'shop', genName: 'shop.gen', hostServe: { mode: 'php', root: 'public' } };

describe('a write never changes anything but `sites`', () => {
    it('create into a CRLF, 4-space project.json: taking the new entry back out gives the ORIGINAL BYTES', async () => {
        const original = formatLike('{\r\n    "x": 0\r\n}\r\n', manifest({ k1: shop }));
        const h = harness({ [join(W('acme'), 'project.json')]: original });
        h.dirs.add(join(W('acme'), 'repos', 'shop'));
        await h.envelope.sync([{ id: 'acme', path: W('acme') }]);
        await h.envelope.create({ name: 'fresh', workspaceId: 'acme', repoPath: join(W('acme'), 'repos', 'shop'), serve: { mode: 'proxy' }, hostPort: 7001 });
        const after = h.fs.get(join(W('acme'), 'project.json'))!;
        expect(after).not.toBe(original);
        expect(after).toContain('\r\n    "tynnToken": "tok-example-not-real",\r\n');
        const parsed = JSON.parse(after) as Record<string, unknown> & { sites: Record<string, unknown> };
        const added = Object.keys(parsed.sites).filter((k) => k !== 'k1');
        expect(added).toHaveLength(1);
        expect(formatLike(after, withSiteEntry(parsed, added[0]!, null))).toBe(original);
    });

    it('remove deletes its key and nothing else: re-adding the entry gives the original bytes', async () => {
        const original = formatLike('{\n  "x": 0\n}\n', manifest({ k1: shop, k2: { ...shop, name: 'two', genName: 'two.gen' } }));
        const h = harness({ [join(W('acme'), 'project.json')]: original });
        h.dirs.add(join(W('acme'), 'repos', 'shop'));
        await h.envelope.sync([{ id: 'acme', path: W('acme') }]);
        expect(await h.envelope.remove('site_two')).toBe(true);
        const after = JSON.parse(h.fs.get(join(W('acme'), 'project.json'))!) as Record<string, unknown>;
        expect(formatLike(original, withSiteEntry(after, 'k2', { ...shop, name: 'two', genName: 'two.gen' }))).toBe(original);
    });
});

describe('a failed write is not a kept site', () => {
    it('create: the write fails → the site is removed again, its processes stopped, and the failure thrown', async () => {
        const h = harness({ [join(W('acme'), 'project.json')]: JSON.stringify(manifest({})) }, { failWrite: true });
        await h.envelope.sync([{ id: 'acme', path: W('acme') }]);
        await expect(h.envelope.create({ name: 'fresh', workspaceId: 'acme', repoPath: W('acme'), serve: { mode: 'proxy' }, devServer: { stack: 'node', command: 'npm start -- --port {port}' } })).rejects.toThrow(/fresh\.gen was not kept.*EROFS/);
        expect(h.sites.list()).toEqual([]);
        // Positive control: the start did happen before the write was refused.
        expect(h.opened).toHaveLength(1);
    });

    it('remove: the write fails → the site is still there and still listed', async () => {
        const h = harness({ [join(W('acme'), 'project.json')]: JSON.stringify(manifest({ k1: shop })) }, { failWrite: true });
        h.dirs.add(join(W('acme'), 'repos', 'shop'));
        await h.envelope.sync([{ id: 'acme', path: W('acme') }]);
        await expect(h.envelope.remove('site_shop')).rejects.toThrow(/EROFS/);
        expect(h.sites.get('site_shop')).toMatchObject({ state: 'running' });
    });

    it('a workspace with no project.json is told to convert; a folder outside the workspace is refused; nothing starts', async () => {
        const h = harness({ [join(W('acme'), 'project.json')]: JSON.stringify(manifest({})) });
        await h.envelope.sync([{ id: 'acme', path: W('acme') }, { id: 'bare', path: W('bare') }]);
        await expect(h.envelope.create({ name: 'a', workspaceId: 'bare', repoPath: W('bare'), serve: { mode: 'proxy' }, hostPort: 1 })).rejects.toThrow(/no project\.json/);
        await expect(h.envelope.create({ name: 'b', workspaceId: 'acme', repoPath: W('elsewhere'), serve: { mode: 'proxy' }, hostPort: 1 })).rejects.toThrow(/outside it/);
        await expect(h.envelope.create({ name: 'c', workspaceId: 'ghost', repoPath: W('ghost'), serve: { mode: 'proxy' }, hostPort: 1 })).rejects.toThrow(/no workspace ghost/);
        expect(h.sites.list()).toEqual([]);
    });
});

describe('what cannot be read is named, and the rest still loads', () => {
    it('a malformed project.json is logged; the other workspace’s sites are listed and started', async () => {
        const h = harness({ [join(W('broken'), 'project.json')]: '{ "sites": ', [join(W('acme'), 'project.json')]: JSON.stringify(manifest({ k1: shop })) });
        h.dirs.add(join(W('acme'), 'repos', 'shop'));
        await h.envelope.sync([{ id: 'broken', path: W('broken') }, { id: 'acme', path: W('acme') }]);
        expect(h.logs.join('\n')).toMatch(/broken.*project\.json could not be read/);
        expect(h.sites.list().map((s) => [s.host, s.state])).toEqual([['shop.gen', 'running']]);
    });

    it('an unreadable stops record is logged and nothing counts as stopped', async () => {
        const h = harness({ [join(W('acme'), 'project.json')]: JSON.stringify(manifest({ k1: shop })) }, { stops: new Error('EACCES') });
        h.dirs.add(join(W('acme'), 'repos', 'shop'));
        await h.envelope.sync([{ id: 'acme', path: W('acme') }]);
        expect(h.logs.join('\n')).toMatch(/stopped-sites record could not be read/);
        expect(h.sites.get('site_shop')).toMatchObject({ state: 'running' });
    });

    it('a remembered stop is honoured at load, and only that site', async () => {
        const h = harness({ [join(W('acme'), 'project.json')]: JSON.stringify(manifest({ k1: shop, k2: { ...shop, name: 'two', genName: 'two.gen' } })) }, { stops: ['acme/k1'] });
        h.dirs.add(join(W('acme'), 'repos', 'shop'));
        await h.envelope.sync([{ id: 'acme', path: W('acme') }]);
        expect(h.sites.get('site_shop')).toMatchObject({ state: 'stopped' });
        expect(h.sites.get('site_two')).toMatchObject({ state: 'running' });
        await h.envelope.start('site_shop');
        expect(h.saved.at(-1)).toEqual([]);
        await h.envelope.stop('site_two');
        expect(h.saved.at(-1)).toEqual(['acme/k2']);
    });

    it('a folder that is not there, and a name another workspace already serves, are listed with why', async () => {
        const h = harness({
            [join(W('acme'), 'project.json')]: JSON.stringify(manifest({ k1: shop })),
            [join(W('beta'), 'project.json')]: JSON.stringify(manifest({ k9: shop, k8: { ...shop, repo: 'gone', name: 'gone', genName: 'gone.gen' } })),
        });
        h.dirs.add(join(W('acme'), 'repos', 'shop'));
        h.dirs.add(join(W('beta'), 'repos', 'shop'));
        await h.envelope.sync([{ id: 'acme', path: W('acme') }, { id: 'beta', path: W('beta') }]);
        const beta = h.sites.list('beta');
        expect(beta.map((s) => [s.host, s.state])).toEqual([['shop.gen', 'unservable'], ['gone.gen', 'unservable']]);
        expect(beta[0]!.problem).toMatch(/shop\.gen is already a site/);
        expect(beta[1]!.problem).toMatch(/repos\/gone does not exist/);
    });
});

describe('workspaces coming and going', () => {
    it('a workspace no longer registered: its sites are stopped and forgotten, its envelope untouched', async () => {
        const text = JSON.stringify(manifest({ k1: shop }));
        const h = harness({ [join(W('acme'), 'project.json')]: text });
        h.dirs.add(join(W('acme'), 'repos', 'shop'));
        await h.envelope.sync([{ id: 'acme', path: W('acme') }]);
        expect(h.sites.list()).toHaveLength(1);
        await h.envelope.sync([]);
        expect(h.sites.list()).toEqual([]);
        expect(h.fs.get(join(W('acme'), 'project.json'))).toBe(text);
    });

    it('going to sleep starts and stops nothing by itself (hibernation stops the processes); waking starts the enabled ones once', async () => {
        const h = harness({ [join(W('acme'), 'project.json')]: JSON.stringify(manifest({ k1: shop, k2: { ...shop, enabled: false, name: 'off', genName: 'off.gen' } })) });
        h.dirs.add(join(W('acme'), 'repos', 'shop'));
        await h.envelope.sync([{ id: 'acme', path: W('acme'), asleep: true }]);
        expect(h.opened).toHaveLength(0);
        await h.envelope.sync([{ id: 'acme', path: W('acme'), asleep: false }]);
        expect(h.opened).toHaveLength(2); // php-cgi + caddy for shop; `off` stays off
        await h.envelope.sync([{ id: 'acme', path: W('acme'), asleep: false }]);
        expect(h.opened).toHaveLength(2);
        expect(h.sites.get('site_off')).toMatchObject({ state: 'stopped' });
    });
});

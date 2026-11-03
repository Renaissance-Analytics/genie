import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { firstStartWords, readEnvelopeSites, siteRunFingerprint, type ServableSite } from '../src/core/envelope-sites.js';
import { EnvelopeSites, type EnvelopeSitesPorts, type WorkspaceRef } from '../src/main/envelope-sites-host.js';
import { ProcessSupervisor } from '../src/main/process-supervisor.js';
import { SiteManager } from '../src/main/site-manager.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * A SITE RUNS ON THIS MACHINE ONCE THE PERSON HAS STARTED IT HERE. A site first seen in a project.json is listed and stays
 * down until the person starts it once; its row names exactly what the start runs. After that it follows the usual launch
 * rule, until what it runs changes. Workspaces already registered when this rule arrives carry over once, so nobody's own
 * sites stop at the upgrade. Invented names throughout; every "nothing ran" has a control where something did.
 */

const W = (name: string) => join('/ws', name);
const PROJECT = (name: string) => join(W(name), 'project.json');

const siteEntry = (name: string, command: string[], over: Record<string, unknown> = {}) => ({ repo: '', runMode: 'host', kind: 'http', enabled: true, name, genName: `${name}.gen`, command, ...over });
const manifestOf = (sites: Record<string, unknown>) => JSON.stringify({ name: 'Acme', sites });

/** What survives a launch: the files, and the record on this machine. Each `launch()` is a new Genie over them. */
function machine(files: Record<string, string>, over: { record?: unknown; recordUnreadable?: boolean; missing?: string[] } = {}) {
    const fs = new Map(Object.entries(files));
    const state = { record: over.record ?? null, saves: 0, stops: [] as string[], missing: new Set(over.missing ?? []), saveFails: false };
    const launch = () => {
        const opened: string[] = [];
        const logs: string[] = [];
        const pty: PtyPort = {
            open: (o) => { opened.push(o.command ?? ''); return { id: `t${opened.length}`, pid: 1, shell: 'sh', scrollback: '' }; },
            write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
        };
        let port = 4100;
        const sites = new SiteManager({ supervisor: new ProcessSupervisor(pty, { now: () => 0, schedule: () => () => {} }), allocatePort: () => ++port, caddyBin: '/opt/caddy', configDir: '/cfg', writeConfig: () => {}, phpWorkers: 1 });
        const ports: EnvelopeSitesPorts = {
            fs: {
                readText: async (p) => fs.get(p) ?? null,
                writeTextAtomic: async (p, text) => { fs.set(p, text); },
                exists: async (p) => !state.missing.has(p),
            },
            runState: { load: async () => state.stops, save: async (s) => { state.stops = [...s]; } },
            trust: {
                load: async () => { if (over.recordUnreadable && state.saves === 0) throw new Error('not valid JSON'); return state.record; },
                save: async (book) => { if (state.saveFails) throw new Error('EROFS: read-only file system'); state.record = JSON.parse(JSON.stringify(book)); state.saves += 1; },
            },
            envFor: () => ({}),
            log: (l) => logs.push(l),
        };
        const ran = (needle: string) => opened.some((c) => c.includes(needle));
        return { sites, envelope: new EnvelopeSites(sites, ports), opened, logs, ran };
    };
    return { fs, state, launch };
}

const acme: WorkspaceRef = { id: 'ws_acme', path: W('acme') };
const noWorkspaces: readonly WorkspaceRef[] = [];
const webFiles = (command = ['serve-it', '--port=9000']) => ({ [PROJECT('acme')]: manifestOf({ k1: siteEntry('web', command) }) });

/** A machine past its upgrade: the record exists and carried nothing over. */
const settled = async (files: Record<string, string>) => {
    const m = machine(files);
    await m.launch().envelope.sync(noWorkspaces);
    return m;
};

describe('a site first seen on this machine', () => {
    it('is listed, runs nothing, and its row says exactly what Start would run', async () => {
        const m = await settled(webFiles());
        const g = m.launch();
        await g.envelope.sync([acme]);
        expect(g.opened).toEqual([]);
        const [site] = g.sites.list();
        expect(site?.host).toBe('web.gen');
        expect(site?.state).toBe('stopped');
        expect(site?.firstStart?.runs).toContain('serve-it --port={port}');
        expect(site?.firstStart?.changed).toBe(false);
    });

    it('a workspace added while Genie is up waits the same way', async () => {
        const m = await settled(webFiles());
        const g = m.launch();
        await g.envelope.sync(noWorkspaces);
        await g.envelope.sync([acme]);
        expect(g.opened).toEqual([]);
        expect(g.sites.list()[0]?.firstStart).toBeDefined();
    });

    it('nothing but the person can start it: an agent\'s start and restart are refused, and name the way forward', async () => {
        const m = await settled(webFiles());
        const g = m.launch();
        await g.envelope.sync([acme]);
        const id = g.sites.list()[0]!.id;
        await expect(g.envelope.start(id)).rejects.toThrow(/person/);
        await expect(g.envelope.restart(id)).rejects.toThrow(/person/);
        expect(() => g.sites.start(id)).toThrow(/person/);
        expect(() => g.sites.restart(id)).toThrow(/person/);
        expect(g.opened).toEqual([]);
        // The control: the same site, the person's Start.
        await g.envelope.start(id, { person: true });
        expect(g.ran('serve-it')).toBe(true);
    });

    it('an agent cannot edit its way past the wait; the person can edit it and it still waits, naming the new command', async () => {
        const m = await settled(webFiles());
        const g = m.launch();
        await g.envelope.sync([acme]);
        const site = g.sites.list()[0]!;
        const input = { name: 'web', workspaceId: 'ws_acme', repoPath: W('acme'), serve: { mode: 'proxy' as const }, devServer: { stack: 'node' as const, command: 'other-thing --port={port}' } };
        await expect(g.envelope.update(site.id, input)).rejects.toThrow(/person/);
        expect(g.opened).toEqual([]);
        await g.envelope.update(site.id, input, { person: true });
        expect(g.opened).toEqual([]);
        const after = g.sites.list()[0]!;
        expect(after.firstStart?.runs).toContain('other-thing');
        await g.envelope.start(after.id, { person: true });
        expect(g.ran('other-thing')).toBe(true);
    });

    it('waking its workspace does not start it', async () => {
        const m = await settled(webFiles());
        const g = m.launch();
        await g.envelope.sync([{ ...acme, asleep: true }]);
        await g.envelope.sync([acme]);
        expect(g.opened).toEqual([]);
        expect(g.sites.list()[0]?.firstStart).toBeDefined();
    });
});

describe('once the person has started it here', () => {
    const startedOnce = async (files: Record<string, string> = webFiles()) => {
        const m = await settled(files);
        const g = m.launch();
        await g.envelope.sync([acme]);
        await g.envelope.start(g.sites.list()[0]!.id, { person: true });
        return m;
    };

    it('the row stops asking, and the next launch starts it by the usual rule', async () => {
        const m = await startedOnce();
        const next = m.launch();
        await next.envelope.sync([acme]);
        expect(next.ran('serve-it')).toBe(true);
        expect(next.sites.list()[0]?.firstStart).toBeUndefined();
    });

    it('a Restart by the person counts the same as a Start', async () => {
        const m = await settled(webFiles());
        const g = m.launch();
        await g.envelope.sync([acme]);
        await g.envelope.restart(g.sites.list()[0]!.id, { person: true });
        expect(g.ran('serve-it')).toBe(true);
        const next = m.launch();
        await next.envelope.sync([acme]);
        expect(next.ran('serve-it')).toBe(true);
    });

    it('a changed command waits again, says it changed, and the new command is what it names', async () => {
        const m = await startedOnce();
        m.fs.set(PROJECT('acme'), webFiles(['different-thing', '--port=9000'])[PROJECT('acme')]!);
        const next = m.launch();
        await next.envelope.sync([acme]);
        expect(next.opened).toEqual([]);
        const site = next.sites.list()[0]!;
        expect(site.firstStart?.changed).toBe(true);
        expect(site.firstStart?.runs).toContain('different-thing');
    });

    it.each([
        ['its folder', { repo: 'other' }],
        ['how it is served', { command: undefined, hostServe: { mode: 'php', root: 'public' } }],
    ])('changing %s waits again', async (_what, change) => {
        const m = await startedOnce();
        m.fs.set(PROJECT('acme'), manifestOf({ k1: siteEntry('web', ['serve-it', '--port=9000'], change) }));
        const next = m.launch();
        await next.envelope.sync([acme]);
        expect(next.opened).toEqual([]);
        expect(next.sites.list()[0]?.firstStart?.changed).toBe(true);
    });

    it('a second site added to the same workspace waits, and the first still starts', async () => {
        const m = await startedOnce();
        m.fs.set(PROJECT('acme'), manifestOf({ k1: siteEntry('web', ['serve-it', '--port=9000']), k2: siteEntry('api', ['another-thing', '--port=9000']) }));
        const next = m.launch();
        await next.envelope.sync([acme]);
        expect(next.ran('serve-it')).toBe(true);
        expect(next.ran('another-thing')).toBe(false);
    });

    it('the same key in another workspace is a different site', async () => {
        const m = await startedOnce();
        m.fs.set(PROJECT('other'), manifestOf({ k1: siteEntry('web2', ['serve-it', '--port=9000']) }));
        const next = m.launch();
        await next.envelope.sync([{ id: 'ws_other', path: W('other') }]);
        expect(next.opened).toEqual([]);
    });

    it('removing the site forgets it: declared again, it waits', async () => {
        const m = await startedOnce();
        const g = m.launch();
        await g.envelope.sync([acme]);
        await g.envelope.remove(g.sites.list()[0]!.id);
        m.fs.set(PROJECT('acme'), webFiles()[PROJECT('acme')]!);
        const next = m.launch();
        await next.envelope.sync([acme]);
        expect(next.opened).toEqual([]);
    });

    it('removing the workspace forgets its sites: added again, they wait', async () => {
        const m = await startedOnce();
        const g = m.launch();
        await g.envelope.sync([acme]);
        await g.envelope.sync(noWorkspaces);
        const next = m.launch();
        await next.envelope.sync([acme]);
        expect(next.opened).toEqual([]);
    });
});

describe('a site made here', () => {
    it('created in Hosting: it starts, never asks, and starts on the next launch', async () => {
        const m = await settled({ [PROJECT('acme')]: manifestOf({}) });
        const g = m.launch();
        await g.envelope.sync([acme]);
        await g.envelope.create({ name: 'mine', workspaceId: 'ws_acme', repoPath: W('acme'), serve: { mode: 'proxy' }, devServer: { stack: 'node', command: 'my-server --port={port}' } });
        expect(g.ran('my-server')).toBe(true);
        expect(g.sites.list()[0]?.firstStart).toBeUndefined();
        const next = m.launch();
        await next.envelope.sync([acme]);
        expect(next.ran('my-server')).toBe(true);
        expect(next.sites.list()[0]?.firstStart).toBeUndefined();
    });

    it('edited in Hosting while running: it comes back as edited, and the edit is what the next launch runs', async () => {
        const m = await settled(webFiles());
        const g = m.launch();
        await g.envelope.sync([acme]);
        await g.envelope.start(g.sites.list()[0]!.id, { person: true });
        await g.envelope.update(g.sites.list()[0]!.id, { name: 'web', workspaceId: 'ws_acme', repoPath: W('acme'), serve: { mode: 'proxy' }, devServer: { stack: 'node', command: 'edited-server --port={port}' } }, { person: true });
        expect(g.ran('edited-server')).toBe(true);
        const next = m.launch();
        await next.envelope.sync([acme]);
        expect(next.ran('edited-server')).toBe(true);
    });
});

describe('the upgrade: what was already here carries over, once', () => {
    it('a registered workspace\'s enabled site keeps starting, on this launch and the next', async () => {
        const m = machine(webFiles());
        const first = m.launch();
        await first.envelope.sync([acme]);
        expect(first.ran('serve-it')).toBe(true);
        expect(first.sites.list()[0]?.firstStart).toBeUndefined();
        const second = m.launch();
        await second.envelope.sync([acme]);
        expect(second.ran('serve-it')).toBe(true);
    });

    it('carrying over is once: a workspace added on the same launch, and a site pulled in afterwards, wait', async () => {
        const m = machine(webFiles());
        m.fs.set(PROJECT('later'), manifestOf({ k9: siteEntry('later', ['later-thing', '--port=9000']) }));
        const first = m.launch();
        await first.envelope.sync([acme]);
        await first.envelope.sync([acme, { id: 'ws_later', path: W('later') }]);
        expect(first.ran('later-thing')).toBe(false);
        m.fs.set(PROJECT('acme'), manifestOf({ k1: siteEntry('web', ['serve-it', '--port=9000']), k2: siteEntry('api', ['pulled-thing', '--port=9000']) }));
        const second = m.launch();
        await second.envelope.sync([acme]);
        expect(second.ran('serve-it')).toBe(true);
        expect(second.ran('pulled-thing')).toBe(false);
    });

    it('a site the person stopped stays stopped, and does not ask', async () => {
        const m = machine(webFiles());
        m.state.stops = ['ws_acme/k1'];
        const g = m.launch();
        await g.envelope.sync([acme]);
        expect(g.opened).toEqual([]);
        expect(g.sites.list()[0]?.firstStart).toBeUndefined();
        await g.envelope.start(g.sites.list()[0]!.id);
        expect(g.ran('serve-it')).toBe(true);
    });

    it('a hibernating workspace\'s site starts when it wakes', async () => {
        const m = machine(webFiles());
        const g = m.launch();
        await g.envelope.sync([{ ...acme, asleep: true }]);
        expect(g.opened).toEqual([]);
        await g.envelope.sync([acme]);
        expect(g.ran('serve-it')).toBe(true);
    });

    it('a disabled site never ran, so it is not carried: turned on later, it waits', async () => {
        const m = machine({ [PROJECT('acme')]: manifestOf({ k1: siteEntry('web', ['serve-it', '--port=9000'], { enabled: false }) }) });
        const g = m.launch();
        await g.envelope.sync([acme]);
        expect(g.opened).toEqual([]);
        m.fs.set(PROJECT('acme'), webFiles()[PROJECT('acme')]!);
        const next = m.launch();
        await next.envelope.sync([acme]);
        expect(next.opened).toEqual([]);
        expect(next.sites.list()[0]?.firstStart).toBeDefined();
    });

    it('a site whose folder is away at the upgrade is carried, and starts when the folder is back', async () => {
        const m = machine({ [PROJECT('acme')]: manifestOf({ k1: siteEntry('web', ['serve-it', '--port=9000'], { repo: 'shop' }) }) }, { missing: [join(W('acme'), 'repos', 'shop')] });
        const first = m.launch();
        await first.envelope.sync([acme]);
        expect(first.opened).toEqual([]);
        m.state.missing.clear();
        const second = m.launch();
        await second.envelope.sync([acme]);
        expect(second.ran('serve-it')).toBe(true);
    });

    it('a workspace whose project.json cannot be read at the upgrade is still carried when it can be', async () => {
        const m = machine({ [PROJECT('acme')]: '{ not json' });
        const first = m.launch();
        await first.envelope.sync([acme]);
        expect(first.opened).toEqual([]);
        m.fs.set(PROJECT('acme'), webFiles()[PROJECT('acme')]!);
        const second = m.launch();
        await second.envelope.sync([acme]);
        expect(second.ran('serve-it')).toBe(true);
    });

    it('a workspace whose folder is away at the upgrade is still carried when it is back', async () => {
        const m = machine({}, { missing: [W('acme')] });
        const first = m.launch();
        await first.envelope.sync([acme]);
        expect(first.opened).toEqual([]);
        m.state.missing.clear();
        m.fs.set(PROJECT('acme'), webFiles()[PROJECT('acme')]!);
        const second = m.launch();
        await second.envelope.sync([acme]);
        expect(second.ran('serve-it')).toBe(true);
    });

    it('a workspace that had no project.json at the upgrade is finished: one added later waits', async () => {
        const m = machine({});
        await m.launch().envelope.sync([acme]);
        m.fs.set(PROJECT('acme'), webFiles()[PROJECT('acme')]!);
        const second = m.launch();
        await second.envelope.sync([acme]);
        expect(second.opened).toEqual([]);
    });

    it('a new install carries nothing: the first workspace it ever adds waits', async () => {
        const m = machine(webFiles());
        const g = m.launch();
        await g.envelope.sync(noWorkspaces);
        await g.envelope.sync([acme]);
        expect(g.opened).toEqual([]);
        expect(g.sites.list()[0]?.firstStart).toBeDefined();
    });

    it('records which workspaces carried over, for the wider check to read, in the same record', async () => {
        const m = machine(webFiles());
        await m.launch().envelope.sync([acme]);
        expect(m.state.record).toMatchObject({ version: 1, carried: ['ws_acme'], pendingCarry: [] });
    });
});

describe('a record that cannot be believed asks rather than assumes', () => {
    it.each([
        ['unreadable', { recordUnreadable: true }],
        ['the wrong shape', { record: { sites: 'everything' } }],
        ['values that are not text', { record: { version: 1, carried: [], pendingCarry: [], sites: { 'ws_acme/k1': 1 } } }],
    ])('%s: nothing carries over, the row waits, and it is named in the log', async (_what, over) => {
        const m = machine(webFiles(), over);
        const g = m.launch();
        await g.envelope.sync([acme]);
        expect(g.opened).toEqual([]);
        expect(g.sites.list()[0]?.firstStart).toBeDefined();
        expect(g.logs.join('\n')).toMatch(/could not be believed|could not be read/);
        // The way out still works.
        await g.envelope.start(g.sites.list()[0]!.id, { person: true });
        expect(g.ran('serve-it')).toBe(true);
    });

    it('a record written with another fingerprint for the site waits, as changed', async () => {
        const m = machine(webFiles(), { record: { version: 1, carried: [], pendingCarry: [], sites: { 'ws_acme/k1': 'not-this-one' } } });
        const g = m.launch();
        await g.envelope.sync([acme]);
        expect(g.opened).toEqual([]);
        expect(g.sites.list()[0]?.firstStart?.changed).toBe(true);
    });

    it('a record that could not be saved does not stop the person\'s start', async () => {
        const m = await settled(webFiles());
        const g = m.launch();
        await g.envelope.sync([acme]);
        m.state.saveFails = true;
        await g.envelope.start(g.sites.list()[0]!.id, { person: true });
        expect(g.ran('serve-it')).toBe(true);
        expect(g.logs.join('\n')).toMatch(/could not be saved/);
        // It was not recorded, so the next launch asks again rather than assuming.
        m.state.saveFails = false;
        const next = m.launch();
        await next.envelope.sync([acme]);
        expect(next.ran('serve-it')).toBe(false);
    });
});

describe('what the row says is what runs', () => {
    const one = (entry: Record<string, unknown>): ServableSite => readEnvelopeSites({ sites: { k: entry } })[0] as ServableSite;

    it('names the command and the folder for a dev server', () => {
        expect(firstStartWords(one(siteEntry('web', ['serve-it', '--port=9000'], { repo: 'shop' })))).toEqual({ runs: 'serve-it --port={port}', folder: 'repos/shop' });
    });

    it('names PHP, static files and a port for the modes with no command of their own', () => {
        expect(firstStartWords(one(siteEntry('web', [], { hostServe: { mode: 'php', root: 'public' } }))).runs).toMatch(/PHP.*public/);
        expect(firstStartWords(one(siteEntry('web', [], { hostServe: { mode: 'static', root: 'dist' } }))).runs).toMatch(/files.*dist/);
        expect(firstStartWords(one(siteEntry('web', [], { hostPort: 5173 }))).runs).toMatch(/5173/);
    });

    it('shows what a person could not otherwise see in a command', () => {
        const hidden = ['serve-it', `safe${String.fromCodePoint(0x202e)}gnp.exe`, `a${String.fromCodePoint(0x200b)}b`, `x${String.fromCodePoint(0x0a)}y`, `t${String.fromCodePoint(0x1b)}[2K`];
        const { runs } = firstStartWords(one(siteEntry('web', hidden)));
        for (const code of [0x202e, 0x200b, 0x0a, 0x1b]) expect(runs).not.toContain(String.fromCodePoint(code));
        expect(runs).toContain('U+202E');
        expect(runs).toContain('U+200B');
        expect(runs).toContain('U+000A');
        expect(runs).toContain('U+001B');
    });

    it('the fingerprint follows what runs and nothing else', () => {
        const base = one(siteEntry('web', ['serve-it']));
        expect(siteRunFingerprint(one(siteEntry('web', ['serve-it'])))).toBe(siteRunFingerprint(base));
        expect(siteRunFingerprint(one(siteEntry('web', ['serve-it'], { description: 'unrelated', enabled: false })))).toBe(siteRunFingerprint(base));
        expect(siteRunFingerprint(one(siteEntry('web', ['serve-it', 'more'])))).not.toBe(siteRunFingerprint(base));
        expect(siteRunFingerprint(one(siteEntry('web', ['serve-it'], { repo: 'shop' })))).not.toBe(siteRunFingerprint(base));
    });
});

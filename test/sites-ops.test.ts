import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { featureSnapshot, handleFeatureAction, type FeatureState } from '../src/main/feature-ipc.js';
import { createSite, openSite, restartSite, siteEditTarget, siteLogs, updateSite } from '../src/main/hosting-actions.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * S6 — THE SITE ROW'S OPERATIONS, MAIN-SIDE (hosting ship line): Restart, Edit (written back to project.json), Logs and
 * Open, through hosting-actions.ts — the calls the Hosting row and the agents' `sites` tool both make. The REAL
 * composition over a fake pty that can speak and exit, so a log is real output and a restart is a real new spawn.
 * Every claim is counted, and every "nothing happened" has its positive control. Invented names throughout.
 */

const spawned: Array<{ id: string; command: string | undefined; cwd: string | undefined }> = [];
const killed: string[] = [];
const dataListeners = new Set<(id: string, data: string) => void>();
const pty: PtyPort = {
    open: (o) => { const id = `pty_${spawned.length + 1}`; spawned.push({ id, command: o.command, cwd: o.cwd }); return { id, pid: process.pid, shell: o.command ?? 'sh', scrollback: '' }; },
    write: () => true, resize: () => true, kill: (id) => { killed.push(id); return true; }, scrollback: () => '',
    onData: (l) => { dataListeners.add(l); return () => dataListeners.delete(l); },
    onExit: () => () => {},
};
const say = (ptyId: string, text: string) => { for (const l of dataListeners) l(ptyId, text); };
const state = (): FeatureState => ({ toolStatuses: null, knowledgeQuery: '' });
const dev = (name: string) => ({ name, mode: 'proxy' as const, devServer: { stack: 'node' as const, command: 'npm run dev -- --port {port}' }, hostPort: null, root: null, spa: false });

let dir: string;
let ws: string;
let services: ComposedServices;
let opened: string[];
const ports = () => ({ openInBrowser: async (url: string) => { opened.push(url); return { ok: true as const }; } });
const manifestOf = async () => JSON.parse(await readFile(join(ws, 'project.json'), 'utf8')) as { sites: Record<string, Record<string, unknown>> } & Record<string, unknown>;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-sites-ops-'));
    ws = join(dir, 'example');
    await mkdir(join(ws, 'repos', 'web'), { recursive: true });
    await writeFile(join(ws, 'project.json'), `${JSON.stringify({ name: 'example', tynnToken: 'tok-example-not-real', repos: [{ name: 'web', slug: 'web', path: 'repos/web' }] }, null, 2)}\n`, 'utf8');
    spawned.length = 0;
    killed.length = 0;
    dataListeners.clear();
    opened = [];
    services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, workspaces: () => [{ id: 'example', path: ws }] });
});

afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true });
});

const devSpawns = () => spawned.filter((s) => s.command?.startsWith('npm run dev'));

describe('Restart', () => {
    it('runs the site’s process again (a NEW spawn, the old one killed) and it is running; the log keeps the earlier run', async () => {
        await createSite(services, { workspaceId: 'example', repoPath: ws, form: dev('web') });
        expect(devSpawns()).toHaveLength(1);
        say(devSpawns()[0]!.id, 'first run listening\n');
        const before = killed.length;
        const after = await restartSite(services, 'site_web');
        expect(devSpawns()).toHaveLength(2);
        expect(killed.length - before).toBe(1);
        expect(after.state).toBe('running');
        expect(siteLogs(services, 'site_web').map((l) => l.text).join('\n')).toContain('first run listening');
    });

    it('a stopped site restarted comes up, and the person’s remembered Stop is lifted (it would come back on the next launch)', async () => {
        await createSite(services, { workspaceId: 'example', repoPath: ws, form: dev('web') });
        await handleFeatureAction(services, { kind: 'hosting.stopSite', siteId: 'site_web' }, state());
        const stops = () => readFile(join(dir, 'runtime', 'site-run-state.json'), 'utf8').then((t) => (JSON.parse(t) as { stopped: string[] }).stopped).catch(() => [] as string[]);
        expect(await stops()).toHaveLength(1);
        const snap = await handleFeatureAction(services, { kind: 'hosting.restartSite', siteId: 'site_web' }, state());
        expect(snap.hosting!.sites.find((s) => s.id === 'site_web')!.state).toBe('running');
        expect(await stops()).toEqual([]);
    });

    it('an external site (a server you run) has no process of Genie’s: refused with why, nothing spawned', async () => {
        await createSite(services, { workspaceId: 'example', repoPath: ws, form: { ...dev('ext'), devServer: null, hostPort: 5173 } });
        const mark = spawned.length;
        await expect(restartSite(services, 'site_ext')).rejects.toThrow(/server you run yourself on port 5173/);
        expect(spawned.length).toBe(mark);
    });
});

describe('Logs', () => {
    it('each of the site’s processes’ output — kept after the process is stopped — rides the Hosting snapshot under the row', async () => {
        await createSite(services, { workspaceId: 'example', repoPath: ws, form: dev('web') });
        say(devSpawns()[0]!.id, 'VITE ready in 312 ms\nError: EADDRINUSE\n');
        await handleFeatureAction(services, { kind: 'hosting.stopSite', siteId: 'site_web' }, state());
        const logs = siteLogs(services, 'site_web');
        expect(logs.map((l) => [l.processId, l.name])).toEqual([['site_web', 'web.gen dev server']]);
        expect(logs[0]!.text).toContain('Error: EADDRINUSE');
        const row = (await featureSnapshot(services, state())).hosting!.sites.find((s) => s.id === 'site_web')!;
        expect(row.logs?.map((l) => l.processId)).toEqual(['site_web']);
        expect(row.logs![0]!.text).toContain('VITE ready in 312 ms');
    });

    it('a server you run yourself has no process of Genie’s and so no logs; a site Genie runs has at least Genie’s own "started" line (control)', async () => {
        await createSite(services, { workspaceId: 'example', repoPath: ws, form: { ...dev('ext'), devServer: null, hostPort: 5173 } });
        await createSite(services, { workspaceId: 'example', repoPath: join(ws, 'repos', 'web'), form: dev('web') });
        const rows = (await featureSnapshot(services, state())).hosting!.sites;
        expect(rows.find((s) => s.id === 'site_ext')!.logs?.length ?? 0).toBe(0);
        const web = rows.find((s) => s.id === 'site_web')!.logs!;
        expect(web).toHaveLength(1);
        expect(web[0]!.text).toMatch(/\[genie\] started \(pid \d+\): npm run dev -- --port \d+/);
    });
});

describe('Open', () => {
    it('a served site opens in Genie’s browser at its https URL, and the browser surface’s address says so', async () => {
        await createSite(services, { workspaceId: 'example', repoPath: ws, form: dev('web') });
        const snap = await handleFeatureAction(services, { kind: 'hosting.openSite', siteId: 'site_web' }, state(), ports());
        expect(opened).toEqual(['https://web.gen/']);
        expect(snap.browser.url).toBe('https://web.gen/');
    });

    it('a stopped site is refused with why, and nothing is opened (control: started, it opens)', async () => {
        await createSite(services, { workspaceId: 'example', repoPath: ws, form: dev('web') });
        await handleFeatureAction(services, { kind: 'hosting.stopSite', siteId: 'site_web' }, state());
        await expect(openSite(services, 'site_web', ports().openInBrowser)).rejects.toThrow(/web\.gen is not being served \(stopped\); start it first/);
        expect(opened).toEqual([]);
        await handleFeatureAction(services, { kind: 'hosting.startSite', siteId: 'site_web' }, state());
        await openSite(services, 'site_web', ports().openInBrowser);
        expect(opened).toEqual(['https://web.gen/']);
    });
});

describe('Edit — the Add form’s validation, written back to project.json', () => {
    it('hosting.editSite opens the form on the site as declared now; cancel closes it', async () => {
        await createSite(services, { workspaceId: 'example', repoPath: join(ws, 'repos', 'web'), form: dev('web.example') });
        let snap = await handleFeatureAction(services, { kind: 'hosting.editSite', siteId: 'site_web.example' }, state());
        expect(snap.hosting!.editing).toEqual({ siteId: 'site_web.example', host: 'web.example.gen', problems: [], defaults: { name: 'web.example', mode: 'proxy', devServer: { stack: 'node', command: 'npm run dev -- --port {port}' }, hostPort: null, root: null, spa: false } });
        snap = await handleFeatureAction(services, { kind: 'hosting.cancelForm' }, { ...state(), siteEditing: snap.hosting!.editing! });
        expect(snap.hosting!.editing).toBeNull();
    });

    it('a rename + new command: the SAME key in project.json rewritten (other keys and the site’s other fields kept), the site re-served under its new name', async () => {
        await createSite(services, { workspaceId: 'example', repoPath: join(ws, 'repos', 'web'), form: dev('web') });
        const before = await manifestOf();
        const [key] = Object.keys(before.sites);
        // A Genie 1 field on the entry, which an edit must carry through.
        before.sites[key!]!.framework = 'vite';
        await writeFile(join(ws, 'project.json'), `${JSON.stringify(before, null, 2)}\n`, 'utf8');

        const r = await updateSite(services, { siteId: 'site_web', form: { ...dev('app.example'), devServer: { stack: 'node', command: 'npm start -- --port {port}' } } });
        expect(r.kind).toBe('updated');
        const after = await manifestOf();
        expect(Object.keys(after.sites)).toEqual([key]);
        expect(after.sites[key!]).toMatchObject({ name: 'app', genName: 'app.example.gen', command: ['npm', 'start', '--', '--port', '{port}'], framework: 'vite', repo: 'web', enabled: true });
        expect(after.tynnToken).toBe('tok-example-not-real');
        expect(services.sites.list().map((s) => [s.id, s.host, s.state])).toEqual([['site_app.example', 'app.example.gen', 'running']]);
        expect(spawned.at(-1)!.command).toBe(`npm start -- --port ${services.sites.get('site_app.example')!.port}`);
        // The old name is no longer served.
        expect(services.routes().map((x) => x.host)).toEqual(['app.example.gen']);
    });

    it('refused with the Add form’s problems, word for word, and NOTHING changes — not the file, not the running site', async () => {
        await createSite(services, { workspaceId: 'example', repoPath: ws, form: dev('web') });
        await createSite(services, { workspaceId: 'example', repoPath: join(ws, 'repos', 'web'), form: dev('docs') });
        const fileBefore = await readFile(join(ws, 'project.json'), 'utf8');
        const spawnsBefore = spawned.length;
        const bad = { ...dev('docs'), mode: 'static' as const, root: '' };
        const r = await updateSite(services, { siteId: 'site_web', form: bad });
        const add = await createSite(services, { workspaceId: 'example', repoPath: ws, form: bad });
        expect(r.kind).toBe('problems');
        expect(add.kind).toBe('problems');
        expect(r.kind === 'problems' && add.kind === 'problems' ? r.problems : null).toEqual(add.kind === 'problems' ? add.problems : []);
        expect(r.kind === 'problems' ? r.problems.map((p) => p.field) : []).toEqual(['name', 'root']);
        expect(await readFile(join(ws, 'project.json'), 'utf8')).toBe(fileBefore);
        expect(spawned.length).toBe(spawnsBefore);
        expect(services.sites.get('site_web')).toMatchObject({ state: 'running' });
    });

    it('its own name is not "taken" by itself: an edit that keeps the name saves (control for the refusal above)', async () => {
        await createSite(services, { workspaceId: 'example', repoPath: ws, form: dev('web') });
        const r = await updateSite(services, { siteId: 'site_web', form: { ...dev('web'), devServer: null, hostPort: 5180 } });
        expect(r.kind).toBe('updated');
        expect(services.sites.get('site_web')).toMatchObject({ state: 'external', port: 5180 });
        expect(Object.values((await manifestOf()).sites)[0]).toMatchObject({ hostPort: 5180 });
        expect('command' in Object.values((await manifestOf()).sites)[0]!).toBe(false);
    });

    it('a stopped site stays stopped after an edit (an edit is not a start), and its remembered Stop still holds', async () => {
        await createSite(services, { workspaceId: 'example', repoPath: ws, form: dev('web') });
        await handleFeatureAction(services, { kind: 'hosting.stopSite', siteId: 'site_web' }, state());
        const spawnsBefore = spawned.length;
        await updateSite(services, { siteId: 'site_web', form: dev('web2') });
        expect(services.sites.get('site_web2')).toMatchObject({ state: 'stopped' });
        expect(spawned.length).toBe(spawnsBefore);
        // Control: Start brings the edited site up under its new name.
        await handleFeatureAction(services, { kind: 'hosting.startSite', siteId: 'site_web2' }, state());
        expect(services.sites.get('site_web2')).toMatchObject({ state: 'running' });
    });

    it('a site not kept in any project.json, and one Genie 2 cannot serve, cannot be edited — each says why', async () => {
        services.sites.create({ name: 'loose', workspaceId: 'example', repoPath: ws, serve: { mode: 'proxy' }, hostPort: 5190 });
        expect(() => siteEditTarget(services, 'site_loose')).toThrow(/not kept in a workspace’s project\.json/);
        services.sites.declareUnservable({ workspaceId: 'example', name: 'wallet', host: 'wallet.gen', repoPath: ws, reason: 'it runs inside the workspace container', key: 'k9' });
        const unservable = services.sites.list().find((s) => s.host === 'wallet.gen')!;
        await expect(handleFeatureAction(services, { kind: 'hosting.editSite', siteId: unservable.id }, state())).rejects.toThrow(/cannot be edited here: it runs inside the workspace container/);
    });
});

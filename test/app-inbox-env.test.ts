import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appInboxEnvFor, type AppEnvSource } from '../src/main/app-inbox-service.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { handleFeatureAction, type FeatureState } from '../src/main/feature-ipc.js';
import { terminalEnvFor } from '../src/main/hosting-actions.js';
import { ProcessBook } from '../src/main/process-book.js';
import { ProcessScheduler } from '../src/main/process-scheduler.js';
import type { ProcessSpec, ProcessStatus } from '../src/main/process-supervisor.js';
import { ProcessSupervisor } from '../src/main/process-supervisor.js';
import { SiteManager, type SiteManagerDeps } from '../src/main/site-manager.js';
import type { PtyOpened, PtyPort, PtySpawnOptions } from '../src/main/terminal-host.js';

/**
 * WHERE AN APP'S CREDENTIAL GOES, AND WHERE IT NEVER GOES (genie#1345). Each site and each kept process gets its OWN
 * `GENIE_INBOX_TOKEN` (and the URL) in its OWN start-up env — handed to it by Genie, so nobody copies a token into a
 * file. It must never ride the workspace's SERVICE env: that env reaches every agent session (session-host.ts
 * `serviceEnvDriverOptions`), every terminal (`terminalEnvFor`) and every site repo's `.env` (`DotEnvSync`), so a token
 * there would be every agent's to post as an app, and written to disk. Every absence below sits beside the presence it
 * would contradict, measured the same way.
 */

const URL_ = 'http://127.0.0.1:47432';
const tokenOf = (s: AppEnvSource) => `gik_${s.kind}_${s.id}`;
const appEnv = (s: AppEnvSource) => ({ GENIE_INBOX_URL: URL_, GENIE_INBOX_TOKEN: tokenOf(s) });

describe('the env an app gets', () => {
    it('is the URL and its own token; nothing when it has none (revoked, or switched off)', () => {
        expect(appInboxEnvFor({ url: URL_, token: 'gik_x' })).toEqual({ GENIE_INBOX_URL: URL_, GENIE_INBOX_TOKEN: 'gik_x' });
        expect(appInboxEnvFor({ url: URL_, token: null })).toEqual({});
        expect(appInboxEnvFor({ url: null, token: 'gik_x' })).toEqual({});
    });

    it('never under a name a front-end build would bake into a bundle', () => {
        const names = Object.keys(appInboxEnvFor({ url: URL_, token: 'gik_x' }));
        expect(names.length).toBeGreaterThan(0);
        for (const n of names) expect(n).not.toMatch(/^(VITE_|NEXT_PUBLIC_|PUBLIC_|REACT_APP_|NUXT_PUBLIC_|EXPO_PUBLIC_)/);
    });
});

function fakePty() {
    const opened: Array<PtySpawnOptions & { id: string }> = [];
    let n = 0;
    const port: PtyPort = {
        open(options) { const id = `term_${++n}`; opened.push({ ...options, id }); return { id, pid: 3000 + n, shell: options.command ?? 'sh', scrollback: '' } satisfies PtyOpened; },
        write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
    };
    return { port, opened };
}

describe('a site gets its own token in its own processes', () => {
    function make(over: Partial<SiteManagerDeps> = {}) {
        const pty = fakePty();
        const supervisor = new ProcessSupervisor(pty.port, { now: () => 0, schedule: () => () => {} });
        let next = 4100;
        const deps = {
            supervisor, allocatePort: () => ++next, caddyBin: '/opt/genie/runtime/caddy', configDir: '/data/sites', writeConfig: () => {}, phpWorkers: 1,
            serviceEnv: () => ({ DB_PORT: '4104' }),
            ...over,
        } as SiteManagerDeps;
        return { pty, sites: new SiteManager(deps) };
    }
    const workerEnv = (opened: ReadonlyArray<PtySpawnOptions>) => [...opened].reverse().find((o) => /php-cgi -b /.test(o.command ?? ''))?.env ?? null;

    it('a php site’s worker has the service env AND its own token (positive control: the service env is there too)', () => {
        const { pty, sites } = make({ appEnv });
        sites.create({ name: 'flabs', workspaceId: 'fancy', repoPath: '/repos/flabs', serve: { mode: 'php', root: 'public' } });
        expect(workerEnv(pty.opened)).toMatchObject({ DB_PORT: '4104', GENIE_INBOX_URL: URL_, GENIE_INBOX_TOKEN: 'gik_site_site_flabs' });
    });

    it('a site whose source holds no token (revoked, or switched off) starts with none — and still starts', () => {
        const { pty, sites } = make({ appEnv: () => ({}) });
        sites.create({ name: 'flabs', workspaceId: 'fancy', repoPath: '/repos/flabs', serve: { mode: 'php', root: 'public' } });
        expect(workerEnv(pty.opened)).toMatchObject({ DB_PORT: '4104' });
        expect(workerEnv(pty.opened)?.GENIE_INBOX_TOKEN).toBeUndefined();
    });

    it('a dev-server site gets it, and two sites get two different tokens', () => {
        const { pty, sites } = make({ appEnv });
        sites.create({ name: 'a', workspaceId: 'fancy', repoPath: '/repos/a', serve: { mode: 'proxy' }, devServer: { stack: 'node', command: 'node a.mjs {port}' } });
        sites.create({ name: 'b', workspaceId: 'fancy', repoPath: '/repos/b', serve: { mode: 'proxy' }, devServer: { stack: 'node', command: 'node b.mjs {port}' } });
        const envs = pty.opened.filter((o) => /node [ab]\.mjs/.test(o.command ?? '')).map((o) => o.env?.GENIE_INBOX_TOKEN);
        expect(envs).toEqual(['gik_site_site_a', 'gik_site_site_b']);
    });

    it('its own declared env cannot overwrite the token Genie handed it', () => {
        const { pty, sites } = make({ appEnv });
        sites.create({ name: 'flabs', workspaceId: 'fancy', repoPath: '/repos/flabs', serve: { mode: 'php', root: 'public' }, env: { GENIE_INBOX_TOKEN: 'mine' } });
        expect(workerEnv(pty.opened)?.GENIE_INBOX_TOKEN).toBe('gik_site_site_flabs');
    });

    it('a rotated or revoked token reaches the running site: it is restarted with the new env', () => {
        let rotated = false;
        const { pty, sites } = make({ appEnv: (s) => (rotated ? { GENIE_INBOX_URL: URL_, GENIE_INBOX_TOKEN: 'gik_new' } : appEnv(s)) });
        sites.create({ name: 'flabs', workspaceId: 'fancy', repoPath: '/repos/flabs', serve: { mode: 'php', root: 'public' } });
        expect(sites.serviceEnvChanged('fancy')).toEqual([]); // CONTROL: nothing changed, nothing restarted
        rotated = true;
        expect(sites.serviceEnvChanged('fancy')).toEqual(['site_flabs']);
        expect(workerEnv(pty.opened)?.GENIE_INBOX_TOKEN).toBe('gik_new');
    });
});

function fakeSupervisor() {
    const started: ProcessSpec[] = [];
    const statuses = new Map<string, ProcessStatus>();
    const listeners = new Set<(s: ProcessStatus) => void>();
    const set = (s: ProcessStatus) => { statuses.set(s.id, s); for (const l of listeners) l(s); };
    return {
        started,
        start: (spec: ProcessSpec): ProcessStatus => { started.push(spec); const s: ProcessStatus = { id: spec.id, workspaceId: spec.workspaceId, name: spec.name, state: 'running', pid: 4242, exitCode: null, restarts: 0, since: 0 }; set(s); return s; },
        stop: (id: string) => { const s = statuses.get(id); if (s) set({ ...s, state: 'stopped', pid: null }); return true; },
        forget: (id: string) => statuses.delete(id),
        list: (workspaceId?: string) => [...statuses.values()].filter((s) => workspaceId === undefined || s.workspaceId === workspaceId),
        status: (id: string) => statuses.get(id) ?? null,
        onChange: (l: (s: ProcessStatus) => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
    };
}

describe('a kept process and a scheduled task get their own token', () => {
    let home: string;
    beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'genie2-app-env-')); });
    afterEach(async () => { await rm(home, { recursive: true, force: true }); });
    const WS = { id: 'fancy', path: resolve(tmpdir(), 'genie2-app-env-ws') };

    it('a background process: the service env and ITS token', async () => {
        const sup = fakeSupervisor();
        const book = await ProcessBook.open(home, { supervisor: sup, envFor: () => ({ DB_PORT: '4104' }), asleep: () => false, appEnv });
        const p = await book.create({ workspaceId: WS.id, workspacePath: WS.path, name: 'queue', command: 'php artisan queue:work', restart: 'on-failure' });
        expect(sup.started[0]!.env).toMatchObject({ DB_PORT: '4104', GENIE_INBOX_URL: URL_, GENIE_INBOX_TOKEN: `gik_process_${p.id}` });
    });

    it('a scheduled command run: the same', async () => {
        const sup = fakeSupervisor();
        const book = await ProcessBook.open(home, { supervisor: sup, envFor: () => ({}), asleep: () => false, appEnv });
        const task = await book.create({ workspaceId: WS.id, workspacePath: WS.path, name: 'nightly', command: 'npm run check', restart: 'never', schedule: { cron: '0 3 * * *', kind: 'command' } });
        const scheduler = new ProcessScheduler({ book, supervisor: sup, envFor: () => ({}), appEnv, asleep: () => false, nudge: () => false, now: () => 0, schedule: () => () => {} });
        await scheduler.runNow(task.id);
        expect(sup.started.at(-1)!.env).toMatchObject({ GENIE_INBOX_TOKEN: `gik_process_${task.id}` });
    });
});

describe('the workspace’s SERVICE env never carries it (composed for real)', () => {
    let dir: string;
    let services: ComposedServices;
    const opened: Array<PtySpawnOptions & { id: string }> = [];
    const pty: PtyPort = {
        open: (o) => { const id = `term_${opened.length + 1}`; opened.push({ ...o, id }); return { id, pid: 1000 + opened.length, shell: o.command ?? 'sh', scrollback: '' }; },
        write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
    };
    beforeEach(async () => {
        opened.length = 0;
        dir = await mkdtemp(join(tmpdir(), 'genie2-app-env-compose-'));
        await mkdir(join(dir, 'fancy'), { recursive: true });
        await writeFile(join(dir, 'fancy', 'project.json'), `${JSON.stringify({ name: 'fancy', repos: [] }, null, 2)}\n`, 'utf8');
        services = await composeServices({
            userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, docker: async () => ({ stdout: '', exitCode: 0 }), portFree: async () => true,
            workspaces: () => [{ id: 'fancy', path: join(dir, 'fancy') }],
            appInboxEnv: appEnv,
        });
    });
    afterEach(async () => { await services.shutdown(); await rm(dir, { recursive: true, force: true }); });

    it('a site created through Hosting gets its token; the service env, a terminal’s env and the agents’ env do not', async () => {
        const state: FeatureState = { toolStatuses: null, knowledgeQuery: '' };
        const site = { name: 'flabs', mode: 'proxy' as const, devServer: { stack: 'node' as const, command: 'node server.mjs {port}' }, hostPort: null, root: null, spa: false };
        await handleFeatureAction(services, { kind: 'hosting.createSite', workspaceId: 'fancy', repoPath: join(dir, 'fancy'), form: site }, state);
        const devServer = opened.find((o) => /node server\.mjs/.test(o.command ?? ''));
        expect(devServer?.env?.GENIE_INBOX_TOKEN).toBe('gik_site_site_flabs'); // presence, measured on the spawn
        // The service env: what agent sessions (session-host serviceEnvFor), processes' base and DotEnvSync read.
        expect(Object.keys(services.engines.envFor('fancy'))).not.toContain('GENIE_INBOX_TOKEN');
        expect(Object.keys(terminalEnvFor(services, 'fancy', { GENIE_MCP_URL: 'x', GENIE_MCP_TOKEN: 'y' }))).not.toContain('GENIE_INBOX_TOKEN');
    });

    it('switched off for the workspace: a new site gets no token', async () => {
        await services.settings.setFor('fancy', 'app_inbox', false);
        const state: FeatureState = { toolStatuses: null, knowledgeQuery: '' };
        const site = { name: 'quiet', mode: 'proxy' as const, devServer: { stack: 'node' as const, command: 'node quiet.mjs {port}' }, hostPort: null, root: null, spa: false };
        await handleFeatureAction(services, { kind: 'hosting.createSite', workspaceId: 'fancy', repoPath: join(dir, 'fancy'), form: site }, state);
        const devServer = opened.find((o) => /node quiet\.mjs/.test(o.command ?? ''));
        expect(devServer).toBeDefined(); // CONTROL: it did start
        expect(devServer?.env?.GENIE_INBOX_TOKEN).toBeUndefined();
    });
});

describe('main wires it where the plan says, and nowhere else', () => {
    const main = readFileSync(join(__dirname, '..', 'src', 'main', 'main.ts'), 'utf8');
    it('compose, the process book and the scheduler are given the app env', () => {
        expect(main).toMatch(/appInboxEnv:\s*\(/);
        expect((main.match(/appEnv:\s*\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
    });
    it('the token is never put into a terminal’s env or the MCP env', () => {
        const mcpEnvLine = main.split('\n').find((l) => l.includes('const mcpEnv ='))!;
        expect(mcpEnvLine).toBeDefined();
        expect(mcpEnvLine).not.toMatch(/INBOX/);
    });
});

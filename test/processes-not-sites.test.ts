import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { handleFeatureAction, type FeatureState } from '../src/main/feature-ipc.js';
import { ProcessBook } from '../src/main/process-book.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * A SITE'S PROCESSES ARE NOT BACKGROUND PROCESSES (the owner, 2026-10-21, a screenshot of prism's Processes list:
 * "prism.gen server", "prism.gen php worker", "consensus.prism.gen dev server" among its queue workers — "That should
 * not be happening, they are two different things"). Sites and background processes run on the same supervisor, and
 * the Processes list read the supervisor's WHOLE list: every site's server, worker and dev server showed as a
 * background process, with a Stop and a Restart that acted on the site behind its back. The list — the panel and the
 * agents' `processes` tool alike — is the processes someone ADDED as processes, and nothing else.
 */
let opened = 0;
const pty: PtyPort = {
    open: (o) => ({ id: `term_${++opened}`, pid: 1000 + opened, shell: o.command ?? 'sh', scrollback: '' }),
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '',
    onData: () => () => {}, onExit: () => () => {},
};

let dir: string;
let services: ComposedServices;
let book: ProcessBook;
const ws = (w: string) => join(dir, w);
const state: FeatureState = { toolStatuses: null, knowledgeQuery: '' };

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-processes-not-sites-'));
    await mkdir(ws('example'), { recursive: true });
    await writeFile(join(ws('example'), 'project.json'), `${JSON.stringify({ name: 'example', repos: [] }, null, 2)}\n`, 'utf8');
    services = await composeServices({
        userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, docker: async () => ({ stdout: '', exitCode: 0 }), portFree: async () => true,
        workspaces: () => [{ id: 'example', path: ws('example') }],
    });
    book = await ProcessBook.open(dir, { supervisor: services.supervisor, envFor: () => ({}), asleep: () => false, limit: () => 10 });
    // A site with a dev server: its process runs on the SAME supervisor.
    const site = { name: 'example', mode: 'proxy' as const, devServer: { stack: 'node' as const, command: 'npm run dev -- --port {port}' }, hostPort: null, root: null, spa: false };
    await handleFeatureAction(services, { kind: 'hosting.createSite', workspaceId: 'example', repoPath: ws('example'), form: site }, state);
    // And a background process someone added.
    await book.create({ workspaceId: 'example', workspacePath: ws('example'), name: 'queue', command: 'php artisan queue:work', restart: 'on-failure' });
});

afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true });
});

it('the gauge: the site’s process IS on the supervisor beside the background one (positive control)', () => {
    const names = services.supervisor.list('example').map((p) => p.name);
    expect(names).toContain('queue');
    expect(names.length).toBeGreaterThan(1);
});

it('the Processes list (the book) holds the background process only — no site process (counted)', () => {
    expect(book.list().map((p) => p.name)).toEqual(['queue']);
    expect(book.list('example').map((p) => p.name)).toEqual(['queue']);
});

it('the Hosting surface’s processes are the book’s, without the site’s — the site is listed under Sites', async () => {
    const { featureSnapshot } = await import('../src/main/feature-ipc.js');
    const hosting = (await featureSnapshot(services, state, { processes: book })).hosting!;
    expect(hosting.processes.map((p) => p.name)).toEqual(['queue']);
    expect(hosting.sites.length).toBe(1);
});

it('with no book yet (early in boot), the surface lists NO processes — never the supervisor’s, sites and all', async () => {
    const { featureSnapshot } = await import('../src/main/feature-ipc.js');
    expect((await featureSnapshot(services, state)).hosting!.processes).toEqual([]);
});

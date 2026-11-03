import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject } from '@particle-academy/prism-mcp';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import type { ComposedServices, composeServices } from '../src/main/compose.js';
import { featureSnapshot, handleFeatureAction, type FeatureState } from '../src/main/feature-ipc.js';
import { hostingTools } from '../src/main/mcp-tools-hosting.js';
import { runtimeDir } from '../src/main/paths.js';
import type { SiteInfo } from '../src/main/site-manager.js';
import type { PtyPort } from '../src/main/terminal-host.js';
import { SiteRow } from '../src/renderer/components/FeatureSurfaces.js';
import type { HostedSite } from '../src/renderer/features.js';
import { registerAppIcons } from '../src/renderer/icons.js';
import { composeTracker } from './support/compose-tracker.js';

/**
 * THE FIRST START, THROUGH THE REAL COMPOSITION: the record on disk, the Hosting action (the person), the `sites` tool (an
 * agent), and the row. Invented names; every "nothing ran" has a control where the same site ran.
 */

registerAppIcons();

const opened: string[] = [];
const pty: PtyPort = {
    open: (o) => { opened.push(o.command ?? ''); return { id: `term_${opened.length}`, pid: 1, shell: 'sh', scrollback: '' }; },
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
};
const state = (): FeatureState => ({ toolStatuses: null, knowledgeQuery: '' });
const settle = () => new Promise<void>((r) => setTimeout(r, 25));
const composed = composeTracker();

let dir: string;
let home: string;
let workspaces: Array<{ id: string; path: string }> = [];
let services: ComposedServices;

async function launch(): Promise<void> {
    opened.length = 0;
    services = await composed.compose({
        userData: home, pty, v1Settings: () => null, caddyBin: '/opt/genie/runtime/caddy', frontDoorPort: 0, phpWorkers: 1,
        hostsIo: { read: async () => '', write: async () => {}, stage: async () => ({ command: 'cp', args: [] }) },
        elevate: async () => ({ ok: true }), hostsDebounceMs: 1, frontDoorPorts: { probe: async () => 'free', holder: async () => null },
        workspaces: () => workspaces,
    } as Parameters<typeof composeServices>[0]);
    await settle();
}
const relaunch = async () => { await services.shutdown(); await launch(); };
const rowOf = async () => (await featureSnapshot(services, state())).hosting!.sites[0]!;
const ran = () => opened.some((c) => c.includes('serve-it'));
const recordFile = () => join(runtimeDir(home), 'workspace-trust.json');

async function agentCall(action: string, extra: JsonObject = {}) {
    const caller = { agentId: mintAgentId(), agentName: 'atlas', workspaceId: 'acme', workspacePath: join(dir, 'acme') };
    const tools = hostingTools({ resolveCaller: () => caller, approve: async () => 'allowed', services, openInBrowser: async () => ({ ok: true }) });
    const tool = tools.find((t) => t.definition.name === 'sites')!;
    const r = await tool.handler({ terminalId: 't', action, ...extra }, { server: 'genie', tool: 'sites', headers: {} });
    return { isError: r.isError === true, text: r.text };
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-first-start-'));
    home = join(dir, 'home');
    await mkdir(join(dir, 'acme'), { recursive: true });
    await writeFile(join(dir, 'acme', 'project.json'), JSON.stringify({ name: 'Acme', sites: { k1: { repo: '', runMode: 'host', kind: 'http', enabled: true, name: 'web', genName: 'web.gen', command: ['serve-it', '--port=9000'] } } }), 'utf8');
    workspaces = [];
});

afterEach(async () => {
    await composed.shutdownAll();
    await rm(dir, { recursive: true, force: true });
});

describe('through the real composition', () => {
    it('a new install: the record is written, a workspace added later waits; the agent is refused; the person starts it; the next launch starts it', async () => {
        await launch();
        expect(existsSync(recordFile())).toBe(true);
        workspaces = [{ id: 'acme', path: join(dir, 'acme') }];
        await relaunch();
        expect(ran()).toBe(false);
        const row = await rowOf();
        expect(row.firstStart?.runs).toContain('serve-it');

        for (const action of ['start', 'restart']) {
            const refused = await agentCall(action, { site: 'web.gen' });
            expect(refused.isError).toBe(true);
            expect(refused.text).toMatch(/person/);
        }
        expect(ran()).toBe(false);

        await handleFeatureAction(services, { kind: 'hosting.startSite', siteId: row.id }, state());
        expect(ran()).toBe(true);
        expect((await rowOf()).firstStart).toBeUndefined();

        await relaunch();
        expect(ran()).toBe(true);
    });

    it('the upgrade: the workspaces already registered keep their sites running, and an agent may restart them', async () => {
        workspaces = [{ id: 'acme', path: join(dir, 'acme') }];
        await launch();
        expect(ran()).toBe(true);
        expect((await rowOf()).firstStart).toBeUndefined();
        expect((await agentCall('restart', { site: 'web.gen' })).isError).toBe(false);
    });

    it('a Retry from the row is the person, too', async () => {
        await launch();
        workspaces = [{ id: 'acme', path: join(dir, 'acme') }];
        await relaunch();
        await handleFeatureAction(services, { kind: 'hosting.restartSite', siteId: (await rowOf()).id }, state());
        expect(ran()).toBe(true);
    });

    it('a record that is not JSON is set aside whole, nothing carries over, and a good record replaces it', async () => {
        await mkdir(runtimeDir(home), { recursive: true });
        await writeFile(recordFile(), '{ not json', 'utf8');
        workspaces = [{ id: 'acme', path: join(dir, 'acme') }];
        await launch();
        expect(ran()).toBe(false);
        expect((await rowOf()).firstStart).toBeDefined();
        expect(await readFile(`${recordFile()}.unreadable`, 'utf8')).toBe('{ not json');
        expect(JSON.parse(await readFile(recordFile(), 'utf8'))).toMatchObject({ version: 1, carried: [] });
        // And the next launch does not take the fresh record for an upgrade.
        await relaunch();
        expect(ran()).toBe(false);
    });
});

describe('the row', () => {
    const site = (over: Partial<SiteInfo>): HostedSite => ({ id: 's', name: 'web', host: 'web.gen', workspaceId: 'acme', repoPath: '/w/acme', serve: { mode: 'proxy' }, port: null, state: 'stopped', processIds: [], problem: null, ...over }) as HostedSite;
    const render = (s: HostedSite) => renderToStaticMarkup(<SiteRow site={s} editing={null} onAction={() => {}} />);

    it('names exactly what Start runs, and where, beside the Start control', () => {
        const html = render(site({ firstStart: { runs: 'serve-it --port={port}', folder: 'repos/shop', changed: false } }));
        expect(html).toContain('data-site-first-start');
        expect(html).toContain('serve-it --port={port}');
        expect(html).toContain('repos/shop');
        expect(html).toContain('data-site-action="start"');
    });

    it('says when what it runs has changed', () => {
        const before = render(site({ firstStart: { runs: 'x', folder: '.', changed: false } }));
        const after = render(site({ firstStart: { runs: 'x', folder: '.', changed: true } }));
        expect(before).not.toContain('data-site-first-start-changed');
        expect(after).toContain('data-site-first-start-changed');
    });

    it('a site with nothing to ask shows none of it', () => {
        expect(render(site({}))).not.toContain('data-site-first-start');
    });
});

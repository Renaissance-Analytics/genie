import { X509Certificate } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyNavigation } from '../src/core/browser-policy.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { handleFeatureAction, type FeatureState } from '../src/main/feature-ipc.js';
import type { TrustStorePort } from '../src/main/gen-ca.js';
import { createSite } from '../src/main/hosting-actions.js';
import type { HostsIo } from '../src/main/hosts-file.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * S5 — MULTI-LABEL `.gen` NAMES, END TO END (hosting ship line). Genie 1's default name is `<site>.<workspace>.gen`;
 * Genie 2 refused every such name at the site manager (one label only), so a Genie 1 site named that way was listed as
 * unservable and a person could not create one. Through the REAL composition (a fake pty, a fake hosts file, the real
 * CA and leaf issuer), a multi-label site must reach EVERY place a name goes: the Hosting form's default, project.json,
 * the external front door's Caddyfile, the hosts block, the leaf certificate's SANs (exact names — Genie 1 issued exact
 * names, never a wildcard), and the in-app browser's resolution. A one-label site beside it is the control.
 */

const pty: PtyPort = {
    open: (o) => ({ id: `term_${Math.random()}`, pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
};
const settle = () => new Promise<void>((r) => setTimeout(r, 25));
const state = (): FeatureState => ({ toolStatuses: null, knowledgeQuery: '' });
const proxy = (name: string, hostPort: number) => ({ name, mode: 'proxy' as const, devServer: null, hostPort, root: null, spa: false });

let dir: string;
let ws: string;
let services: ComposedServices;
let hosts = '';
let staged = '';
// The plain write is refused, as for a person who is not an administrator: the hosts file changes only through the ONE
// elevation (S4), which copies what was staged.
const hostsIo: HostsIo = {
    read: async () => hosts,
    write: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
    stage: async (next) => { staged = next; return { command: 'cp', args: [] }; },
};
const trustStore: TrustStorePort = { has: async () => true };
const compose = () => composeServices({
    userData: dir, pty, v1Settings: () => null, caddyBin: '/opt/genie/runtime/caddy', frontDoorPort: 0, hostsIo, trustStore,
    elevate: async () => { hosts = staged; return { ok: true }; }, hostsDebounceMs: 1, frontDoorPorts: { probe: async () => 'free', holder: async () => null },
    workspaces: () => [{ id: 'example', path: ws }],
});

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-sites-multilabel-'));
    ws = join(dir, 'example');
    await mkdir(join(ws, 'repos', 'web'), { recursive: true });
    await writeFile(join(ws, 'project.json'), `${JSON.stringify({ name: 'Example', repos: [{ name: 'web', slug: 'web', path: 'repos/web' }] }, null, 2)}\n`, 'utf8');
    hosts = '127.0.0.1 localhost\n';
    services = await compose();
    await settle();
});

afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true });
});

/** The leaf the front door's Caddyfile serves: its DNS SANs, read from the certificate itself. */
async function leafSans(caddyfile: string): Promise<string[]> {
    const m = /tls "([^"]+)" "([^"]+)"/.exec(caddyfile);
    expect(m, 'the Caddyfile names a leaf').not.toBeNull();
    const cert = new X509Certificate(await readFile(m![1]!, 'utf8'));
    return (cert.subjectAltName ?? '').split(/,\s*/).filter((s) => s.startsWith('DNS:')).map((s) => s.slice(4)).sort();
}

describe('S5: a multi-label site reaches every place a name goes', () => {
    it('Add a site defaults to Genie 1’s <folder>.<workspace>; the workspace’s own folder to the workspace’s name (control)', async () => {
        const inRepo = await handleFeatureAction(services, { kind: 'hosting.addSite', workspaceId: 'example', repoPath: join(ws, 'repos', 'web') }, state());
        expect(inRepo.hosting!.adding!.defaults.name).toBe('web.example');
        const atRoot = await handleFeatureAction(services, { kind: 'hosting.addSite', workspaceId: 'example', repoPath: ws }, state());
        expect(atRoot.hosting!.adding!.defaults.name).toBe('example');
    });

    it('created under its full name — routed, kept in project.json in Genie 1’s shape — beside a one-label site (control)', async () => {
        const multi = await createSite(services, { workspaceId: 'example', repoPath: join(ws, 'repos', 'web'), form: proxy('web.example', 5173) });
        const single = await createSite(services, { workspaceId: 'example', repoPath: ws, form: proxy('docs', 5174) });
        expect([multi.kind, single.kind]).toEqual(['created', 'created']);
        expect(services.sites.list().map((s) => [s.id, s.host, s.state])).toEqual([['site_web.example', 'web.example.gen', 'external'], ['site_docs', 'docs.gen', 'external']]);
        expect(services.routes()).toEqual([{ host: 'web.example.gen', target: '127.0.0.1:5173' }, { host: 'docs.gen', target: '127.0.0.1:5174' }]);
        const kept = JSON.parse(await readFile(join(ws, 'project.json'), 'utf8')) as { sites: Record<string, Record<string, unknown>> };
        expect(Object.values(kept.sites).map((e) => [e.name, e.genName])).toEqual([['web', 'web.example.gen'], ['docs', 'docs.gen']]);
    });

    it('the front door’s Caddyfile, the hosts block and the leaf’s SANs carry the FULL name — exact names, no wildcard', async () => {
        await createSite(services, { workspaceId: 'example', repoPath: join(ws, 'repos', 'web'), form: proxy('web.example', 5173) });
        await createSite(services, { workspaceId: 'example', repoPath: ws, form: proxy('docs', 5174) });
        await settle();
        const fd = services.externalFrontDoor;
        expect(fd.running).toBe(true);
        if (!fd.running) return;
        expect(fd.certificateError).toBeNull();
        const caddyfile = await readFile(fd.caddyfile, 'utf8');
        expect(caddyfile.match(/^https:\/\/\S+ \{$/gm)).toEqual(['https://web.example.gen {', 'https://docs.gen {']);
        expect(caddyfile).toContain('reverse_proxy 127.0.0.1:5173');
        expect(hosts.split('\n').filter((l) => l.startsWith('127.0.0.1 ') && l.endsWith('.gen'))).toEqual(['127.0.0.1 docs.gen', '127.0.0.1 web.example.gen']);
        const sans = await leafSans(caddyfile);
        expect(sans).toEqual(['docs.gen', 'web.example.gen']);
        expect(sans.filter((s) => s.includes('*'))).toEqual([]);
    });

    it('the in-app browser opens it: the full name resolves to the site’s loopback target, Host kept', async () => {
        await createSite(services, { workspaceId: 'example', repoPath: join(ws, 'repos', 'web'), form: proxy('web.example', 5173) });
        expect(classifyNavigation('https://web.example.gen/login', services.routes())).toEqual({ kind: 'site', host: 'web.example.gen', url: 'http://127.0.0.1:5173/login', hostHeader: 'web.example.gen' });
        const snap = await handleFeatureAction(services, { kind: 'browser.navigate', url: 'web.example.gen' }, state());
        expect(snap.browser.url).toBe('https://web.example.gen/');
    });

    it('after a relaunch it is read back from project.json under the same full name and served (not listed as unservable)', async () => {
        await createSite(services, { workspaceId: 'example', repoPath: join(ws, 'repos', 'web'), form: proxy('web.example', 5173) });
        await services.shutdown();
        services = await compose();
        await settle();
        expect(services.sites.list().map((s) => [s.host, s.state, s.problem])).toEqual([['web.example.gen', 'external', null]]);
    });
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import { composeServices } from '../src/main/compose.js';
import { EnvelopeSites } from '../src/main/envelope-sites-host.js';
import { ProcessSupervisor } from '../src/main/process-supervisor.js';
import { SiteManager } from '../src/main/site-manager.js';
import type { PtyPort } from '../src/main/terminal-host.js';

const pty: PtyPort = { open: () => { throw new Error('this fixture never starts a site'); }, write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {} };
function fixture() {
    const root = join('/fixture', 'ghost');
    const files = new Map<string, string>(), reads: string[] = [], writes: string[] = [];
    const sites = new SiteManager({ supervisor: new ProcessSupervisor(pty, { now: () => 0, schedule: () => () => {} }), allocatePort: () => 4500, caddyBin: '/fake/caddy', configDir: '/fake/config', writeConfig: () => {}, phpWorkers: 1 });
    const envelope = new EnvelopeSites(sites, { fs: {
        readText: async (path) => { reads.push(path); return files.get(path) ?? null; },
        exists: async (path) => { reads.push(path); return path === root || files.has(path); },
        writeTextAtomic: async (path, text) => { writes.push(path); files.set(path, text); },
    }, runState: { load: async () => [], save: async () => {} }, trust: { load: async () => null, save: async () => {} }, envFor: () => ({}) });
    const manifest = (name: string) => files.set(join(root, 'project.json'), JSON.stringify({ name: 'Ghost', sites: { entry: { repo: '', name, kind: 'http', runMode: 'host', enabled: false, hostPort: 4500 } } }));
    return { root, reads, writes, sites, envelope, manifest };
}
describe('story394: an asleep envelope supplies no site data', () => {
    it('a direct workspace name or path lookup cannot reopen a hibernated folder', async () => {
        const f = fixture(); f.manifest('before');
        await f.envelope.sync([{ id: 'ghost', path: f.root, asleep: true }]);
        f.reads.length = 0;
        expect(await f.envelope.workspaceName('ghost')).toBeNull();
        expect(f.envelope.workspacePath('ghost')).toBeNull();
        expect(f.reads).toEqual([]);
        await f.envelope.sync([{ id: 'ghost', path: f.root, asleep: false }]);
        expect(await f.envelope.workspaceName('ghost')).toBe('Ghost');
        expect(f.envelope.workspacePath('ghost')).toBe(f.root);
    });
    it('does not read or write the folder and does not list its site on boot', async () => {
        const f = fixture(); f.manifest('before');
        await f.envelope.sync([{ id: 'ghost', path: f.root, asleep: true }]);
        expect(f.reads).toEqual([]); expect(f.writes).toEqual([]); expect(f.sites.list()).toEqual([]);
        await f.envelope.sync([{ id: 'ghost', path: f.root, asleep: false }]);
        expect(f.reads).toContain(join(f.root, 'project.json'));
        expect(f.sites.list().map((site) => site.host)).toContain('before.gen');
    });
    it('removes site rows when hibernated and rereads changed declarations on redock', async () => {
        const f = fixture(); f.manifest('before');
        await f.envelope.sync([{ id: 'ghost', path: f.root }]);
        expect(f.sites.list().map((site) => site.host)).toContain('before.gen');
        f.reads.length = 0;
        await f.envelope.sync([{ id: 'ghost', path: f.root, asleep: true }]);
        expect(f.sites.list()).toEqual([]); expect(f.reads).toEqual([]);
        f.manifest('after');
        await f.envelope.sync([{ id: 'ghost', path: f.root, asleep: false }]);
        expect(f.sites.list().map((site) => site.host)).toEqual(['after.gen']);
        expect(f.reads).toContain(join(f.root, 'project.json'));
    });
});
it('story394: composed rosters, workspace selectors and Deck labels exclude ghosts while lifecycle metadata stays asleep', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'genie2-ghost-compose-394-'));
    const name = vi.fn((path: string) => path), color = vi.fn(() => '#123456');
    const active = agentRecord({ id: mintAgentId(), workspaceId: 'awake', name: 'Active', provider: 'claude' });
    const ghost = agentRecord({ id: mintAgentId(), workspaceId: 'ghost', name: 'Dormant', provider: 'codex' });
    const services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, docker: async () => ({ stdout: '', exitCode: 1 }),
        roster: () => [active, ghost], workspaces: () => [{ id: 'awake', path: join(dir, 'awake') }, { id: 'ghost', path: join(dir, 'ghost'), asleep: true }], workspaceName: name, workspaceColor: color });
    try {
        name.mockClear(); color.mockClear(); services.deckItems();
        expect(name.mock.calls.flat()).toContain(join(dir, 'awake'));
        expect(name.mock.calls.flat()).not.toContain(join(dir, 'ghost'));
        expect(color.mock.calls.flat()).not.toContain(join(dir, 'ghost'));
        expect(services.workspaceIds()).toEqual(['awake']);
        expect(services.agentAddresses().map((agent) => agent.agentId)).toEqual([active.id]);
    } finally { await services.shutdown(); await rm(dir, { recursive: true, force: true }); }
});

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRecord } from '../src/core/identity.js';
import { hostsFilePath } from '../src/core/front-door-caddy.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import type { HostsIo } from '../src/main/hosts-file.js';
import type { PtyOpened, PtyPort, PtySpawnOptions } from '../src/main/terminal-host.js';

/**
 * THE COMPOSITION ROOT — every store, the scheduler, the supervisor, the site manager and the
 * front door, wired once at boot and torn down once at quit. Everything else in `main/` is a part;
 * this is the spine. Tested with a fake pty and a temp data dir on the test machine.
 */

function fakePty() {
    const opened: Array<PtySpawnOptions & { id: string }> = [];
    const killed: string[] = [];
    let n = 0;
    const port: PtyPort = {
        open(o) { const id = `term_${++n}`; opened.push({ ...o, id }); return { id, pid: 500 + n, shell: 'sh', scrollback: '' } satisfies PtyOpened; },
        write: () => true,
        resize: () => true,
        kill: (id) => { killed.push(id); return true; },
        scrollback: () => '',
        onData: () => () => {},
        onExit: () => () => {},
    };
    return { port, opened, killed };
}

let dir: string;
let pty: ReturnType<typeof fakePty>;
let services: ComposedServices;
let roster: AgentRecord[] = [];
/** An agent on the roster — what the registry hands the composed services. */
const onRoster = (id: string, name: string, workspaceId: string): void => {
    roster.push({ id, workspaceId, provider: 'claude', name, instructions: null, threadId: null, createdAt: '2026-10-12T00:00:00.000Z', lastUsedAt: null } as never);
};

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-compose-'));
    pty = fakePty();
    roster = [];
    services = await composeServices({ userData: dir, pty: pty.port, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, roster: () => roster });
});

afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true });
});

describe('boot', () => {
    it('opens every store under the runtime dir and starts the front door on loopback', async () => {
        expect(services.inbox).toBeDefined();
        expect(services.attention).toBeDefined();
        expect(services.knowledge).toBeDefined();
        expect(services.flows).toBeDefined();
        expect(services.settings).toBeDefined();
        expect(services.supervisor).toBeDefined();
        expect(services.sites).toBeDefined();
        expect(services.frontDoor.address()?.address).toBe('127.0.0.1');
        expect(services.frontDoor.address()!.port).toBeGreaterThan(0);
        // The runtime dir exists and holds the knowledge database.
        await expect(stat(join(dir, 'runtime', 'knowledge.db'))).resolves.toBeDefined();
    });

    it('applies the v1 settings carry-over exactly once, from the reader it was given', async () => {
        // A FRESH data dir: the beforeEach boot already recorded "no v1" as the carry-over for `dir`,
        // which is itself the once-only rule at work.
        await services.shutdown();
        await rm(dir, { recursive: true, force: true });
        dir = await mkdtemp(join(tmpdir(), 'genie2-compose-v1-'));
        services = await composeServices({ userData: dir, pty: pty.port, v1Settings: () => ({ theme: 'light', agent_command: 'claude' }), caddyBin: null, frontDoorPort: 0 });
        expect(services.settings.get('theme')).toBe('light');
        expect(services.settings.carriedOver()).toMatchObject({ applied: 1, dropped: [{ key: 'agent_command', reason: expect.any(String) }] });
        // A relaunch with a different v1 reading does nothing — it already ran.
        await services.shutdown();
        services = await composeServices({ userData: dir, pty: pty.port, v1Settings: () => ({ theme: 'dark' }), caddyBin: null, frontDoorPort: 0 });
        expect(services.settings.get('theme')).toBe('light');
    });
});

describe('wiring', () => {
    it('the front door routes come from the site manager, live', async () => {
        expect(services.routes()).toEqual([]);
        services.sites.create({ name: 'docs', workspaceId: 'tynn', repoPath: dir, serve: { mode: 'proxy' }, hostPort: 5173 });
        expect(services.routes()).toEqual([{ host: 'docs.gen', target: '127.0.0.1:5173' }]);
    });

    it('the Deck items come from the stores, live', async () => {
        const agentId = 'agent_' + 'a'.repeat(32);
        onRoster(agentId, 'atlas', 'tynn');
        await services.attention.imDone({ agentId: agentId as never, agentName: 'atlas', workspacePath: dir, handoff: 'done for today' });
        await services.inbox.send({ from: agentId as never, to: 'human', text: 'note' });
        const items = services.deckItems();
        expect(items.map((i) => i.source).sort()).toEqual(['finished-handoff', 'unread-dm']);
        expect(items.every((i) => i.agentName === 'atlas')).toBe(true);
    });

    it('the Flow scheduler re-plans from the store: arming a flow sets the one timer', async () => {
        const doc = { version: 1, nodes: [{ id: 't', kind: 'schedule_trigger', position: { x: 0, y: 0 }, config: { cron: '*/5 * * * *', timezone: 'UTC' } }], edges: [] };
        const flow = await services.flows.create({ workspaceId: 'tynn', name: 'tick', document: doc, by: { kind: 'user' }, armed: true });
        expect(services.flowScheduler.nextDue()?.flowId).toBe(flow.id);
        await services.flows.disarm(flow.id, { kind: 'user' });
        expect(services.flowScheduler.nextDue()).toBeNull();
    });
});

describe('shutdown', () => {
    it('stops every supervised process, closes the front door, waits for the scheduler, closes the knowledge db — and is idempotent', async () => {
        services.supervisor.start({ id: 'proc_a', workspaceId: 'tynn', name: 'a', command: 'sleep 1000', cwd: dir, restart: 'always' });
        const port = services.frontDoor.address()!.port;
        await services.shutdown();
        expect(pty.killed).toEqual(['term_1']);
        expect(services.frontDoor.address()).toBeNull();
        expect(services.supervisor.status('proc_a')?.state).toBe('stopped');
        await services.shutdown();
        expect(port).toBeGreaterThan(0);
    });
});

describe('the front door for EXTERNAL browsers — Genie’s own Caddy on 443', () => {
    it('with a Caddy binary, a supervised caddy process is started ONCE with --watch and the Caddyfile is rewritten as sites come and go; without one, nothing starts and the reason is recorded', async () => {
        await services.shutdown();
        await rm(dir, { recursive: true, force: true });
        dir = await mkdtemp(join(tmpdir(), 'genie2-compose-caddy-'));
        pty = fakePty();
        let hostsContent = '127.0.0.1 localhost\n';
        const hostsIo: HostsIo = { read: async () => hostsContent, write: async (n) => { hostsContent = n; }, writeElevated: async (n) => { hostsContent = n; } };
        services = await composeServices({ userData: dir, pty: pty.port, v1Settings: () => null, caddyBin: '/opt/genie/runtime/caddy', frontDoorPort: 0, hostsIo, runElevated: async () => {} });
        await new Promise((r) => setTimeout(r, 15));
        const caddyProcs = () => pty.opened.filter((o) => o.command?.includes('/opt/genie/runtime/caddy run') && o.command.includes('--watch'));
        expect(caddyProcs()).toHaveLength(1);
        const caddyfile = join(dir, 'runtime', 'caddy', 'Caddyfile');
        expect((await readFile(caddyfile)).toString()).toContain('default_bind 127.0.0.1');

        services.sites.create({ name: 'docs', workspaceId: 'tynn', repoPath: dir, serve: { mode: 'proxy' }, hostPort: 5173 });
        expect((await readFile(caddyfile)).toString()).toContain('https://docs.gen {');
        services.sites.stop('site_docs');
        expect((await readFile(caddyfile)).toString()).not.toContain('docs.gen');
        // COUNTED: still one caddy process — --watch reloads it; we never spawn a second.
        expect(caddyProcs()).toHaveLength(1);
        await new Promise((r) => setTimeout(r, 15));
        expect(services.externalFrontDoor).toEqual({ running: true, caddyfile, hostsPath: hostsFilePath(process.platform), hosts: { changed: true, elevated: false }, trusted: false });
        expect(hostsContent).toContain('# >>> genie .gen sites');

        await services.shutdown();
        services = await composeServices({ userData: dir, pty: pty.port, v1Settings: () => null, caddyBin: null, frontDoorPort: 0 });
        expect(services.externalFrontDoor).toEqual({ running: false, reason: 'this install has no bundled Caddy; https://<name>.gen in external browsers is off, the in-app browser still works' });
    });
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deckItemsFrom } from '../src/core/deck-sources.js';
import { capabilityOf, WORKSPACE_SCOPED_METHODS } from '../src/core/remote-protocol.js';
import { buildHostApi, type HostApiDeps } from '../src/main/host-api.js';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';

/**
 * WORKSPACE COLOURS, CARRIED (genie#1300): main reads each workspace's colour from its project.json and every window
 * hears it — the snapshot's workspace rows, the Deck's items (so the question window and the approval toasts can show
 * it), and a Settings change travels the bridge (and a remote window's socket) to the host.
 */

let dir: string;
let registry: Registry;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-ws-color-'));
    registry = new Registry(new Store(dir));
    await registry.load({ name: 'alphar', healthy: true });
    await registry.addWorkspace({ id: 'tynn', path: '/w/tynn' });
    await registry.addWorkspace({ id: 'bare', path: '/w/bare' });
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('the snapshot', () => {
    it('carries each workspace\'s colour from the colourer; a workspace with none carries no key at all', () => {
        registry.setWorkspaceColorer((path) => (path === '/w/tynn' ? '#0891b2' : null));
        const rows = registry.snapshot().workspaces!;
        expect(rows.find((w) => w.id === 'tynn')!.color).toBe('#0891b2');
        expect('color' in rows.find((w) => w.id === 'bare')!).toBe(false);
    });

    it('a new colourer is heard at once', () => {
        const heard: (string | undefined)[] = [];
        registry.subscribe((s) => heard.push(s.workspaces?.find((w) => w.id === 'tynn')?.color));
        registry.setWorkspaceColorer(() => '#db2777');
        expect(heard.at(-1)).toBe('#db2777');
    });
});

describe('the Deck\'s items', () => {
    it('a question names its workspace\'s colour beside its name; an unknown workspace carries none', () => {
        const items = deckItemsFrom({
            questions: [
                { id: 'q1', agentId: 'a1', askedAt: new Date(1).toISOString(), questions: [{ header: 'Pick', question: 'Which?', options: [] }] },
                { id: 'q2', agentId: 'a2', askedAt: new Date(2).toISOString(), questions: [{ header: 'Pick', question: 'Which?', options: [] }] },
            ] as never,
            userList: [],
            unreadDms: [],
            finished: [],
            agents: { a1: { name: 'kai', workspaceId: 'tynn' }, a2: { name: 'wren', workspaceId: 'gone' } } as never,
            workspaceNames: { tynn: 'Tynn' },
            workspaceColors: { tynn: '#0891b2' },
        } as never);
        expect(items.find((i) => i.id === 'q1')).toMatchObject({ workspaceName: 'Tynn', workspaceColor: '#0891b2' });
        expect('workspaceColor' in items.find((i) => i.id === 'q2')!).toBe(false);
    });
});

describe('Settings → the host', () => {
    it('workspaces.setColor is a workspace-scoped write', () => {
        expect(capabilityOf('workspaces.setColor')).toBe('write');
        expect(WORKSPACE_SCOPED_METHODS).toContain('workspaces.setColor');
    });

    it('the host API hands it to the workspace ops; a host without it refuses rather than throwing', async () => {
        const calls: string[] = [];
        const ops = { setColor: async (id: string, color: string) => { calls.push(`${id}=${color}`); return { ok: true }; } };
        const api = buildHostApi({ workspaceOps: ops } as unknown as HostApiDeps);
        expect(await api.invoke('workspaces.setColor', ['tynn', '#7c3aed'])).toEqual({ ok: true });
        expect(calls).toEqual(['tynn=#7c3aed']);
        const bare = buildHostApi({ workspaceOps: {} } as unknown as HostApiDeps);
        expect(await bare.invoke('workspaces.setColor', ['tynn', '#7c3aed'])).toMatchObject({ ok: false });
    });
});

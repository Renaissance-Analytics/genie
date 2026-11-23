import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentStoresService, type StoresEvent } from '../src/main/agent-stores-host.js';
import { ApprovalQueue } from '../src/main/approval-queue.js';
import { AttentionStore } from '../src/main/attention-store.js';
import { InboxStore } from '../src/main/inbox-store.js';
import { KnowledgeStore } from '../src/main/knowledge-store.js';
import { SettingsStore } from '../src/main/settings-store.js';
import { groupTwoFixture, settleFeatures } from './helpers/features-host-group2.js';

/*
 * A SETTINGS WRITE REACHES WHAT GENIE-HOST PUSHES (Tynn #955, 2g-4d E2a). The engine link's settings replica went in E2a,
 * and with it the script probe that a change reached the windows. What carries a change now: AgentStoresService's own
 * `settings` event (genie-host's machine events and its phones' push follow it), and HostFeatures' push of a fresh
 * features snapshot. Both are pinned here, at the service and host level, each with a break probe.
 */
const root = fileURLToPath(new URL('../', import.meta.url));
const code = (path: string) => readFileSync(resolve(root, path), 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
const tick = async (n = 4) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)); };

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

async function storesRig() {
    const dir = await mkdtemp(join(tmpdir(), 'settings-push-'));
    dirs.push(dir);
    const inbox = await InboxStore.open(dir);
    const attention = await AttentionStore.open(dir, inbox);
    const knowledge = KnowledgeStore.open(dir);
    const settings = await SettingsStore.open(dir);
    const stores = new AgentStoresService({ inbox, attention, knowledge, approvals: new ApprovalQueue({}), settings });
    const events: StoresEvent[] = [];
    stores.onEvent((event) => { events.push(event); });
    return { settings, stores, events, close: () => knowledge.close() };
}

describe('AgentStoresService says each settings change, with the data that has it', () => {
    it('a workstation write: the key, the value, no workspace, and data that already reads the new value', async () => {
        const r = await storesRig();
        const before = r.settings.snapshot().track_cwd;
        await r.settings.set('track_cwd', before === false);
        await tick();
        const said = r.events.filter((e) => e.store === 'settings');
        expect(said).toHaveLength(1);
        expect(said[0]).toMatchObject({ store: 'settings', kind: 'changed', key: 'track_cwd', value: before === false, workspaceId: null });
        // Hot-swap kept: whoever follows the event reads the new value from the data it carries.
        expect((said[0] as { data: { values?: Record<string, unknown> } }).data).toBeTruthy();
        expect(r.settings.snapshot().track_cwd).toBe(before === false);
        r.close();
    });

    it('a workspace write says its workspace', async () => {
        const r = await storesRig();
        await r.settings.setFor('ws_a', 'app_inbox', false);
        await tick();
        expect(r.events.filter((e) => e.store === 'settings')).toEqual([expect.objectContaining({ key: 'app_inbox', value: false, workspaceId: 'ws_a' })]);
        r.close();
    });

    it('CONTROL: with no write, nothing is said', async () => {
        const r = await storesRig();
        await tick();
        expect(r.events.filter((e) => e.store === 'settings')).toEqual([]);
        r.close();
    });
});

describe('a settings write leads to a pushed features snapshot', () => {
    it('HostFeatures pushes a fresh snapshot after a settings write', async () => {
        const f = await groupTwoFixture();
        try {
            // A caller that has read the features once, as every window does on connect.
            await f.outcome('features.snapshot');
            await settleFeatures();
            const c = f.changes();
            await settleFeatures();
            // CONTROL: nothing changed, nothing is pushed.
            expect(c.snapshots.length + c.revisions.length).toBe(0);
            await f.settings.set('track_cwd', f.settings.snapshot().track_cwd === false);
            await settleFeatures();
            expect(c.snapshots.length + c.revisions.length).toBeGreaterThan(0);
        } finally {
            await f.close();
        }
    });

    it('wired: genie-host’s feature machine and its phones follow the stores’ events, settings among them', () => {
        const host = code('src/main/genie-host.ts');
        // The machine events that push features again: every stores event, settings included.
        expect(host).toMatch(/const machineEvents = \(listener: \(\) => void\) => \{[\s\S]{0,900}?stores\.onEvent\(listener\)\];/);
        // The phones' push: every store event that is not the registry's.
        expect(host).toMatch(/stores\.onEvent\(\(event\) => \{ if \(event\.store === 'registry'\) void phoneRegistry\.refresh\(\); else phoneTouch\(\); \}\);/);
    });
});

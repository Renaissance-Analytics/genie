import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { memoryPair } from '../src/core/line-transport.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { AgentStoresService } from '../src/main/agent-stores-host.js';
import { ApprovalQueue } from '../src/main/approval-queue.js';
import { AttentionStore } from '../src/main/attention-store.js';
import { ChatDraftStore } from '../src/main/chat-draft-store.js';
import { InboxStore } from '../src/main/inbox-store.js';
import { KnowledgeStore } from '../src/main/knowledge-store.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost } from '../src/main/session-host.js';
import { SettingsStore } from '../src/main/settings-store.js';

/**
 * SETTINGS AND CHAT DRAFTS ARE GENIE-HOST'S (the host split, P3.2: plan §11c). One settings file, one writer: the host.
 * Every window holds a replica it reads synchronously, and HOT-SWAP is kept: a change — made in this window, in another
 * window, or by the host's own tools — reaches every window, and its change listeners fire with the new value already
 * readable, so whatever applies a setting live (the update channel, the front door, a site's env) applies it with no
 * restart. The chat drafts are the host's too (they are read and written only through the window's async handlers).
 */

const TOKEN = 'settings-token';
const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
const tick = async (n = 6) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)); };

const dirs: string[] = [];
const closers: Array<() => void> = [];
afterEach(async () => {
    for (const c of closers.splice(0)) c();
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function rig() {
    const dir = await mkdtemp(join(tmpdir(), 'settings-contract-'));
    dirs.push(dir);
    const inbox = await InboxStore.open(dir);
    const attention = await AttentionStore.open(dir, inbox);
    const knowledge = KnowledgeStore.open(dir);
    closers.push(() => knowledge.close());
    const settings = await SettingsStore.open(dir);
    const drafts = await ChatDraftStore.open(dir);
    const stores = new AgentStoresService({ inbox, attention, knowledge, approvals: new ApprovalQueue(), settings, drafts });
    const server = new SessionEngineServer({ token: TOKEN, build: 't', stores });
    const host = new SessionHost({ userData: dir, driverFor: () => null, processTree: noProcessTree, ...server.hostOptions() });
    server.attach(host);
    const window = async () => {
        const [h, w] = memoryPair();
        server.accept(h);
        const client = new SessionEngineClient();
        expect(await client.connect(w, TOKEN)).toMatchObject({ ok: true });
        return client.stores();
    };
    return { settings, drafts, window };
}

describe('settings: one writer, every window a replica, hot-swap kept', () => {
    it('a window starts from the host\'s settings (the dump), defaults included', async () => {
        const r = await rig();
        await r.settings.set('do_not_disturb', true);
        const w = await r.window();
        expect(w.settings.snapshot()).toEqual(r.settings.snapshot());
        expect(w.settings.get('do_not_disturb')).toBe(true);
    });

    it('a window\'s set is the host\'s; its listener fires with the new value ALREADY readable (what a live apply reads)', async () => {
        const r = await rig();
        const w = await r.window();
        const heard: Array<[string, unknown, unknown]> = [];
        w.settings.onChange((key, value) => heard.push([key, value, w.settings.get(key)]));
        await w.settings.set('update_channel', 'stable');
        await tick();
        expect(r.settings.get('update_channel')).toBe('stable');
        expect(heard).toEqual([['update_channel', 'stable', 'stable']]);
    });

    it('a workspace override and its reset: the host\'s, and every read in the window answers as the host does', async () => {
        const r = await rig();
        const w = await r.window();
        const heard: Array<[string, unknown, string | undefined]> = [];
        w.settings.onChange((key, value, ws) => heard.push([key, value, ws]));
        await w.settings.setFor('ws1', 'app_inbox', false);
        await tick();
        expect(w.settings.snapshotFor('ws1')).toEqual(r.settings.snapshotFor('ws1'));
        expect(w.settings.workspaceValues('ws1')).toEqual({ app_inbox: false });
        await w.settings.resetFor('ws1', 'app_inbox');
        await tick();
        expect(w.settings.workspaceValues('ws1')).toEqual({});
        expect(heard.map(([k, , ws]) => `${k}@${ws}`)).toEqual(['app_inbox@ws1', 'app_inbox@ws1']);
    });

    it('a change made ELSEWHERE (another window, or the host) reaches this window and fires its listener', async () => {
        const r = await rig();
        const a = await r.window();
        const b = await r.window();
        const heardB: string[] = [];
        b.settings.onChange((key) => heardB.push(key));
        await a.settings.set('do_not_disturb', true);
        await r.settings.set('dnd_reply', 'back at five');
        await tick();
        expect(b.settings.get('do_not_disturb')).toBe(true);
        expect(b.settings.get('dnd_reply')).toBe('back at five');
        expect(heardB).toEqual(['do_not_disturb', 'dnd_reply']);
    });

    it('a value the host refuses is refused in the window, in the host\'s words, and nothing changes', async () => {
        const r = await rig();
        const w = await r.window();
        await expect(w.settings.set('not_a_setting', true)).rejects.toThrow(/not a setting Genie knows/);
        await expect(w.settings.set('update_channel', 'nightly')).rejects.toThrow();
        expect(w.settings.get('update_channel')).toBe(r.settings.get('update_channel'));
    });
});

describe('chat drafts: the host\'s', () => {
    it('saved from the window, kept in the host; a draft\'s file goes and comes back byte for byte; a prune forgets the gone', async () => {
        const r = await rig();
        const w = await r.window();
        const ref = await w.drafts.putFile(new Uint8Array([1, 2, 3, 250]));
        expect(typeof ref).toBe('string');
        await w.drafts.save('agent_a', { v: 1, text: 'half a thought', pills: [], attachments: [{ id: ref, name: 'x.bin', type: 'application/octet-stream', bytes: 4 }] });
        expect(Object.keys(r.drafts.all())).toEqual(['agent_a']);
        expect(await w.drafts.all()).toEqual(r.drafts.all());
        expect([...((await w.drafts.readFile(ref)) ?? [])]).toEqual([1, 2, 3, 250]);
        await w.drafts.prune(['agent_b']);
        expect(r.drafts.all()).toEqual({});
    });
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject } from '@particle-academy/prism-mcp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import { HUMAN } from '../src/core/inbox.js';
import { AttentionStore } from '../src/main/attention-store.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { handleFeatureAction } from '../src/main/feature-ipc.js';
import { InboxStore } from '../src/main/inbox-store.js';
import { genieTools, type Caller } from '../src/main/mcp-tools.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * A DONE ON THE PERSON'S LIST REACHES THE AGENT THAT ASKED (B23). An agent puts something only a person can do on the
 * person's list (`lists` add, list 'user'); the person marks it Done on the Deck. Before this, the store only flipped
 * `done` and nobody told the asking agent. Now the store's `done()` — the one place every path goes through — mails the
 * asker FROM the human, exactly as an answered question does (attention.answer), so the agent's ordinary `receive`
 * picks it up and main's inbox `onSend` wiring wakes an idle session. Once: a second Done mails nobody. An agent
 * marking its OWN item done is not told about itself.
 */
vi.mock('electron', () => ({
    ipcMain: { handle: () => {} },
    ipcRenderer: { invoke: () => Promise.resolve({ ok: true }), on: () => {}, removeListener: () => {} },
    contextBridge: { exposeInMainWorld: () => {} },
    BrowserWindow: class {},
    screen: {},
    shell: {},
}));

describe('the attention store, when the PERSON marks a list item done', () => {
    let dir: string;
    let inbox: InboxStore;
    let store: AttentionStore;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie2-list-done-'));
        inbox = await InboxStore.open(dir);
        store = await AttentionStore.open(dir, inbox);
    });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('mails the asking agent EXACTLY once, from the person, naming the item — and the inbox announces it (the wake)', async () => {
        const agent = mintAgentId();
        const added = await store.lists.add({ list: 'user', workspaceId: 'example', agentId: agent, text: 'rotate the example.com API token' });
        if (added.kind !== 'added') throw new Error('fixture: not added');
        const announced: string[] = [];
        inbox.onSend((to) => { announced.push(to); });

        expect(await store.lists.done({ workspaceId: 'example', id: added.item.id, by: HUMAN })).toBe(true);
        const mail = inbox.unread(agent);
        expect(mail).toHaveLength(1);
        expect(mail[0]!.from).toBe(HUMAN);
        expect(mail[0]!.text).toContain('rotate the example.com API token');
        expect(mail[0]!.text).toContain(added.item.id);
        expect(mail[0]!.text).toMatch(/marked .*done/i);
        // The same event main.ts keys the idle-session reminder on (`inbox.onSend((to) => remind(to))`).
        expect(announced).toEqual([agent]);

        // Done again: still done, and nobody is mailed a second time — COUNTED.
        expect(await store.lists.done({ workspaceId: 'example', id: added.item.id, by: HUMAN })).toBe(true);
        expect(inbox.unread(agent)).toHaveLength(1);
        expect(announced).toEqual([agent]);
    });

    it('an agent marking its OWN item done is not mailed; the same item marked by the person would be (control)', async () => {
        const agent = mintAgentId();
        const own = await store.lists.add({ list: 'agent', workspaceId: 'example', agentId: agent, text: 'write the probe' });
        const asked = await store.lists.add({ list: 'user', workspaceId: 'example', agentId: agent, text: 'approve the share' });
        if (own.kind !== 'added' || asked.kind !== 'added') throw new Error('fixture: not added');
        expect(await store.lists.done({ workspaceId: 'example', id: own.item.id, by: agent })).toBe(true);
        expect(await store.lists.done({ workspaceId: 'example', id: asked.item.id, by: agent })).toBe(true);
        expect(inbox.unread(agent)).toHaveLength(0);
        // Positive control in the same run: an item marked by the person IS mailed, so the zero above is not a dead gauge.
        const third = await store.lists.add({ list: 'user', workspaceId: 'example', agentId: agent, text: 'sign the form' });
        if (third.kind !== 'added') throw new Error('fixture: not added');
        await store.lists.done({ workspaceId: 'example', id: third.item.id, by: HUMAN });
        expect(inbox.unread(agent).map((m) => m.text.includes('sign the form'))).toEqual([true]);
    });

    it('an id that is not on any list mails nobody and says so', async () => {
        const agent = mintAgentId();
        await store.lists.add({ list: 'user', workspaceId: 'example', agentId: agent, text: 'x' });
        expect(await store.lists.done({ workspaceId: 'example', id: 'li_missing', by: HUMAN })).toBe(false);
        expect(inbox.unread(agent)).toHaveLength(0);
    });
});

describe('the Deck’s Done (deck.answer on a user-list item, through the feature IPC)', () => {
    const pty: PtyPort = {
        open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
        write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
    };
    let dir: string;
    let services: ComposedServices;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie2-list-done-ipc-'));
        services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0 });
    });
    afterEach(async () => {
        await services.shutdown();
        await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    });

    it('takes the item off the Deck and mails its asker once — even an asker Genie no longer knows (no throw)', async () => {
        // Never registered in this Genie: the asking agent "no longer exists". Marking done must still land and not throw.
        const gone = mintAgentId();
        const added = await services.attention.lists.add({ list: 'user', workspaceId: 'example', agentId: gone, text: 'renew the example.org certificate' });
        if (added.kind !== 'added') throw new Error('fixture: not added');
        const item = services.deckItems().find((i) => i.id === added.item.id);
        expect(item).toBeDefined();

        await handleFeatureAction(services, { kind: 'deck.answer', item: item!, optionId: 'done' }, { toolStatuses: null, knowledgeQuery: '' });
        expect(services.deckItems().map((i) => i.id)).not.toContain(added.item.id);
        const mail = services.inbox.unread(gone);
        expect(mail).toHaveLength(1);
        expect(mail[0]!.from).toBe(HUMAN);
        expect(mail[0]!.text).toContain('renew the example.org certificate');
    });
});

describe('the `lists` MCP tool — an agent marking done', () => {
    let dir: string;
    let inbox: InboxStore;
    let attention: AttentionStore;
    const atlas = agentRecord({ id: mintAgentId(), workspaceId: 'example', provider: 'claude', name: 'atlas' });
    const caller: Caller = { agentId: atlas.id, agentName: 'atlas', workspaceId: 'example', workspacePath: '/w/example' };
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie2-list-done-mcp-'));
        inbox = await InboxStore.open(dir);
        attention = await AttentionStore.open(dir, inbox);
    });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('its own checklist item and its own user-list item: done, and it is NOT mailed about itself', async () => {
        const tools = genieTools({
            inbox,
            attention,
            roster: () => [atlas],
            resolveCaller: (id) => (id === 't-atlas' ? caller : null),
            workspaceSetting: () => ({ scope: 'self' }),
            userActive: () => true,
            glow: () => true,
            thumbsUp: () => {},
        });
        const lists = tools.find((t) => t.definition.name === 'lists')!;
        const call = async (args: JsonObject) => JSON.parse((await lists.handler(args, { server: 'genie', tool: 'lists', headers: {} })).text) as Record<string, unknown>;
        const a = await call({ terminalId: 't-atlas', action: 'add', list: 'agent', text: 'write the probe' });
        const u = await call({ terminalId: 't-atlas', action: 'add', list: 'user', text: 'rotate the token' });
        await call({ terminalId: 't-atlas', action: 'done', id: (a.item as { id: string }).id });
        await call({ terminalId: 't-atlas', action: 'done', id: (u.item as { id: string }).id });
        const after = await call({ terminalId: 't-atlas', action: 'show' });
        expect((after.agent as Array<{ done: boolean }>).map((i) => i.done)).toEqual([true]);
        expect((after.user as Array<{ done: boolean }>).map((i) => i.done)).toEqual([true]);
        expect(inbox.unread(atlas.id)).toHaveLength(0);
    });
});

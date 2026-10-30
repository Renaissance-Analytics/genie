import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, type AgentRecord } from '../src/core/identity.js';
import { HUMAN } from '../src/core/inbox.js';
import { pairKey } from '../src/core/inbox-threads.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { featureSnapshot, handleFeatureAction } from '../src/main/feature-ipc.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * WHAT THE AGENTINBOX FLYOUT ASKS MAIN FOR (beta.33 item 19), through the real stores: every thread (agent-to-agent too),
 * a thread's history by its key or by a message in it (a chat's mail row), an attachment's bytes in any thread (Genie 1
 * let the person download from every thread), Mark all read, and Delete thread — which must never let a seq be given
 * twice, or the next message would read as already read.
 */
const pty: PtyPort = {
    open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
};
let dir: string;
let services: ComposedServices;
let roster: AgentRecord[];
const state = { toolStatuses: null, knowledgeQuery: '' };

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-inbox-flyout-'));
    roster = [
        agentRecord({ id: 'agent_atlas' as never, workspaceId: 'tynn', provider: 'claude', name: 'atlas' }),
        agentRecord({ id: 'agent_wren' as never, workspaceId: 'tynn', provider: 'claude', name: 'wren' }),
    ];
    services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, roster: () => roster, docker: async () => ({ stdout: '', exitCode: 1 }), portFree: async () => true });
});
afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

describe('the snapshot', () => {
    it('lists every thread — the person’s and agent-to-agent — by name, and the mail agents have not collected', async () => {
        await services.inbox.send({ from: HUMAN, to: 'agent_atlas' as never, text: 'hi atlas' });
        await services.inbox.send({ from: 'agent_atlas' as never, to: 'agent_wren' as never, text: 'over to you' });
        const data = await featureSnapshot(services, state);
        expect(data.inbox!.threads!.map((t) => [t.key, t.aName, t.bName, t.withHuman])).toEqual([
            [pairKey('agent_atlas', 'agent_wren'), 'atlas', 'wren', false],
            [pairKey('agent_atlas', HUMAN), 'atlas', 'you', true],
        ]);
        expect(data.inbox!.uncollected).toBe(2);
        // A pushed snapshot never carries a thread or an attachment: those are answers.
        expect(data.inbox!.thread).toBeNull();
        expect(data.inbox!.servedAttachment).toBeNull();
        expect(data.inbox!.peers.map((p) => p.agentId)).toEqual(['agent_atlas', 'agent_wren']);
    });
});

describe('a thread', () => {
    it('by its key: the newest `limit`, and whether there are more; by a message in it: the same thread, that message marked', async () => {
        const sent = [];
        for (let i = 0; i < 4; i++) sent.push(await services.inbox.send({ from: i % 2 ? 'agent_atlas' as never : HUMAN, to: i % 2 ? HUMAN : 'agent_atlas' as never, text: `#${i}` }));
        await services.inbox.send({ from: HUMAN, to: 'agent_wren' as never, text: 'other' });
        const key = pairKey(HUMAN, 'agent_atlas');
        const a = (await handleFeatureAction(services, { kind: 'inbox.thread', key, limit: 3 }, state)).inbox!.thread!;
        expect([a.key, a.messages.map((m) => m.text), a.more, a.focus]).toEqual([key, ['#1', '#2', '#3'], true, null]);
        const b = (await handleFeatureAction(services, { kind: 'inbox.thread', messageId: sent[0]!.id, limit: 50 }, state)).inbox!.thread!;
        expect([b.key, b.messages.length, b.more, b.focus]).toEqual([key, 4, false, sent[0]!.id]);
        await expect(handleFeatureAction(services, { kind: 'inbox.thread', messageId: 'msg_nope', limit: 50 }, state)).rejects.toThrow('no message msg_nope');
    });
});

describe('attachments', () => {
    it('the person downloads one from an agent-to-agent thread too (Genie 1’s rule); an unknown id is refused by name', async () => {
        const file = join(dir, 'plan.md');
        await writeFile(file, '# the plan');
        const msg = await services.inbox.send({ from: 'agent_atlas' as never, to: 'agent_wren' as never, text: 'see attached', attachments: [file], workspaceRoot: dir });
        const served = (await handleFeatureAction(services, { kind: 'inbox.attachment', attachmentId: msg.attachments[0]!.id }, state)).inbox!.servedAttachment!;
        expect(served.name).toBe('plan.md');
        expect(Buffer.from(served.base64, 'base64').toString('utf8')).toBe('# the plan');
        await expect(handleFeatureAction(services, { kind: 'inbox.attachment', attachmentId: 'att_nope' }, state)).rejects.toThrow('no attachment att_nope');
    });
});

describe('read and delete', () => {
    it('Mark all read reads every message to the person (positive control: two were unread)', async () => {
        await services.inbox.send({ from: 'agent_atlas' as never, to: HUMAN, text: 'one' });
        await services.inbox.send({ from: 'agent_wren' as never, to: HUMAN, text: 'two' });
        expect(services.inbox.unread(HUMAN)).toHaveLength(2);
        await handleFeatureAction(services, { kind: 'inbox.markAllRead' }, state);
        expect(services.inbox.unread(HUMAN)).toHaveLength(0);
    });

    it('Delete thread removes that pair’s mail only — and the next message is NEW, never read by a seq given twice', async () => {
        await services.inbox.send({ from: HUMAN, to: 'agent_wren' as never, text: 'keep me' });
        await services.inbox.send({ from: HUMAN, to: 'agent_atlas' as never, text: 'a' });
        await services.inbox.send({ from: HUMAN, to: 'agent_atlas' as never, text: 'b' });
        // atlas reads its two: its cursor reaches the newest seq.
        await services.inbox.receive({ participant: 'agent_atlas' as never });
        await handleFeatureAction(services, { kind: 'inbox.deleteThread', key: pairKey(HUMAN, 'agent_atlas') }, state);
        expect(services.inbox.all().map((m) => m.text)).toEqual(['keep me']);
        // The next message to atlas must be unread for atlas: a reused seq would sit at or under its cursor.
        await services.inbox.send({ from: HUMAN, to: 'agent_atlas' as never, text: 'after the delete' });
        expect(services.inbox.unread('agent_atlas' as never).map((m) => m.text)).toEqual(['after the delete']);
        await expect(handleFeatureAction(services, { kind: 'inbox.deleteThread', key: 'not-a-thread' }, state)).rejects.toThrow('not a thread');
    });
});

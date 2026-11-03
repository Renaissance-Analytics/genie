import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId, type AgentId } from '../src/core/identity.js';
import { appSenderId, type AppMessageMeta } from '../src/core/app-inbox.js';
import type { LiveSession } from '../src/core/roster.js';
import type { GateView } from '../src/core/rate-limit-gate.js';
import { AttentionStore } from '../src/main/attention-store.js';
import { InboxStore } from '../src/main/inbox-store.js';
import { genieTools } from '../src/main/mcp-tools.js';

const sender = agentRecord({ id: mintAgentId(), workspaceId: 'work', provider: 'codex', name: 'worker', accessScope: 'self' });
const recipient = agentRecord({ id: mintAgentId(), workspaceId: 'work', provider: 'claude', name: 'coordinator', accessScope: 'self' });
const outsider = agentRecord({ id: mintAgentId(), workspaceId: 'other', provider: 'codex', name: 'outsider', accessScope: 'self' });
let dir: string;
let inbox: InboxStore;
let sessions: Map<AgentId, Partial<LiveSession>>;
const now = () => '2026-11-03T23:00:00.000Z';
const ratePause: GateView = { state: 'paused', window: 'session', resetsAtMs: 1000, resumeAtMs: 2000, message: 'private provider diagnostics' };

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-paused-inbox-'));
    sessions = new Map([[recipient.id, { limit: ratePause }]]);
    // Read the current snapshot on every arrival, including after the agent resumes.
    inbox = await InboxStore.open(dir, now, (id: AgentId) => sessions.get(id) ?? null);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });

async function sendThroughTool(caller = sender) {
    const attention = await AttentionStore.open(dir, inbox);
    const tool = genieTools({
        inbox, attention, roster: () => [sender, recipient, outsider],
        resolveCaller: () => ({ agentId: caller.id, agentName: caller.name, workspaceId: caller.workspaceId, workspacePath: dir }),
        workspaceSetting: () => ({ scope: 'self' }),
        userActive: () => true, glow: () => true, thumbsUp: () => {},
    }).find((t) => t.definition.name === 'agentinbox')!;
    const result = await tool.handler({ action: 'send', terminalId: 'worker', to: recipient.id, text: 'I need your decision.' }, { server: 'genie', tool: 'agentinbox', headers: {} });
    return { isError: result.isError, ...JSON.parse(result.text) };
}

describe('mail to a paused agent', () => {
    it('automatically replies through the real tool/store path, keeping the original unread', async () => {
        const result = await sendThroughTool();
        expect(result).toMatchObject({ ok: true, delivered: 1 });
        const received = await inbox.receive({ participant: recipient.id, acknowledge: false });
        expect(received.cursor).toBe(0);
        expect(received.messages).toHaveLength(1);
        expect(received.messages[0]).toMatchObject({ from: sender.id, to: recipient.id, text: 'I need your decision.', readAt: null });
        const reply = await inbox.receive({ participant: sender.id, acknowledge: false });
        expect(reply.messages).toHaveLength(1);
        expect(reply.messages[0]).toMatchObject({
            from: recipient.id, to: sender.id, attachments: [], readAt: null,
            automaticReply: { kind: 'paused', inReplyTo: received.messages[0]!.id },
        });
        expect(reply.messages[0]!.text).toMatch(/automatic reply from Genie/i);
        expect(reply.messages[0]!.text).toMatch(/paused/i);
        expect(reply.messages[0]!.text).toMatch(/if you are blocked.*ask your user for guidance/i);
        expect(reply.messages[0]!.text).not.toContain('private provider diagnostics');
        expect(reply.messages[0]!.text).not.toContain('I need your decision.');
        // The sending agent learns this from send itself, without polling or ending its turn first.
        expect(result.note).toBe(reply.messages[0]!.text);
        expect(inbox.receipts(sender.id)[0]!.readAt).toBeNull();
    });

    it('keeps both messages durable without generating another reply on reopening', async () => {
        await inbox.send({ from: sender.id, to: recipient.id, text: 'Waiting on a decision.' });
        const reopened = await InboxStore.open(dir, now, (id: AgentId) => sessions.get(id) ?? null);
        expect(reopened.all()).toHaveLength(2);
        expect((await reopened.receive({ participant: sender.id, acknowledge: false })).messages).toHaveLength(1);
        expect((await reopened.receive({ participant: recipient.id, acknowledge: false })).messages[0]!.readAt).toBeNull();
    });

    it('creates only one reply when BOTH agents are paused and emits both durable arrivals', async () => {
        sessions.set(sender.id, { limit: ratePause });
        const arrived: string[] = [];
        inbox.onSend((to) => { arrived.push(to); });
        await inbox.send({ from: sender.id, to: recipient.id, text: 'Both held.' });
        expect(inbox.all()).toHaveLength(2);
        expect(arrived).toEqual([recipient.id, sender.id]);
    });

    it('does not grant conversation-opening permission from an automatic status reply', async () => {
        await inbox.send({ from: sender.id, to: recipient.id, text: 'Status?' });
        expect(inbox.all()).toHaveLength(2);
        expect(inbox.hasWritten(sender.id, recipient.id)).toBe(true);
        expect(inbox.hasWritten(recipient.id, sender.id)).toBe(false);
        await inbox.send({ from: recipient.id, to: sender.id, text: 'An actual reply.' });
        expect(inbox.hasWritten(recipient.id, sender.id)).toBe(true);
    });

    it('checks pause state per arrival and keeps simultaneous messages and replies distinct', async () => {
        await Promise.all([
            inbox.send({ from: sender.id, to: recipient.id, text: 'One.' }),
            inbox.send({ from: sender.id, to: recipient.id, text: 'Two.' }),
        ]);
        expect(inbox.all()).toHaveLength(4);
        expect(new Set(inbox.all().map((m) => m.seq)).size).toBe(4);
        const originals = inbox.all().filter((m) => m.to === recipient.id);
        const replies = inbox.all().filter((m) => m.to === sender.id);
        expect(replies.map((m) => m.automaticReply!.inReplyTo).sort()).toEqual(originals.map((m) => m.id).sort());
        sessions.delete(recipient.id);
        await inbox.send({ from: sender.id, to: recipient.id, text: 'Resumed.' });
        expect(inbox.all()).toHaveLength(5);
    });

    it('does not disclose paused state or send anything when the caller cannot reach the target', async () => {
        const result = await sendThroughTool(outsider);
        expect(result).toMatchObject({ ok: false, isError: true });
        expect(result.error).toMatch(/not reachable/i);
        expect(inbox.all()).toHaveLength(0);
    });

    it('does not auto-reply to human, app or self mail', async () => {
        const app: AppMessageMeta = { source: { kind: 'site', id: 'test', name: 'test', workspaceId: 'work' }, label: 'site:test@work', subject: 'Status', level: 'info' };
        await inbox.send({ from: 'human', to: recipient.id, text: 'Hello.' });
        await inbox.send({ from: appSenderId(app.source), to: recipient.id, text: 'App event.', app });
        await inbox.send({ from: recipient.id, to: recipient.id, text: 'A note to myself.' });
        expect(inbox.all()).toHaveLength(3);
    });

    it('preserves normal delivery when no pause probe is configured', async () => {
        const ordinary = await InboxStore.open(join(dir, 'ordinary'), now);
        await ordinary.send({ from: sender.id, to: recipient.id, text: 'Ordinary mail.' });
        expect(ordinary.all()).toHaveLength(1);
    });

    it('still delivers ordinary mail if the availability probe fails', async () => {
        const unknown = await InboxStore.open(join(dir, 'unknown'), now, () => { throw new Error('probe unavailable'); });
        await unknown.send({ from: sender.id, to: recipient.id, text: 'Keep this message.' });
        expect(unknown.all()).toHaveLength(1);
        expect(unknown.all()[0]!.text).toBe('Keep this message.');
    });

    it.each<GateView>([
        ratePause,
        { state: 'retrying', nextTryAtMs: 2000, attempt: 1, message: null },
        { state: 'needs-person', message: null },
    ])('replies for a $state rate-limit gate', async (limit) => {
        sessions.set(recipient.id, { limit });
        await inbox.send({ from: sender.id, to: recipient.id, text: 'Are you available?' });
        expect(inbox.all()).toHaveLength(2);
    });

    it('replies for a provider account pause even after the provider stopped the run', async () => {
        sessions.set(recipient.id, { running: false, accountPaused: { reason: 'billing_error', words: 'private account diagnostics' } });
        await inbox.send({ from: sender.id, to: recipient.id, text: 'Are you available?' });
        expect(inbox.all()).toHaveLength(2);
        expect(inbox.all()[1]!.text).not.toContain('private account diagnostics');
    });

    it.each<[string, Partial<LiveSession> | null]>([
        ['unknown session', null],
        ['stopped', { running: false }],
        ['idle', { running: true, turnState: 'idle' }],
        ['busy', { running: true, turnState: 'working' }],
        ['open rate-limit gate', { limit: { state: 'open' } }],
        ['signed out', { signedOut: true }],
    ])('does not call an agent paused merely because it is %s', async (_name, session) => {
        if (session) sessions.set(recipient.id, session); else sessions.delete(recipient.id);
        await inbox.send({ from: sender.id, to: recipient.id, text: 'Ordinary delivery.' });
        expect(inbox.all()).toHaveLength(1);
    });
});

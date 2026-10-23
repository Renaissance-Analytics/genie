import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import { chatMessages } from '../src/core/chat-view.js';
import type { DriverEvents, TurnOutcomeLike } from '../src/core/session.js';
import { SessionHost } from '../src/main/session-host.js';
import { ChatFlyout } from '../src/renderer/components/ChatFlyout.js';
import { buildHostApi, type HostApiDeps } from '../src/main/host-api.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function open(provider: 'codex' | 'claude' = 'codex') {
    const dir = await mkdtemp(join(tmpdir(), 'genie-queued-input-'));
    let events: DriverEvents = {};
    let busy = false;
    let refusal: string | null = null;
    const prompts: unknown[] = [];
    const options: ConstructorParameters<typeof SessionHost>[0] = {
        userData: dir,
        processTree: { snapshot: () => [], killTree: () => ({ killed: 0, refused: false }) },
        driverFor: () => (options) => {
            events = options.events;
            return {
                start() {}, kill() { busy = false; }, cancel() {},
                cliSessionId: null,
                prompt(content) {
                    if (refusal) throw new Error(refusal);
                    if (provider === 'codex' && busy) throw new Error('Codex turn already in flight');
                    busy = true;
                    prompts.push(content);
                },
            };
        },
    };
    const host = new SessionHost(options);
    const record = agentRecord({ id: mintAgentId(), workspaceId: 'w', name: 'worker', provider });
    expect(host.start(record, dir)).toEqual({ ok: true });
    cleanups.push(async () => { host.stopAll(); await host.settled(); await rm(dir, { recursive: true, force: true }); });
    const messages = () => chatMessages({ agent: { ...record, fidelity: 'declared' }, session: host.probe(record.id), rows: host.ledgerFor(record.id) });
    const end = (stopReason: TurnOutcomeLike['stopReason'] = 'end_turn', isError = false) => {
        busy = false;
        events.onTurnEnd?.({ stopReason, isError, raw: null });
    };
    return { host, record, prompts, messages, end, dir, reopen: () => {
        const reopened = new SessionHost(options);
        cleanups.unshift(async () => { reopened.stopAll(); await reopened.settled(); });
        return reopened;
    }, holdProvider: () => {
        busy = false;
        events.onTurnEnd?.({ stopReason: null, isError: true, raw: 'error', failure: { kind: 'rate_limit', reason: 'rate_limit' } });
    }, refuse: (reason: string | null) => { refusal = reason; }, protocolError: () => events.onProtocolError?.('transport failed'), exit: () => events.onExit?.(1, null) };
}

describe('input sent during a Codex turn', () => {
    it('shows input waiting for a provider pause to end, and preserves input already queued before that pause', async () => {
        const s = await open();
        s.host.promptWith(s.record.id, 'first', []);
        s.host.promptWith(s.record.id, 'before pause', []);
        s.holdProvider();
        s.host.promptWith(s.record.id, 'during pause', []);
        expect(s.messages().slice(1).map(m => [m.text, m.delivered, m.queued])).toEqual([['before pause', false, true], ['during pause', false, true]]);
        const html = renderToStaticMarkup(<ChatFlyout thread={{ agentId: s.record.id, name: 'worker', fidelity: 'declared', unread: null, messages: s.messages(), context: null }} onSend={() => {}} onClose={() => {}} />);
        expect(html).toContain('Queued · waiting for the provider to resume');
        expect(html).not.toContain('Not delivered.');
    });

    it('is visible immediately as waiting, then delivered once in FIFO order as your own turns', async () => {
        const s = await open();
        expect(s.host.promptWith(s.record.id, 'first task', [])).toEqual({ ok: true });
        expect(s.host.promptWith(s.record.id, 'next task', [])).toEqual({ ok: true });
        expect(s.host.promptWith(s.record.id, 'third task', [])).toEqual({ ok: true });
        expect(s.prompts).toEqual(['first task']);
        expect(s.messages().map((m) => [m.text, m.who, m.delivered])).toEqual([
            ['first task', 'you', true], ['next task', 'you', false], ['third task', 'you', false],
        ]);
        const html = renderToStaticMarkup(<ChatFlyout thread={{ agentId: s.record.id, name: 'worker', fidelity: 'declared', unread: null, messages: s.messages(), context: null }} onSend={() => {}} onClose={() => {}} />);
        expect(html).toContain('Queued · waiting for the current turn to end');
        expect(html).not.toContain('Not delivered.');
        s.end();
        expect(s.prompts).toEqual(['first task', 'next task']);
        expect(s.messages().map((m) => m.delivered)).toEqual([true, true, false]);
        s.end();
        expect(s.prompts).toEqual(['first task', 'next task', 'third task']);
        expect(s.messages().map((m) => m.delivered)).toEqual([true, true, true]);
        s.end();
        expect(s.prompts).toHaveLength(3);
        expect(s.host.ledgerFor(s.record.id).filter((r) => r.event.kind === 'turn').map((r) => r.event)).toEqual([
            { kind: 'turn', n: 1, by: 'you' }, { kind: 'turn', n: 2, by: 'you' }, { kind: 'turn', n: 3, by: 'you' },
        ]);
        await s.host.settled();
    });

    it('keeps queued input after cancelling the current turn, including its image', async () => {
        const s = await open();
        s.host.promptWith(s.record.id, 'first', []);
        const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        expect(s.host.promptWith(s.record.id, 'use this', [{ name: 'ref.png', type: 'image/png', bytes }])).toEqual({ ok: true });
        expect(s.host.cancel(s.record.id)).toEqual({ ok: true });
        s.end('cancelled');
        expect(s.prompts).toEqual(['first', [{ type: 'text', text: 'use this' }, { type: 'image', mimeType: 'image/png', data: Buffer.from(bytes).toString('base64') }]]);
        expect(s.messages().find((m) => m.text === 'use this')).toMatchObject({ who: 'you', delivered: true, attachments: ['ref.png'] });
    });

    it.each(['stop', 'exit', 'failure', 'protocol failure'] as const)('keeps unsent input as a recoverable draft on %s', async (how) => {
        const s = await open();
        s.host.promptWith(s.record.id, 'first', []);
        s.host.promptWith(s.record.id, 'do not lose this', []);
        if (how === 'stop') s.host.stop(s.record.id);
        else if (how === 'exit') s.exit();
        else if (how === 'protocol failure') s.protocolError();
        else s.end(null, true);
        await s.host.settled();
        await vi.waitFor(() => expect(s.messages().find((m) => m.text === 'do not lose this')).toBeDefined());
        const message = s.messages().find((m) => m.text === 'do not lose this');
        expect(message).toMatchObject({ who: 'you', delivered: false, resend: 'restart' });
        const html = renderToStaticMarkup(<ChatFlyout thread={{ agentId: s.record.id, name: 'worker', fidelity: 'declared', unread: null, messages: message ? [message] : [], context: null }} onSend={() => {}} onClose={() => {}} onRestartAndSend={() => {}} />);
        expect(html).toContain('Restart worker and send');
        expect(s.prompts).toEqual(['first']);
    });

    it('keeps Claude accepting input mid-turn (control)', async () => {
        const s = await open('claude');
        s.host.promptWith(s.record.id, 'first', []);
        s.host.promptWith(s.record.id, 'steer now', []);
        expect(s.prompts).toEqual(['first', 'steer now']);
        expect(s.messages().map((m) => m.delivered)).toEqual([true, true]);
    });

    it('reports an idle driver rejection so the composer can keep a draft; a failed drain preserves the whole queue', async () => {
        const s = await open();
        s.refuse('stdin closed');
        expect(s.host.promptWith(s.record.id, 'keep in composer', [])).toEqual({ ok: false, reason: 'stdin closed' });
        expect(s.messages()).toEqual([]);
        s.refuse(null);
        s.host.promptWith(s.record.id, 'first', []);
        s.host.promptWith(s.record.id, 'second', []);
        s.host.promptWith(s.record.id, 'third', []);
        s.refuse('stdin closed');
        s.end();
        expect(s.prompts).toEqual(['first']);
        expect(s.messages().slice(1).map((m) => [m.text, m.delivered, m.queued])).toEqual([['second', false, false], ['third', false, false]]);
    });

    it('a remote user prompt uses the same queue and credits you; an inbox notice keeps its sender and mail', async () => {
        const s = await open();
        const api = buildHostApi({ host: s.host, find: (id: string) => id === s.record.id ? s.record : null } as unknown as HostApiDeps);
        s.host.promptWith(s.record.id, 'first', []);
        expect(await api.invoke('prompt', [s.record.id, 'from phone'])).toEqual({ ok: true });
        expect(s.host.prompt(s.record.id, 'collect your mail', 'genie', { mail: [{ id: 'mail1', from: 'human', fromName: null, sentAt: '2026-10-23T00:00:00Z', text: 'direction' }] })).toBe(true);
        expect(s.prompts).toEqual(['first']);
        s.end();
        expect(s.prompts).toEqual(['first', 'from phone']);
        expect(s.host.ledgerFor(s.record.id).filter((r) => r.event.kind === 'turn').at(-1)?.event).toMatchObject({ by: 'you' });
        s.end();
        expect(s.prompts).toEqual(['first', 'from phone', 'collect your mail']);
        expect(s.messages().find((m) => m.who === 'delivery')).toMatchObject({ from: 'genie → worker', mail: [{ id: 'mail1', from: 'you', subject: 'direction' }] });
    });

    it('reopens an unsent image draft from disk, retries once, and discards another without sending', async () => {
        const s = await open();
        s.host.promptWith(s.record.id, 'first', []);
        const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        s.host.promptWith(s.record.id, 'keep image', [{ name: 'ref.png', type: 'image/png', bytes }]);
        s.host.promptWith(s.record.id, 'discard me', []);
        const [image, discarded] = s.messages().filter((m) => !m.delivered);
        expect(image?.promptId).toEqual(expect.any(String));
        s.host.stop(s.record.id);
        await s.host.settled();
        const reopened = s.reopen();
        expect(reopened.start(s.record, s.dir)).toEqual({ ok: true });
        expect(await reopened.resolvePrompt(s.record.id, discarded!.promptId!, 'discard')).toEqual({ ok: true });
        const retries = await Promise.all([
            reopened.resolvePrompt(s.record.id, image!.promptId!, 'send'),
            reopened.resolvePrompt(s.record.id, image!.promptId!, 'send'),
        ]);
        expect(retries.map((r) => r.ok)).toEqual([true, false]);
        expect(s.prompts).toEqual(['first', [{ type: 'text', text: 'keep image' }, { type: 'image', mimeType: 'image/png', data: Buffer.from(bytes).toString('base64') }]]);
        await reopened.settled();
        await vi.waitFor(() => {
            const messages = chatMessages({ agent: { ...s.record, fidelity: 'declared' }, session: reopened.probe(s.record.id), rows: reopened.ledgerFor(s.record.id) });
            expect(messages.filter((m) => m.text === 'keep image')).toHaveLength(1);
            expect(messages.find((m) => m.text === 'keep image')).toMatchObject({ delivered: true, attachments: ['ref.png'] });
            expect(messages.some((m) => m.text === 'discard me')).toBe(false);
        });
    });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { chatMessages, withDrafts, type Draft } from '../src/core/chat-view.js';
import { mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { attachmentsFromRenderer, type PromptBlock } from '../src/core/prompt-content.js';
import { AgentSession, type SessionDriver, type SessionDriverFactory } from '../src/core/session.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import { openDurableStore } from '../src/core/thread-store.js';
import { ChatFlyout, type ChatThread } from '../src/renderer/components/ChatFlyout.js';

/**
 * THE FILES GO THE WHOLE WAY, OR THE MESSAGE SAYS WHY THEY DID NOT. The owner's beta.20 composer showed `attach`
 * and dropped the file: every hop — flyout, IPC, host, session, driver — carried text only. Here each hop is held
 * to carrying them: the IPC payload is validated whole, the session hands the driver the content blocks and records
 * the file names on your message, the thread shows them, and a refused message is KEPT with its files and the
 * host's reason (no "Restart and send" — restarting would not change the reason).
 */
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const noProcessTree: ProcessTree = { descendantsOf: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
const bytes = new Uint8Array([1, 2, 3]);

describe('the IPC payload', () => {
    it('is the files whole, or null when any one is malformed — counted', () => {
        expect(attachmentsFromRenderer(undefined)).toEqual([]);
        expect(attachmentsFromRenderer([{ name: 'a.txt', type: 'text/plain', bytes }])).toEqual([{ name: 'a.txt', type: 'text/plain', bytes }]);
        expect(attachmentsFromRenderer([{ name: 'b.bin', type: '', bytes: bytes.buffer }])![0]!.bytes).toEqual(bytes);
        const bad: unknown[] = ['x', [{ name: '', type: '', bytes }], [{ name: 'a', type: 1, bytes }], [{ name: 'a', type: '', bytes: 'AQID' }], [{ name: 'ok', type: '', bytes }, null]];
        expect(bad.filter((b) => attachmentsFromRenderer(b) !== null)).toEqual([]);
    });
});

describe('the session', () => {
    it('hands the driver the content blocks and records the file names on your message', async () => {
        const prompted: unknown[] = [];
        const factory: SessionDriverFactory = () => {
            const driver: SessionDriver = { start: () => {}, prompt: (c) => { prompted.push(c); }, kill: () => {}, get running() { return true; }, get cliSessionId() { return null; } };
            return driver;
        };
        const dir = mkdtempSync(join(tmpdir(), 'genie2-attach-'));
        dirs.push(dir);
        const rows: StreamEvent[] = [];
        const session = new AgentSession({ agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir), driverFactory: factory, processTree: noProcessTree, onEvent: (e) => { rows.push(e); } });
        session.start();
        const content: PromptBlock[] = [{ type: 'text', text: 'see this' }, { type: 'image', mimeType: 'image/png', data: 'AQID' }];
        session.prompt('see this', 'you', { content, attachments: ['shot.png'] });
        session.prompt('plain', 'you');
        expect(prompted).toEqual([content, 'plain']);
        await vi.waitFor(() => expect(rows.filter((r) => r.kind === 'message')).toHaveLength(2));
        expect(rows.filter((r) => r.kind === 'message')).toEqual([
            { kind: 'message', speaker: 'you', peerName: null, text: 'see this', attachments: ['shot.png'] },
            { kind: 'message', speaker: 'you', peerName: null, text: 'plain' },
        ]);
    });
});

describe('the thread', () => {
    const detail = { agent: { id: 'a1', name: 'lark' }, rows: [{ id: 'r1', at: 1, event: { kind: 'message', speaker: 'you', peerName: null, text: 'see this', attachments: ['shot.png'] } as StreamEvent }] };

    it('your message carries its file names; a draft keeps its files and the host’s reason', () => {
        expect(chatMessages(detail as never)[0]).toMatchObject({ text: 'see this', attachments: ['shot.png'] });
        const draft: Draft = { id: 'd1', agentId: 'a1', text: 'and this', at: 2, attachments: [{ name: 'data.bin', type: '', bytes }], reason: 'data.bin is neither an image nor a text file, so it cannot be sent to an agent' };
        const t = withDrafts({ agentId: 'a1', messages: [] }, [draft]);
        expect(t.messages[0]).toMatchObject({ delivered: false, attachments: ['data.bin'], reason: draft.reason });
    });

    it('the flyout shows the files, and a refused draft says why — with no Restart, which would not change it', () => {
        const thread: ChatThread = {
            agentId: 'a1', name: 'lark', fidelity: 'declared', unread: null, context: null, chips: [],
            messages: [
                { id: 'm1', who: 'you', from: 'you', text: 'see this', delivered: true, at: 1, attachments: ['shot.png'] },
                { id: 'd1', who: 'you', from: 'you', text: 'and this', delivered: false, at: 2, attachments: ['data.bin'], reason: 'data.bin is neither an image nor a text file, so it cannot be sent to an agent' },
                { id: 'd2', who: 'you', from: 'you', text: 'later', delivered: false, at: 3 },
            ],
        };
        const html = renderToStaticMarkup(<ChatFlyout thread={thread} pinned={false} contextTokens={200_000} onSend={() => {}} onTogglePin={() => {}} onClose={() => {}} onRestartAndSend={() => {}} />);
        expect(html).toMatch(/data-chat-attachments="m1"[\s\S]*?shot\.png/);
        expect(html).toMatch(/data-chat-attachments="d1"[\s\S]*?data\.bin/);
        expect(html).toContain('Not delivered. data.bin is neither an image nor a text file');
        // Restart and send: only on the draft the agent being stopped explains (positive control: d2 has it).
        expect(html.match(/data-action="restart-and-send"/g)).toHaveLength(1);
        expect(html).toMatch(/data-draft="d2"/);
    });
});

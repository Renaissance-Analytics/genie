import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeToAcp } from '@particle-academy/prism-acp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chatFollowKey, chatThreadFrom } from '../src/core/chat-view.js';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * THE AGENT'S WORDS IN THE CHAT AS IT WRITES THEM (beta.33 item 6). The owner: "I need to be able to send you msgs while
 * you are mid-turn"; the agent's text reached the chat only when its message "closed".
 *
 * MEASURED, end to end through Genie's own path with Claude's real frames: Claude's stream-json (with
 * `--include-partial-messages`, prism-acp's `claudeArgs`) is translated by prism-acp's own `ClaudeToAcp`, handed to the
 * session, and the host's ledger and its push are read after EVERY delta. The words are there, growing, and the host
 * announces each one — so the session and the host never held them (part 1 below, green before the fix too).
 *
 * WHERE THEY WERE HELD: the chat's scroller followed the end of the thread only when the NUMBER of messages changed
 * (`ChatFlyout`'s layout effect keyed on `messageCount`). A reply is one row that GROWS, so its words were written
 * below the fold of a chat that did not move — until the next message (a new count) scrolled them into view: exactly
 * "when the message closes". The scroller now follows `chatFollowKey`, which moves with the last message's length too.
 */

const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
let dir: string;
let host: SessionHost;
let events: DriverEvents = {};
const driverFor: DriverFor = (record) => {
    if (record.provider !== 'claude') return null;
    const factory: SessionDriverFactory = (options) => {
        events = options.events;
        return { start: () => {}, prompt: () => {}, kill: () => {}, get cliSessionId() { return null; } };
    };
    return factory;
};
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-mid-turn-'));
    host = new SessionHost({ userData: dir, driverFor, processTree: noProcessTree });
});
afterEach(async () => {
    host.stopAll();
    await host.settled();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

describe('1 — the session and the host never hold the words (the measurement)', () => {
    it('every delta of Claude’s reply reaches the ledger and is announced, as it arrives — mid-turn, before the message closes', () => {
        const record = agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'claude', name: 'moic' });
        expect(host.start(record, dir)).toEqual({ ok: true });
        host.prompt(record.id, 'run the tests', 'you');
        let announced = 0;
        const off = host.subscribe((id) => { if (id === record.id) announced += 1; });
        const toAcp = new ClaudeToAcp();
        const feed = (frame: Record<string, unknown>): void => { for (const u of toAcp.frame(frame)) events.onUpdate?.(u as Record<string, unknown>); };
        const said = (): string[] => chatThreadFrom({ agent: { id: record.id, name: 'moic', provider: 'claude', fidelity: 'declared' }, session: host.probe(record.id), rows: host.ledgerFor(record.id) }, record.id, [], () => 0)
            .messages.filter((m) => m.who === 'agent').map((m) => m.text);

        feed({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_1', usage: {} } } });
        feed({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
        const seen: string[][] = [];
        for (const piece of ['Running ', 'the suite ', 'now.']) {
            const before = announced;
            feed({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } } });
            expect(announced, `announced on "${piece}"`).toBeGreaterThan(before);
            seen.push(said());
        }
        // One row, growing — before any block stop, message stop or turn end.
        expect(seen).toEqual([['Running '], ['Running the suite '], ['Running the suite now.']]);
        off();
    });
});

describe('2 — the chat follows a reply as it grows', () => {
    const msg = (id: string, text: string) => ({ id, who: 'agent' as const, from: 'moic', text, delivered: true, at: 1 });

    it('the follow key moves when the last message GROWS, not only when a message is added (positive control: a new message moves it)', () => {
        const a = chatFollowKey('moic', [msg('e1', 'hi'), msg('e2', 'Running ')]);
        const grown = chatFollowKey('moic', [msg('e1', 'hi'), msg('e2', 'Running the suite ')]);
        const added = chatFollowKey('moic', [msg('e1', 'hi'), msg('e2', 'Running '), msg('e3', 'x')]);
        expect(grown).not.toBe(a);
        expect(added).not.toBe(a);
        // Nothing changed, nothing moves.
        expect(chatFollowKey('moic', [msg('e1', 'hi'), msg('e2', 'Running ')])).toBe(a);
        // Another agent's thread is a new key (opening a thread starts at its end).
        expect(chatFollowKey('lark', [msg('e1', 'hi'), msg('e2', 'Running ')])).not.toBe(a);
    });

    it('the chat’s scroller follows that key — not the message count, which a growing reply never changes', () => {
        const src = readFileSync(new URL('../src/renderer/components/ChatFlyout.tsx', import.meta.url), 'utf8')
            .split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
        expect(src.match(/const followKey = chatFollowKey\(thread\?\.agentId \?\? null, thread\?\.messages \?\? \[\]\);/g) ?? []).toHaveLength(1);
        // The one scroll effect: it follows to the end when the reader is there, keyed on followKey (and on the live
        // window's size, core/chat-window.ts, so a page of history keeps the reader's place) — never on a message count.
        expect(src.match(/else if \(followRef\.current\) el\.scrollTop = el\.scrollHeight;\s*\}, \[followKey, lines\]\);/g) ?? []).toHaveLength(1);
        expect(src).not.toMatch(/\[thread\?\.agentId, messageCount\]/);
    });
});

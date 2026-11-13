import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeDriver } from '@particle-academy/prism-acp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { openAgentThread, openDurableStore } from '../src/core/thread-store.js';
import { AgentSession, type SessionDriverFactory } from '../src/core/session.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import { driverEvents } from '../src/main/session-host.js';

/**
 * Tynn #684 against prism-acp's REAL ClaudeDriver (the version this tree pins), not a model of it: a stand-in Claude Code
 * CLI that does what the owner's ledger shows Claude Code doing — a prompt written while a turn runs is FOLDED into that
 * turn and gets no `result` of its own. The driver then holds every later turn's end behind it
 * (test/turn-end-held-684.test.ts says why); the next prompt's turn must still end in Genie.
 *
 * The stand-in: a prompt whose text starts with `HOLD` opens a turn that stays open until the next prompt arrives; that
 * prompt is folded in, and the held turn's `result` (naming the HOLD prompt) closes it. Any other prompt is a turn of its
 * own: a line of reply and its `result`.
 */
const dirs: string[] = [];
const sessions: AgentSession[] = [];
afterEach(async () => {
    for (const s of sessions.splice(0)) { await s.stop('SIGTERM'); await s.settled(); }
    // A temporary folder the stand-in CLI ran in: Windows may still hold it for a moment after the stop; left for the OS.
    for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); } catch { /* left behind */ } }
});
const noTree: ProcessTree = { snapshot: () => [], killTree: (p) => ({ killed: p.length, refused: false }) };

const FOLDING_CLI = `'use strict';
const sessionId = '7f0b6c0e-2a51-4c8e-9a3d-5b1f2e7c9d10';
const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');
const textOf = (content) => typeof content === 'string' ? content : (Array.isArray(content) ? content.map((b) => (b && b.text) || '').join('') : '');
let call = 0;
const say = (text) => {
    call += 1;
    send({ type: 'stream_event', session_id: sessionId, parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'msg_' + call, usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } } });
    send({ type: 'stream_event', session_id: sessionId, parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
};
const result = (uuid) => send({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: 'done', session_id: sessionId, user_message_uuid: uuid, duration_ms: 1, num_turns: 1, total_cost_usd: 0.01, usage: { input_tokens: 100, output_tokens: 5 }, modelUsage: { 'claude-test': { contextWindow: 200000 } } });
let holding = null;
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
    buffer += d;
    let nl;
    while ((nl = buffer.indexOf('\\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const frame = JSON.parse(line);
        if (frame.type === 'control_request') {
            send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { models: [], claude_code_version: '2.1.400' } } });
            continue;
        }
        if (frame.type !== 'user') continue;
        const text = textOf(frame.message && frame.message.content);
        if (holding !== null) {
            // FOLDED: read inside the running turn, no result of its own; the running turn ends now.
            say('answered both');
            result(holding);
            holding = null;
            continue;
        }
        send({ type: 'system', subtype: 'init', session_id: sessionId, tools: [], mcp_servers: [], model: 'claude-test' });
        if (text.startsWith('HOLD')) { say('reading it'); holding = frame.uuid; continue; }
        say('reply to: ' + text);
        result(frame.uuid);
    }
});
process.stdin.on('end', () => process.exit(0));
`;

function open() {
    const dir = mkdtempSync(join(tmpdir(), 'genie-turn-held-real-'));
    dirs.push(dir);
    const script = join(dir, 'claude.cjs');
    writeFileSync(script, FOLDING_CLI);
    const factory: SessionDriverFactory = (options) => new ClaudeDriver({ cwd: dir, binary: process.execPath, binaryArgs: [script] }, driverEvents(options.events));
    const store = openDurableStore(dir);
    const id = mintAgentId();
    // Live rows: a reply still streaming is not in the ledger until its turn ends.
    const live: StreamEvent[] = [];
    const session = new AgentSession({ agentId: id, cwd: dir, store, driverFactory: factory, processTree: noTree, turnsBefore: 0, onEvent: (e) => { live.push(e); } });
    sessions.push(session);
    session.start();
    const ledger = async () => {
        await session.settled();
        return (await openAgentThread(store, id).messages()).map((r) => r.message as { kind: string; n?: number; by?: string | null; speaker?: string; text?: string });
    };
    return { session, ledger, live };
}

describe('the real ClaudeDriver, after a prompt Claude folded into a turn', () => {
    it('the next prompt\'s turn ends: `finished`, idle, and the turn after it is a turn of its own', async () => {
        const { session, ledger, live } = open();
        session.deliver('HOLD AgentInbox delivery: 1 message', 'genie');
        await vi.waitFor(() => expect(live.some((e) => e.kind === 'message' && e.speaker === 'agent')).toBe(true), { timeout: 15_000 });
        expect(session.turnState).toBe('working');
        // Written while turn 1 runs: Claude folds it in.
        session.deliver('AgentInbox delivery: 1 more message', 'genie');
        await vi.waitFor(() => expect(session.turnState).toBe('idle'), { timeout: 15_000 });
        expect((await ledger()).filter((e) => e.kind === 'finished').map((e) => e.n)).toEqual([1]);

        // The flow's prompt: the driver holds its end behind the folded one.
        session.deliver('Hourly round', 'flow "hourly round"');
        await vi.waitFor(async () => expect((await ledger()).filter((e) => e.kind === 'finished').map((e) => e.n)).toEqual([1, 2]), { timeout: 15_000 });
        expect(session.turnState).toBe('idle');
        expect(session.promptable).toBe(true);

        // An inbox notice after it: its own turn, ended too.
        session.deliver('AgentInbox delivery: 1 message (from an app)', 'genie');
        await vi.waitFor(async () => expect((await ledger()).filter((e) => e.kind === 'finished').map((e) => e.n)).toEqual([1, 2, 3]), { timeout: 15_000 });
        expect(session.turnState).toBe('idle');
        expect((await ledger()).filter((e) => e.kind === 'turn').map((e) => `${e.n}:${e.by}`)).toEqual(['1:genie', '2:flow "hourly round"', '3:genie']);
    }, 60_000);
});

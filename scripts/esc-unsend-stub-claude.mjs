#!/usr/bin/env node
/**
 * A STUB CLAUDE CODE THAT STAYS MID-TURN, for the Esc-unsend proof (Tynn #1029, scripts/esc-unsend-cdp.mjs); never in
 * the suite.
 *
 * Genie's send buffer holds a message only while the chat's agent is BUSY (core/send-grace.ts), so the proof needs an
 * agent that stays mid-turn: the first `user` frame opens a turn that streams a word every second and does not end for
 * `HOLD_MS`. Every `user` frame is written down THE MOMENT IT ARRIVES, mid-turn or not, to `RECEIVED` (one JSON line
 * each: its text, the names and sizes of any files, and when). That file is what the agent actually got, which is how the
 * proof tells "never reached the agent" from "hidden in the UI".
 *
 * Pointed at through `GENIE2_CLAUDE_BINARY`, the way a non-standard install would be; the product behaves identically.
 * prism-acp hands the child a filtered environment, so the place is fixed, not an env var (as stub-claude-chat.mjs).
 */
import { appendFileSync } from 'node:fs';

const RECEIVED = '/tmp/genie-esc-unsend-received.jsonl';
const HOLD_MS = 150_000;
const MODELS = [{ value: 'default', displayName: 'Default (recommended)', description: 'Use the default model', resolvedModel: 'claude-opus-5-5' }];
const SESSION = '7a1d3c5e-2b4f-4e6a-8c0d-1e2f3a4b5c6d';
const CLI_VERSION = '2.1.310';
let turn = 0;

const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const note = (text) => process.stderr.write(`[esc-unsend-stub] ${text}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const event = (e) => send({ type: 'stream_event', session_id: SESSION, parent_tool_use_id: null, event: e });

function record(message) {
    const blocks = Array.isArray(message?.content) ? message.content : typeof message?.content === 'string' ? [{ type: 'text', text: message.content }] : [];
    const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join(' ');
    const files = blocks.filter((b) => b?.type !== 'text').map((b) => ({ type: b?.type, media: b?.source?.media_type ?? null, bytes: typeof b?.source?.data === 'string' ? Buffer.from(b.source.data, 'base64').byteLength : null }));
    appendFileSync(RECEIVED, `${JSON.stringify({ at: Date.now(), text, files })}\n`);
    note(`received ${JSON.stringify(text.slice(0, 80))} with ${files.length} file block(s)`);
}

async function answer(n) {
    const id = `msg_esc_${n}`;
    send({ type: 'system', subtype: 'init', session_id: SESSION, claude_code_version: CLI_VERSION, model: 'claude-opus-5-5', tools: [], mcp_servers: [], cwd: process.cwd() });
    event({ type: 'message_start', message: { id, usage: { input_tokens: 10, output_tokens: 1 } } });
    event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    // Turn 1 stays open (the agent is busy); any later one ends at once.
    const words = n === 1 ? Math.ceil(HOLD_MS / 1000) : 3;
    for (let i = 0; i < words; i++) {
        event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `${i === 0 ? '' : ' '}working${i}` } });
        await sleep(n === 1 ? 1000 : 50);
    }
    event({ type: 'content_block_stop', index: 0 });
    event({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: words } });
    event({ type: 'message_stop' });
    send({ type: 'assistant', session_id: SESSION, parent_tool_use_id: null, message: { id, model: 'claude-opus-5-5', content: [{ type: 'text', text: `turn ${n} done` }], usage: { input_tokens: 10, output_tokens: words } } });
    send({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', session_id: SESSION, num_turns: 1, result: `turn ${n} done`, usage: { input_tokens: 10, output_tokens: words } });
}

let chain = Promise.resolve();
function handle(frame) {
    if (frame?.type === 'control_request') {
        const id = frame.request_id;
        const subtype = frame.request?.subtype;
        if (subtype === 'initialize') return send({ type: 'control_response', response: { subtype: 'success', request_id: id, response: { models: MODELS, claude_code_version: CLI_VERSION } } });
        return send({ type: 'control_response', response: { subtype: 'success', request_id: id, response: {} } });
    }
    if (frame?.type === 'user') {
        record(frame.message);
        const n = ++turn;
        // The first opens the long turn; one arriving mid-turn is read by it, as the real CLI reads one at its next step.
        if (n === 1) chain = chain.then(() => answer(1)).catch((e) => note(`turn failed: ${e?.message ?? e}`));
        return;
    }
    note(`ignoring a ${String(frame?.type)} frame`);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
        if (!line) continue;
        try { handle(JSON.parse(line)); } catch { note(`unparseable frame: ${line.slice(0, 120)}`); }
    }
});
process.stdin.on('end', () => { void chain.then(() => process.exit(0)); });
note('ready');

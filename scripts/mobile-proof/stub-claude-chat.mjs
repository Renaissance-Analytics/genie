#!/usr/bin/env node
/**
 * A STUB CLAUDE CODE THAT ANSWERS A TURN — for the phone's live proof (genie#1346), never in the suite.
 *
 * `scripts/stub-claude.mjs` answers `initialize` and nothing else, on purpose. The phone's proof has to show a message
 * SENT from a phone, a reply STREAMING back into the phone's chat, and a photo taken on the phone ARRIVING at the agent
 * as a file. So this one also answers a `user` frame the way the real CLI does under
 * `--input-format stream-json --output-format stream-json --include-partial-messages`: an `init`, the reply as
 * `text_delta`s a few words at a time, then a `result`.
 *
 * WHAT THE AGENT RECEIVED is written down: every image block's bytes are saved under
 * `/tmp/genie-stub-claude-received/` (prism-acp hands the child a filtered environment, so the place is fixed, not an env
 * var), and the reply names each one with its type, byte count and whether its bytes ARE that image (JPEG/PNG
 * signature). It is pointed at through `GENIE2_CLAUDE_BINARY`, the way a non-standard install would be; the product
 * behaves identically.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = '/tmp/genie-stub-claude-received';
const MODELS = [{ value: 'default', displayName: 'Default (recommended)', description: 'Use the default model', resolvedModel: 'claude-opus-5-5' }];
const SESSION = '5f0c2a4e-8b1d-4c3a-9e7f-1a2b3c4d5e6f';
const CLI_VERSION = '2.1.310';
let received = 0;
let turn = 0;

const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const note = (text) => process.stderr.write(`[stub-claude-chat] ${text}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function signatureOf(bytes) {
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
    return 'unknown';
}

async function answer(message) {
    turn += 1;
    const blocks = Array.isArray(message?.content) ? message.content : [];
    const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join(' ').trim();
    const files = [];
    for (const b of blocks) {
        if (b?.type !== 'image' || b.source?.type !== 'base64') continue;
        const bytes = Buffer.from(String(b.source.data), 'base64');
        received += 1;
        mkdirSync(OUT, { recursive: true });
        const name = `received-${received}.${b.source.media_type === 'image/png' ? 'png' : 'jpg'}`;
        writeFileSync(join(OUT, name), bytes);
        files.push(`${name} (${b.source.media_type}, ${bytes.byteLength} bytes, signature ${signatureOf(bytes)})`);
    }
    const reply = [
        `**Got it.** You said: "${text || '(no text)'}".`,
        files.length > 0 ? `I received ${files.length} image file${files.length > 1 ? 's' : ''}: ${files.join('; ')}.` : 'No files came with it.',
        'This reply is streaming to you a few words at a time.',
    ].join(' ');
    send({ type: 'system', subtype: 'init', session_id: SESSION, claude_code_version: CLI_VERSION, model: 'claude-opus-5-5', tools: [], mcp_servers: [], cwd: process.cwd() });
    const id = `msg_stub_${turn}`;
    send({ type: 'stream_event', session_id: SESSION, parent_tool_use_id: null, event: { type: 'message_start', message: { id, usage: { input_tokens: 10, output_tokens: 1 } } } });
    send({ type: 'stream_event', session_id: SESSION, parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
    const words = reply.split(' ');
    for (let i = 0; i < words.length; i += 3) {
        send({ type: 'stream_event', session_id: SESSION, parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `${i === 0 ? '' : ' '}${words.slice(i, i + 3).join(' ')}` } } });
        await sleep(120);
    }
    send({ type: 'stream_event', session_id: SESSION, parent_tool_use_id: null, event: { type: 'content_block_stop', index: 0 } });
    send({ type: 'stream_event', session_id: SESSION, parent_tool_use_id: null, event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: words.length } } });
    send({ type: 'stream_event', session_id: SESSION, parent_tool_use_id: null, event: { type: 'message_stop' } });
    send({ type: 'assistant', session_id: SESSION, parent_tool_use_id: null, message: { id, model: 'claude-opus-5-5', content: [{ type: 'text', text: reply }], usage: { input_tokens: 10, output_tokens: words.length } } });
    send({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', session_id: SESSION, num_turns: 1, result: reply, usage: { input_tokens: 10, output_tokens: words.length } });
    note(`answered turn ${turn}: ${files.length} image(s)`);
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
        chain = chain.then(() => answer(frame.message)).catch((e) => note(`turn failed: ${e?.message ?? e}`));
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

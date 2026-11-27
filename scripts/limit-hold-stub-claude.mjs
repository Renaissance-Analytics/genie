#!/usr/bin/env node
/**
 * A STAND-IN CLAUDE CODE FOR THE LIMIT-HOLD ROW (Tynn #1089, scripts/limit-hold-cdp.mjs); never in the suite, never on a desktop.
 *
 * Per CLAUDE_CONFIG_DIR, from `status.json` beside this file:
 *  - `auth status --json`: who is signed in there;
 *  - a usage probe (`--no-session-persistence`): that folder's limits as a `rate_limit_event`, then ends;
 *  - an agent turn in a folder marked `spent`: refused as Claude Code refuses a spent week — a `rate_limit_event` with the
 *    seven_day window `rejected`, the assistant's `error: "rate_limit"` with "You've hit your weekly limit · resets …", and an
 *    errored result;
 *  - an agent turn anywhere else: "got: <what it was sent>", so the row can see the message arrive in THAT folder.
 * `initDelayMs`: the folder's CLI answers `initialize` that much later (a start that can be seen). Every launch and every
 * message received is written to `calls.jsonl` beside this file.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const dir = process.env.CLAUDE_CONFIG_DIR || null;
const probe = args.includes('--no-session-persistence');
const log = (entry) => appendFileSync(join(HERE, 'calls.jsonl'), `${JSON.stringify({ at: Date.now(), dir, probe, ...entry })}\n`);
log({ args });
const status = () => { try { return JSON.parse(readFileSync(join(HERE, 'status.json'), 'utf8')); } catch { return {}; } };
const mine = () => status()[dir ?? ''] ?? {};

if (args[0] === '--version' || args[0] === '-v') { console.log('2.1.330 (Claude Code)'); process.exit(0); }
if (args[0] === 'auth' && args[1] === 'status') {
    const s = status()[dir ?? ''];
    if (!s) { console.log(JSON.stringify({ loggedIn: false, authMethod: 'none', ...(dir ? { configDirectory: dir } : {}) })); process.exit(1); }
    const { spent: _spent, initDelayMs: _delay, used: _used, ...shown } = s;
    console.log(JSON.stringify(shown)); process.exit(0);
}

const CLI_VERSION = '2.1.330';
const SESSION = '5b0c6a1e-84d2-4c3f-9e7a-1089aaaa0001';
const MODELS = [{ value: 'default', displayName: 'Default (recommended)', description: 'Use the default model', resolvedModel: 'claude-opus-5-5' }];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const event = (e) => send({ type: 'stream_event', session_id: SESSION, parent_tool_use_id: null, event: e });
const WEEK_RESET = () => Math.floor(Date.now() / 1000) + 6 * 86400;
const WEEKLY = "You've hit your weekly limit · resets Dec 3, 7am";

let turn = 0;
async function answer(n, said) {
    const id = `msg_1089_${n}`;
    send({ type: 'system', subtype: 'init', session_id: SESSION, claude_code_version: CLI_VERSION, model: 'claude-opus-5-5', tools: [], mcp_servers: [], cwd: process.cwd() });
    const s = mine();
    if (!probe && s.spent === true) {
        send({ type: 'rate_limit_event', session_id: SESSION, rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day', resetsAt: WEEK_RESET(), isUsingOverage: false, unifiedWindows: { seven_day: { utilization: 1, resetsAt: WEEK_RESET() } } } });
        send({ type: 'assistant', session_id: SESSION, parent_tool_use_id: null, error: 'rate_limit', message: { id, model: '<synthetic>', content: [{ type: 'text', text: WEEKLY }], usage: { input_tokens: 0, output_tokens: 0 } } });
        send({ type: 'result', subtype: 'success', is_error: true, stop_reason: 'stop_sequence', session_id: SESSION, num_turns: 1, result: WEEKLY, usage: { input_tokens: 0, output_tokens: 0 } });
        return;
    }
    const used = typeof s.used === 'number' ? s.used : 0.35;
    const now = Math.floor(Date.now() / 1000);
    send({ type: 'rate_limit_event', session_id: SESSION, rate_limit_info: { status: 'allowed', rateLimitType: 'seven_day', resetsAt: now + 3 * 86400, isUsingOverage: false, unifiedWindows: { seven_day: { utilization: used, resetsAt: now + 3 * 86400 } } } });
    const text = probe ? 'OK' : `got: ${said.slice(0, 80)}`;
    event({ type: 'message_start', message: { id, usage: { input_tokens: 5, output_tokens: 1 } } });
    event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
    event({ type: 'content_block_stop', index: 0 });
    event({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } });
    event({ type: 'message_stop' });
    send({ type: 'assistant', session_id: SESSION, parent_tool_use_id: null, message: { id, model: 'claude-opus-5-5', content: [{ type: 'text', text }], usage: { input_tokens: 5, output_tokens: 1 } } });
    send({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', session_id: SESSION, num_turns: 1, result: text, usage: { input_tokens: 5, output_tokens: 1 } });
}

let chain = Promise.resolve();
function handle(frame) {
    if (frame?.type === 'control_request') {
        const subtype = frame.request?.subtype;
        const response = subtype === 'initialize' ? { models: MODELS, claude_code_version: CLI_VERSION } : {};
        const delay = subtype === 'initialize' && typeof mine().initDelayMs === 'number' ? mine().initDelayMs : 0;
        const reply = () => send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response } });
        if (delay > 0) { void sleep(delay).then(reply); return; }
        return reply();
    }
    if (frame?.type === 'user') {
        const n = ++turn;
        const content = frame.message?.content;
        const said = typeof content === 'string' ? content : Array.isArray(content) ? content.map((b) => (b && b.type === 'text' ? b.text : '')).join(' ') : '';
        log({ said });
        chain = chain.then(() => answer(n, said)).catch((e) => process.stderr.write(`[1089-stub] turn failed: ${e?.message ?? e}\n`));
    }
}
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    buffer += chunk;
    for (let nl = buffer.indexOf('\n'); nl !== -1; nl = buffer.indexOf('\n')) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) { try { handle(JSON.parse(line)); } catch { /* not a frame */ } }
    }
});
process.stdin.on('end', () => { void chain.then(() => process.exit(0)); });

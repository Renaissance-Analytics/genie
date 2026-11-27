#!/usr/bin/env node
/**
 * A STAND-IN CLAUDE CODE FOR THE USAGE-ON-SWITCH ROW (Tynn #1084, scripts/usage-on-switch-cdp.mjs); never in the suite, never
 * on a desktop.
 *
 * It answers what Genie asks of Claude Code, per CLAUDE_CONFIG_DIR, as the real CLI does:
 *  - `auth status --json`: who is signed in where, from `status.json` beside this file (the default home: no variable);
 *  - `--print --input-format stream-json` with `--no-session-persistence`: Genie's usage probe. It waits PROBE_DELAY_MS (so the
 *    window's "Reading usage…" can be seen), reports that folder's limits as a `rate_limit_event`, and ends the turn;
 *  - the same without it: an agent. Its first turn reports the folder's limit; a prompt that asks for "a long piece of work"
 *    then stays open for HOLD_MS (the agent is busy, so it cannot move at a clean idle); any other turn ends at once.
 * Every launch is written to `calls.jsonl` beside this file (its arguments and folder), which is how the row proves the probe
 * ran in the right folder with the right flags. prism-acp hands the child a filtered environment, so the place is beside the
 * file, never a variable.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const dir = process.env.CLAUDE_CONFIG_DIR || null;
const probe = args.includes('--no-session-persistence');
appendFileSync(join(HERE, 'calls.jsonl'), `${JSON.stringify({ at: Date.now(), args, dir, probe })}\n`);
const status = () => { try { return JSON.parse(readFileSync(join(HERE, 'status.json'), 'utf8')); } catch { return {}; } };

if (args[0] === '--version' || args[0] === '-v') { console.log('2.1.330 (Claude Code)'); process.exit(0); }
if (args[0] === 'auth' && args[1] === 'status') {
    const s = status()[dir ?? ''];
    if (!s) { console.log(JSON.stringify({ loggedIn: false, authMethod: 'none', ...(dir ? { configDirectory: dir } : {}) })); process.exit(1); }
    console.log(JSON.stringify(s)); process.exit(0);
}

const PROBE_DELAY_MS = 4_000;
const HOLD_MS = 240_000;
const CLI_VERSION = '2.1.330';
const SESSION = '5b0c6a1e-84d2-4c3f-9e7a-1084aaaa0001';
const MODELS = [{ value: 'default', displayName: 'Default (recommended)', description: 'Use the default model', resolvedModel: 'claude-opus-5-5' }];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const event = (e) => send({ type: 'stream_event', session_id: SESSION, parent_tool_use_id: null, event: e });
/**
 * This folder's limits, from `status.json` (`limit`: the share USED per window, 0..1), as the CLI's rate_limit_event carries
 * them; `limit: null` reports none (a turn with no rate-limit frame).
 */
function limit() {
    const s = status()[dir ?? ''];
    const now = Math.floor(Date.now() / 1000);
    const windows = {};
    if (s?.limit === null) return null;
    for (const [name, used] of Object.entries(s?.limit ?? { seven_day: 0.5 })) windows[name] = { utilization: used, resetsAt: now + (name === 'five_hour' ? 3 * 3600 : 3 * 86400) };
    return { status: 'allowed', rateLimitType: Object.keys(windows)[0], resetsAt: now + 3 * 86400, isUsingOverage: false, unifiedWindows: windows };
}

let turn = 0;
async function answer(n, long) {
    const id = `msg_1084_${n}`;
    send({ type: 'system', subtype: 'init', session_id: SESSION, claude_code_version: CLI_VERSION, model: 'claude-opus-5-5', tools: [], mcp_servers: [], cwd: process.cwd() });
    // `delayMs` in status.json, else: the default home's read is slower, so the row can see "Reading usage…" right after
    // switching to it.
    const delay = status()[dir ?? '']?.delayMs;
    if (probe) await sleep(typeof delay === 'number' ? delay : dir === null ? 3 * PROBE_DELAY_MS + 3_000 : PROBE_DELAY_MS);
    const reported = probe || n === 1 ? limit() : null;
    if (reported) send({ type: 'rate_limit_event', rate_limit_info: reported, session_id: SESSION });
    event({ type: 'message_start', message: { id, usage: { input_tokens: 5, output_tokens: 1 } } });
    event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    const words = !probe && long ? Math.ceil(HOLD_MS / 1000) : 1;
    for (let i = 0; i < words; i++) {
        event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `${i === 0 ? '' : ' '}${probe ? 'OK' : `working${i}`}` } });
        if (words > 1) await sleep(1000);
    }
    event({ type: 'content_block_stop', index: 0 });
    event({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: words } });
    event({ type: 'message_stop' });
    send({ type: 'assistant', session_id: SESSION, parent_tool_use_id: null, message: { id, model: 'claude-opus-5-5', content: [{ type: 'text', text: probe ? 'OK' : `turn ${n} done` }], usage: { input_tokens: 5, output_tokens: words } } });
    send({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', session_id: SESSION, num_turns: 1, result: probe ? 'OK' : `turn ${n} done`, usage: { input_tokens: 5, output_tokens: words } });
}

let chain = Promise.resolve();
function handle(frame) {
    if (frame?.type === 'control_request') {
        const subtype = frame.request?.subtype;
        const response = subtype === 'initialize' ? { models: MODELS, claude_code_version: CLI_VERSION } : {};
        return send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response } });
    }
    if (frame?.type === 'user') {
        const n = ++turn;
        const content = frame.message?.content;
        const said = typeof content === 'string' ? content : Array.isArray(content) ? content.map((b) => (b && b.type === 'text' ? b.text : '')).join(' ') : '';
        const long = said.includes('long piece of work');
        chain = chain.then(() => answer(n, long)).catch((e) => process.stderr.write(`[1084-stub] turn failed: ${e?.message ?? e}\n`));
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

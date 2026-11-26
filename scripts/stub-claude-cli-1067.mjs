#!/usr/bin/env node
/**
 * A STUB CLAUDE CODE THAT CANNOT BE UPDATED WHILE IT RUNS (Tynn #1067's drain row, scripts/cli-drain-real-cdp.mjs).
 *
 * The real Claude Code cannot run a session on a test VM (it has no account there), and the drain is about what happens
 * to a RUNNING session when its CLI is updated. So this is the CLI Genie is pointed at (GENIE2_CLAUDE_BINARY, the way a
 * person with a non-standard install points it), with the one property the drain exists for, made strict: `update` FAILS
 * while any session of it is still running ("in use", as Windows' locked file is), and succeeds only once none is.
 *
 * Its state is the `state` folder BESIDE THIS FILE, never an environment variable: prism-acp hands a session a filtered
 * environment (as scripts/esc-unsend-stub-claude.mjs found), so the row copies this file into a folder of its own.
 *
 *   --version        `<version> (Claude Code)` from the state folder (2.0.0 at first)
 *   auth status      exit 0: signed in
 *   update           refused (exit 1, EBUSY) while a session's pid is alive; otherwise the patch version + 1, after
 *                    the ms in <state>/update-ms (so a screenshot can see the step); <state>/fail-update fails it
 *   anything else    a session: its pid recorded until it exits; every control request answered (initialize with its
 *                    models), and each `user` frame answered with a short turn (as scripts/esc-unsend-stub-claude.mjs)
 *
 * Every event is a line in <state>/events.log, with its time and pid: the row reads the order from it.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const state = join(here, 'state');
const sessions = join(state, 'sessions');
mkdirSync(sessions, { recursive: true });
const versionFile = join(state, 'version.txt');
const version = () => (existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : '2.0.0');
const event = (line) => appendFileSync(join(state, 'events.log'), `${Date.now()} pid=${process.pid} ${line}\n`);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const args = process.argv.slice(2);

if (args[0] === '--version') {
    console.log(`${version()} (Claude Code)`);
    process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') {
    console.log(JSON.stringify({ loggedIn: true, authMethod: 'stub' }));
    process.exit(0);
}
if (args[0] === 'update') {
    const live = readdirSync(sessions).map((f) => Number(f.replace(/\.pid$/, ''))).filter((pid) => Number.isInteger(pid) && pid !== process.pid && alive(pid));
    if (live.length > 0) {
        event(`update refused in-use=${live.join(',')}`);
        console.error(`Error: EBUSY: resource busy or locked — Claude Code is in use by pid ${live.join(', ')}`);
        process.exit(1);
    }
    const from = version();
    if (existsSync(join(state, 'fail-update'))) {
        event(`update failed from=${from} (fail-update)`);
        console.error('Error: the stub was told to fail this update (fail-update)');
        process.exit(1);
    }
    const wait = existsSync(join(state, 'update-ms')) ? Number(readFileSync(join(state, 'update-ms'), 'utf8').trim()) : 0;
    if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, 120_000)));
    const [a, b, c] = from.split('.').map(Number);
    const to = `${a}.${b}.${c + 1}`;
    writeFileSync(versionFile, to);
    event(`update ok from=${from} to=${to}`);
    console.log(`Successfully updated from ${from} to version ${to}`);
    process.exit(0);
}

// A session.
const mine = join(sessions, `${process.pid}.pid`);
writeFileSync(mine, String(process.pid));
event(`session start version=${version()} args=${args.filter((x) => !x.startsWith('{')).join(' ').slice(0, 200)}`);
process.on('exit', () => { event('session end'); try { rmSync(mine, { force: true }); } catch { /* gone */ } });
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { event(`signal ${signal}`); process.exit(0); });
process.on('uncaughtException', (error) => { event(`crash ${String(error?.stack ?? error).slice(0, 300)}`); process.exit(1); });

const SESSION = '5c1e7a2d-3b4f-4a6e-9c0d-1f2e3a4b5c6d';
const MODELS = [{ value: 'default', displayName: 'Default (recommended)', description: 'Use the default model', resolvedModel: 'claude-opus-5-5' }];
const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const stream = (e) => send({ type: 'stream_event', session_id: SESSION, parent_tool_use_id: null, event: e });
let turns = 0;
let chain = Promise.resolve();
// The first turn of the stub's whole state lasts 12 s (a word a second), so a drain has a turn to wait for; the rest end at once.
const firstTurnEver = !existsSync(join(state, 'had-a-turn'));
async function turn() {
    const n = ++turns;
    const id = `msg_cli_${n}`;
    event(`turn ${n}`);
    send({ type: 'system', subtype: 'init', session_id: SESSION, claude_code_version: version(), model: 'claude-opus-5-5', tools: [], mcp_servers: [], cwd: process.cwd() });
    stream({ type: 'message_start', message: { id, usage: { input_tokens: 10, output_tokens: 1 } } });
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    const words = n === 1 && firstTurnEver ? 12 : 1;
    writeFileSync(join(state, 'had-a-turn'), '1');
    for (let i = 0; i < words; i++) {
        stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `${i === 0 ? '' : ' '}working${i}` } });
        if (words > 1) await new Promise((r) => setTimeout(r, 1000));
    }
    event(`turn ${n} ended`);
    stream({ type: 'content_block_stop', index: 0 });
    stream({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } });
    stream({ type: 'message_stop' });
    send({ type: 'assistant', session_id: SESSION, parent_tool_use_id: null, message: { id, model: 'claude-opus-5-5', content: [{ type: 'text', text: `turn ${n} done` }], usage: { input_tokens: 10, output_tokens: 3 } } });
    send({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', session_id: SESSION, num_turns: 1, result: `turn ${n} done`, usage: { input_tokens: 10, output_tokens: 3 } });
}
function handle(frame) {
    if (frame?.type === 'control_request') {
        const id = frame.request_id;
        const response = frame.request?.subtype === 'initialize' ? { models: MODELS, claude_code_version: version() } : {};
        return send({ type: 'control_response', response: { subtype: 'success', request_id: id, response } });
    }
    if (frame?.type === 'user') { chain = chain.then(turn).catch(() => {}); return; }
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
        try { handle(JSON.parse(line)); } catch { /* not a frame */ }
    }
});
process.stdin.on('end', () => { event('stdin end'); void chain.then(() => process.exit(0)); });

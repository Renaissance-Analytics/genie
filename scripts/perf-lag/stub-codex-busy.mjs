#!/usr/bin/env node
/**
 * A BUSY CODEX (genie#1340): the App Server protocol subset `scripts/stub-codex.mjs` speaks, but every turn WORKS for
 * `STUB_BUSY_MS` (default 10 min): a reply streamed in small deltas every 100 ms, and a command with output every 2 s,
 * the load eleven resumed agents put on Genie while the person types. Pointed at with GENIE2_CODEX_BINARY.
 */
const THREAD_ID = 'stub_thread_0001';
const BUSY_MS = Number(process.env.STUB_BUSY_MS ?? 600_000);
const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const respond = (id, result) => send({ jsonrpc: '2.0', id, result });
const LOREM = 'Reading the suite output and checking each failure against the plan before the next step. ';

let turnN = 0;
function work(turnId) {
    const until = Date.now() + BUSY_MS;
    let msg = 0;
    let call = 0;
    let ticks = 0;
    let messageId = `${turnId}_m0`;
    const timer = setInterval(() => {
        ticks += 1;
        if (Date.now() > until) {
            clearInterval(timer);
            send({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: THREAD_ID, turnId, item: { type: 'agentMessage', id: messageId, text: 'done' } } });
            send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: THREAD_ID, turn: { id: turnId, status: 'completed', items: [], error: null } } });
            return;
        }
        send({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: THREAD_ID, turnId, itemId: messageId, delta: LOREM.slice(0, 20 + (ticks % 60)) } });
        if (ticks % 20 === 0) {
            send({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: THREAD_ID, turnId, item: { type: 'agentMessage', id: messageId, text: '' } } });
            msg += 1;
            messageId = `${turnId}_m${msg}`;
            call += 1;
            const id = `${turnId}_c${call}`;
            const command = `npm test -- part${call}`;
            send({ jsonrpc: '2.0', method: 'item/started', params: { threadId: THREAD_ID, turnId, item: { type: 'commandExecution', id, command, cwd: process.cwd(), status: 'inProgress' } } });
            send({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: THREAD_ID, turnId, item: { type: 'commandExecution', id, command, cwd: process.cwd(), status: 'completed', exitCode: 0, aggregatedOutput: LOREM.repeat(40) } } });
        }
    }, 100);
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
        let frame;
        try { frame = JSON.parse(line); } catch { continue; }
        handle(frame);
    }
});

function handle({ id, method }) {
    if (method === undefined) return;
    switch (method) {
        case 'initialize': return respond(id, { serverInfo: { name: 'stub-codex-busy', version: '0.0.0' }, capabilities: {} });
        case 'initialized': return undefined;
        case 'config/read': return respond(id, { config: { mcp_servers: {}, shell_environment_policy: {} } });
        case 'account/rateLimits/read': return respond(id, { ordinaryUsageAllowed: null, rateLimits: { primary: null, secondary: null } });
        case 'thread/start':
        case 'thread/resume': return respond(id, { thread: { id: THREAD_ID } });
        case 'thread/turns/list':
        case 'thread/items/list': return respond(id, { data: [], nextCursor: null });
        case 'model/list': return respond(id, { data: [{ id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', description: 'x', isDefault: true }], nextCursor: null });
        case 'turn/start': {
            turnN += 1;
            const turnId = `busy_turn_${turnN}`;
            respond(id, { turn: { id: turnId } });
            work(turnId);
            return undefined;
        }
        default:
            if (id !== undefined) respond(id, {});
    }
}
process.stdin.on('end', () => process.exit(0));

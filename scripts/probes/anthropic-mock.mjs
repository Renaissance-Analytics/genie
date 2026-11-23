#!/usr/bin/env node
// A STAND-IN FOR THE MESSAGES API (Tynn #1011 measurement). Claude Code is pointed at it with ANTHROPIC_BASE_URL so a probe
// can see, per request, WHICH key the CLI sent (fake keys the probe made, never a real one) and WHAT history it sent. It
// answers every /v1/messages call with a one-line assistant reply, streamed when asked. Nothing here reaches Anthropic.
//
//   node anthropic-mock.mjs <requests.jsonl> <port-file>
//
// GET /__phase?name=<n> labels the requests that follow, so the probe can tell its runs apart.
import { createServer } from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';

const [log, portFile] = process.argv.slice(2);
if (!log || !portFile) { console.error('usage: anthropic-mock.mjs <requests.jsonl> <port-file>'); process.exit(2); }
let phase = 'none';

function sse(res, model) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('message_start', { type: 'message_start', message: { id: 'msg_probe', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
    send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'probe reply' } });
    send('content_block_stop', { type: 'content_block_stop', index: 0 });
    send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } });
    send('message_stop', { type: 'message_stop' });
    res.end();
}

const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    if (url.pathname === '/__phase') { phase = url.searchParams.get('name') ?? 'none'; res.end('ok'); return; }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { /* not JSON */ }
        appendFileSync(log, JSON.stringify({
            phase, method: req.method, path: url.pathname,
            apiKey: req.headers['x-api-key'] ?? null, authorization: req.headers['authorization'] ?? null,
            stream: parsed?.stream === true, body,
        }) + '\n');
        if (req.method === 'POST' && url.pathname.startsWith('/v1/messages')) {
            const model = typeof parsed?.model === 'string' ? parsed.model : 'claude-probe';
            if (url.pathname.endsWith('/count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":1}'); return; }
            if (parsed?.stream === true) { sse(res, model); return; }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ id: 'msg_probe', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'probe reply' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 2 } }));
            return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"type":"error","error":{"type":"not_found_error","message":"probe mock"}}');
    });
});
server.listen(0, '127.0.0.1', () => { writeFileSync(portFile, String(server.address().port)); });

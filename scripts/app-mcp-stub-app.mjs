#!/usr/bin/env node
/**
 * A STUB APP THAT SERVES MCP AT /mcp, for the app MCP proof (Tynn #1033, scripts/app-mcp-proof-1033.mjs); never in the
 * suite. Run as a Genie site's dev server (`node scripts/app-mcp-stub-app.mjs --port {port}`), the way a Laravel app's
 * mcp route or any local MCP server would be.
 *
 * Streamable HTTP, JSON responses: `initialize`, `notifications/initialized`, `tools/list` (one tool, `shop_ping`) and
 * `tools/call`. Every request is written down, one JSON line each, to `HITS`: what reached the app, which is how the
 * proof tells "an agent's client connected to it through Genie" from "it was only configured".
 */
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const HITS = process.env.APP_MCP_HITS ?? '/tmp/genie-app-mcp-hits.jsonl';
const flag = process.argv.indexOf('--port');
const port = Number(flag >= 0 ? process.argv[flag + 1] : process.env.PORT);
if (!Number.isInteger(port) || port <= 0) { console.error('app-mcp-stub-app: --port N'); process.exit(2); }

const TOOL = { name: 'shop_ping', description: 'The stub shop app answers pong (Tynn #1033 proof).', inputSchema: { type: 'object', properties: {} } };
const note = (hit) => { try { appendFileSync(HITS, `${JSON.stringify({ at: Date.now(), ...hit })}\n`); } catch { /* the proof reads what it can */ } };

createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub');
    if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('stub shop app\n'); return; }
    if (url.pathname !== '/mcp') { res.writeHead(404); res.end(); return; }
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(); return; }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
        let msg;
        try { msg = JSON.parse(body); } catch { res.writeHead(400); res.end(); return; }
        note({ method: msg.method ?? null, host: req.headers.host ?? null });
        if (msg.id === undefined) { res.writeHead(202); res.end(); return; }
        const reply = (result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })); };
        switch (msg.method) {
            case 'initialize': return reply({ protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stub-shop', version: '1.0.0' } });
            case 'tools/list': return reply({ tools: [TOOL] });
            case 'tools/call': return reply({ content: [{ type: 'text', text: 'pong' }] });
            case 'ping': return reply({});
            default:
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `no method ${msg.method}` } }));
        }
    });
}).listen(port, '127.0.0.1', () => console.log(`stub shop app on 127.0.0.1:${port}`));

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { claudeChannelBridge } from '../agent-config';

/**
 * The AgentInbox channel bridge, RUN — genie#619.
 *
 * The bridge is a generated string, so it has only ever been asserted on as
 * text. That is how it kept a supervisor whose fatal path sets
 * `process.exitCode = 1` and *returns*: `exitCode` names the code a natural exit
 * will use, and causes no exit at all. With stdin still flowing the process
 * lived on — `running` latched, no delivery loop, still answering `ping` and
 * `tools/list` — a live, deaf bridge that passes every health check its client
 * makes. Reading the source does not show you that; running it does.
 *
 * So these spawn the real thing against a stub endpoint. No Electron, no
 * browser, no Genie: `node`, a loopback HTTP server, and a few hundred
 * milliseconds.
 */

const running: ChildProcessWithoutNullStreams[] = [];
const servers: http.Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
    for (const child of running.splice(0)) child.kill('SIGKILL');
    for (const server of servers.splice(0)) await new Promise((r) => server.close(r));
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A loopback endpoint that answers every AgentInbox POST the same way. */
async function stubEndpoint(
    reply: (count: number) => { status: number; body?: unknown },
): Promise<{ url: string; requests: () => number }> {
    let count = 0;
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            count += 1;
            const { status, body: payload } = reply(count);
            res.writeHead(status, { 'Content-Type': 'application/json' });
            // The bridge reads `result.content[].text` and JSON-parses from the
            // first `{`, so a tool result has to be shaped like a real one.
            res.end(
                payload === undefined
                    ? '{}'
                    : JSON.stringify({
                          jsonrpc: '2.0',
                          id: JSON.parse(body || '{}').id ?? 1,
                          result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
                      }),
            );
        });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    return { url: `http://127.0.0.1:${port}/mcp/tok`, requests: () => count };
}

/** Spawn the generated bridge, and speak just enough MCP to start it. */
function startBridge(env: Record<string, string | undefined>): {
    child: ChildProcessWithoutNullStreams;
    stderr: () => string;
    exited: Promise<number | null>;
} {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-channel-bridge-'));
    dirs.push(dir);
    const file = path.join(dir, 'bridge.cjs');
    fs.writeFileSync(file, claudeChannelBridge());

    const child = spawn(process.execPath, [file], {
        env: { ...process.env, ...env } as NodeJS.ProcessEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    running.push(child);
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += String(c)));
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));

    child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n',
    );
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return { child, stderr: () => stderr, exited };
}

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('the channel bridge cannot end up alive and deaf (genie#619)', () => {
    it('KEEPS RETRYING when the endpoint answers 403', async () => {
        // The trigger that matters. Genie's own MCP server never answers 401 or
        // 403 — an unresolvable token gets 404, a not-ready server 503. So a 403
        // means something that is NOT Genie is answering the configured port,
        // which `server.ts` anticipates: on EADDRINUSE it falls back to an
        // ephemeral port and leaves the baked URLs pointing at the squatter.
        // That is transient by nature, and treating it as permanent is what
        // makes one bad moment last the rest of the session.
        const endpoint = await stubEndpoint(() => ({ status: 403 }));
        const bridge = startBridge({ GENIE_MCP_URL: endpoint.url });

        await settle(1500);

        expect(bridge.child.exitCode, 'bridge should still be running').toBeNull();
        // More than one attempt is the whole property: retrying, not parked.
        expect(endpoint.requests()).toBeGreaterThan(1);
    });

    it('POSITIVE CONTROL: a working endpoint registers and polls', async () => {
        // Otherwise "it kept making requests" would pass against a bridge that
        // had simply failed to start and was retrying its way to nowhere.
        const endpoint = await stubEndpoint(() => ({ status: 200, body: { messages: [] } }));
        const bridge = startBridge({ GENIE_MCP_URL: endpoint.url });

        await settle(1500);

        expect(bridge.child.exitCode).toBeNull();
        // registerTransport, then at least one receive.
        expect(endpoint.requests()).toBeGreaterThan(1);
        expect(bridge.stderr()).not.toContain('disconnected');
    });

    it('EXITS when it has no endpoint to talk to — before it claims to be a server', async () => {
        // The one genuinely permanent error: no `GENIE_MCP_URL` means this
        // process can never work, and a respawn would fail identically. It has
        // to end, and it has to end BEFORE answering `initialize` — a client
        // only re-dials servers that reached "connected", so failing at startup
        // is what stops an exit from becoming a respawn loop.
        const bridge = startBridge({ GENIE_MCP_URL: undefined });

        const code = await Promise.race([bridge.exited, settle(3000).then(() => 'timeout')]);
        expect(code, 'bridge should exit, not linger').not.toBe('timeout');
        expect(code).not.toBe(0);
        expect(bridge.stderr()).toContain('GENIE_MCP_URL');
    });
});

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

describe('the channel bridge names its terminal', () => {
    /**
     * The endpoint the bridge is given is the WORKSPACE's (`.mcp.json` is one
     * file for every terminal in it), and Genie refuses to guess which terminal
     * a workspace-scoped call is for once the workspace has more than one — it
     * answers -32602 with AMBIGUOUS_TERMINAL_MESSAGE. The bridge never passed
     * `terminalId`, so in every multi-terminal workspace `registerTransport` and
     * `receive` were refused forever: no binding, no delivery, and every DM was
     * typed into the agent's prompt instead. Measured against a live Genie with
     * four terminals in the workspace before this was written.
     *
     * This stub answers the way that resolver does.
     */
    async function workspaceEndpoint(terminals: string[]): Promise<{
        url: string;
        calls: () => Array<{ action?: string; terminalId?: string; refused: boolean }>;
    }> {
        const calls: Array<{ action?: string; terminalId?: string; refused: boolean }> = [];
        const server = http.createServer((req, res) => {
            let body = '';
            req.on('data', (c) => (body += c));
            req.on('end', () => {
                const rpc = JSON.parse(body || '{}');
                const args = rpc.params?.arguments ?? {};
                const named = typeof args.terminalId === 'string' ? args.terminalId : undefined;
                const resolved = named ? terminals.includes(named) : terminals.length === 1;
                calls.push({ action: args.action, terminalId: named, refused: !resolved });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                if (!resolved) {
                    res.end(JSON.stringify({
                        jsonrpc: '2.0',
                        id: rpc.id ?? null,
                        error: { code: -32602, message: 'Could not determine which terminal to act on.' },
                    }));
                    return;
                }
                const payload = args.action === 'receive' ? { messages: [] } : { ok: true };
                res.end(JSON.stringify({
                    jsonrpc: '2.0',
                    id: rpc.id ?? 1,
                    result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
                }));
            });
        });
        servers.push(server);
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        return { url: `http://127.0.0.1:${port}/mcp/workspace-token`, calls: () => calls };
    }

    it('registers and polls AS its terminal in a workspace with several', async () => {
        const endpoint = await workspaceEndpoint(['editor', 'ssr', 'term-1', 'other-agent']);
        startBridge({ GENIE_MCP_URL: endpoint.url, GENIE_TERMINAL_ID: 'term-1' });

        await settle(1500);

        const calls = endpoint.calls();
        const registered = calls.find((c) => c.action === 'registerTransport' && !c.refused);
        const polled = calls.find((c) => c.action === 'receive' && !c.refused);
        expect(registered?.terminalId, JSON.stringify(calls)).toBe('term-1');
        expect(polled?.terminalId, JSON.stringify(calls)).toBe('term-1');
        expect(calls.filter((c) => c.refused)).toEqual([]);
    });

    it('sends no terminalId when it has none, rather than an empty one', async () => {
        // Outside a Genie terminal the variable expands to '' (`${GENIE_TERMINAL_ID:-}`).
        // An empty id is not an id: sending it would make a one-terminal
        // workspace refuse a call it can otherwise resolve.
        const endpoint = await workspaceEndpoint(['only']);
        startBridge({ GENIE_MCP_URL: endpoint.url, GENIE_TERMINAL_ID: '' });

        await settle(1500);

        const calls = endpoint.calls();
        expect(calls.length, 'bridge made no calls').toBeGreaterThan(1);
        expect(calls.every((c) => c.terminalId === undefined && !c.refused), JSON.stringify(calls)).toBe(true);
    });
});

describe('the channel bridge handshake', () => {
    /** Spawn the bridge, send `initialize` with `protocolVersion`, return its answer. */
    async function handshake(protocolVersion: string): Promise<Record<string, any>> {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-channel-bridge-'));
        dirs.push(dir);
        const file = path.join(dir, 'bridge.cjs');
        fs.writeFileSync(file, claudeChannelBridge());
        const child = spawn(process.execPath, [file], {
            // Nothing listens here; the handshake is answered before any poll.
            env: { ...process.env, GENIE_MCP_URL: 'http://127.0.0.1:9/mcp/none' } as NodeJS.ProcessEnv,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        running.push(child);
        let out = '';
        const answer = new Promise<Record<string, any>>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`no initialize answer: ${out}`)), 5000);
            child.stdout.on('data', (c) => {
                out += String(c);
                const line = out.split('\n').find((l) => l.includes('"id":7'));
                if (line) {
                    clearTimeout(timer);
                    resolve(JSON.parse(line).result);
                }
            });
        });
        child.stdin.write(
            JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'initialize', params: { protocolVersion } }) + '\n',
        );
        return answer;
    }

    it('does not agree to a protocol revision whose connections carry no channel', async () => {
        // Claude Code registers channel notifications only on a LEGACY-era
        // connection: on a modern revision it skips them ("connection negotiated a
        // modern protocol revision with no unsolicited notification path"), with
        // no error. The bridge echoed whatever the client offered, so a client
        // offering the modern revision would have negotiated the channel away.
        const result = await handshake('2026-07-28');

        expect(result.protocolVersion).toBe('2025-11-25');
        expect(result.capabilities?.experimental?.['claude/channel']).toEqual({});
    });

    it('POSITIVE CONTROL: agrees to a legacy revision the client offers', async () => {
        const result = await handshake('2025-06-18');

        expect(result.protocolVersion).toBe('2025-06-18');
    });

    it('tells the agent what its channel events are and how to mark them read', async () => {
        // Claude Code hands a channel server's `instructions` to the model when it
        // connects. Without them a `<channel source="genie-agentinbox-channel">`
        // event is an unexplained block of text, and nothing tells the agent that
        // reading it here does not mark it read — so it stays unread, and Genie's
        // unread deadline asks about it again.
        const result = await handshake('2025-11-25');

        expect(result.instructions).toContain('genie-agentinbox-channel');
        expect(result.instructions).toMatch(/agentinbox.*receive/);
    });
});

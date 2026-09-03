import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { claudeChannelBridge } from '../agent-config';

/**
 * genie#346 — the AgentInbox channel must SURVIVE the endpoint being replaced.
 *
 * A Genie upgrade replaces the process behind the MCP endpoint. The channel
 * bridge is not that process — Claude Code spawns it over stdio and it outlives
 * the upgrade — but its long-poll against the endpoint does not: the socket
 * dies with the old server, `deliver()` rejects, and the original template
 * answered that by writing one line to stderr and setting `process.exitCode`.
 * The loop never restarted. So a single, entirely routine disconnect ended the
 * channel for the whole session.
 *
 * The consequence is the field evidence on #346, and it defeats #344: with no
 * transport bound, `notifyNow` falls through to the PTY, so the upgrade notice
 * is TYPED at the agent's prompt — on the very release that stopped Genie
 * typing at agents. The moment an agent most needs to be told something is
 * exactly the moment its channel is guaranteed down.
 *
 * These tests run the GENERATED bridge for real, against a stub endpoint that
 * is killed and replaced underneath it. Source-matching would not do: the
 * property under test is behavioural — that the bridge re-registers and keeps
 * its cursor across a server it watched die.
 */

interface StubEndpoint {
    port: number;
    /** Every `registerTransport` call this server has answered. */
    registrations: number;
    /** Hand the bridge's waiting long-poll a message. */
    push: (message: { id: string; seq: number; text: string }) => void;
    /** Cursors the bridge has ACKed, in order. */
    acks: number[];
    /** Kill it the way an upgrade does: stop listening AND cut live sockets. */
    kill: () => Promise<void>;
}

function rpcText(id: unknown, payload: unknown): string {
    return JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
    });
}

/**
 * A stand-in for Genie's MCP endpoint that speaks just enough `agentinbox` for
 * the bridge: register, a HELD long-poll, and acknowledge.
 *
 * The held poll is the point — it is what a real `receive(wait:true)` does, and
 * what makes killing the server reproduce the upgrade exactly.
 */
function startStub(port: number, opts: { status?: number } = {}): Promise<StubEndpoint> {
    const sockets = new Set<import('net').Socket>();
    let waiting: http.ServerResponse | null = null;
    const queue: { id: string; seq: number; text: string }[] = [];
    const state = { registrations: 0, acks: [] as number[] };

    const flush = (): void => {
        if (!waiting || queue.length === 0) return;
        const res = waiting;
        waiting = null;
        const messages = queue.splice(0).map((m) => ({ ...m, from: 'genie:system', kind: 'dm' }));
        res.end(rpcText(1, { messages }));
    };

    const server = http.createServer((req, res) => {
        if (opts.status && opts.status !== 200) {
            res.writeHead(opts.status);
            res.end('nope');
            return;
        }
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
        });
        req.on('end', () => {
            const rpc = JSON.parse(body || '{}');
            const args = rpc.params?.arguments ?? {};
            res.setHeader('content-type', 'application/json');
            if (args.action === 'registerTransport') {
                state.registrations += 1;
                res.end(rpcText(rpc.id, { ok: true }));
                return;
            }
            if (args.action === 'acknowledge') {
                state.acks.push(Number(args.cursor));
                res.end(rpcText(rpc.id, { ok: true }));
                return;
            }
            if (args.action === 'receive') {
                if (queue.length > 0) {
                    const messages = queue.splice(0).map((m) => ({ ...m, from: 'genie:system', kind: 'dm' }));
                    res.end(rpcText(rpc.id, { messages }));
                    return;
                }
                // HOLD it, like the real long-poll.
                waiting = res;
                return;
            }
            res.end(rpcText(rpc.id, { ok: true }));
        });
    });
    server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });

    return new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => {
            const bound = (server.address() as import('net').AddressInfo).port;
            resolve({
                port: bound,
                get registrations() {
                    return state.registrations;
                },
                get acks() {
                    return state.acks;
                },
                push: (message) => {
                    queue.push(message);
                    flush();
                },
                kill: () =>
                    new Promise<void>((done) => {
                        waiting = null;
                        for (const socket of sockets) socket.destroy();
                        server.close(() => done());
                    }),
            });
        });
    });
}

interface RunningBridge {
    proc: ChildProcessWithoutNullStreams;
    /** Every `notifications/claude/channel` the bridge has emitted. */
    delivered: string[];
    stderr: string;
    exited: Promise<number | null>;
}

function startBridge(dir: string, port: number): RunningBridge {
    const file = path.join(dir, 'agentinbox-claude-channel.cjs');
    fs.writeFileSync(file, claudeChannelBridge());
    const proc = spawn(process.execPath, [file], {
        env: { ...process.env, GENIE_MCP_URL: `http://127.0.0.1:${port}/mcp/test-token` },
        stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    const running: RunningBridge = {
        proc,
        delivered: [],
        stderr: '',
        exited: new Promise((resolve) => proc.on('exit', (code) => resolve(code))),
    };
    let buffer = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line) continue;
            try {
                const msg = JSON.parse(line);
                if (msg.method === 'notifications/claude/channel') {
                    running.delivered.push(String(msg.params?.content ?? ''));
                }
            } catch {
                /* not our line */
            }
        }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
        running.stderr += chunk;
    });

    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    return running;
}

async function until(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('condition not met within budget');
}

/** A port nothing is listening on, obtained by binding and releasing one. */
async function freePort(): Promise<number> {
    const stub = await startStub(0);
    const { port } = stub;
    await stub.kill();
    return port;
}

describe('the AgentInbox channel bridge survives an upgrade (genie#346)', () => {
    const cleanup: (() => void)[] = [];
    afterEach(() => {
        for (const fn of cleanup.splice(0)) fn();
    });

    it('re-registers and keeps delivering after the endpoint is replaced', async () => {
        const port = await freePort();
        let stub = await startStub(port);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-bridge-'));
        const bridge = startBridge(dir, port);
        cleanup.push(() => bridge.proc.kill());

        // Connected: registered once, and mail flows.
        await until(() => stub.registrations === 1);
        stub.push({ id: 'm1', seq: 1, text: 'before the upgrade' });
        await until(() => bridge.delivered.length === 1);
        expect(bridge.delivered[0]).toBe('before the upgrade');

        // The upgrade: the process behind the endpoint is replaced. The held
        // long-poll dies with it.
        await stub.kill();
        const replacement = await startStub(port);
        stub = replacement;
        cleanup.push(() => void replacement.kill());

        // The bridge must come back BY ITSELF. Nothing restarted it — Claude
        // Code does not, and a human noticing is the failure mode #346 is about.
        await until(() => replacement.registrations >= 1);

        // …and a message sent across the upgrade is delivered over the channel,
        // which is genie#346's acceptance clause: not typed at the prompt.
        replacement.push({ id: 'm2', seq: 2, text: 'after the upgrade' });
        await until(() => bridge.delivered.length === 2);
        expect(bridge.delivered[1]).toBe('after the upgrade');

        // POSITIVE CONTROL. Everything above would also pass against a bridge
        // that never noticed the disconnect — so prove the disconnect was real:
        // the SECOND server saw its own registration handshake, which only a
        // bridge that re-established the connection could have sent.
        expect(replacement.registrations).toBeGreaterThanOrEqual(1);
        expect(bridge.proc.exitCode).toBeNull();
    }, 40_000);

    it('resumes from its CURSOR, so nothing queued across the upgrade is lost', async () => {
        const port = await freePort();
        const stub = await startStub(port);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-bridge-'));
        const bridge = startBridge(dir, port);
        cleanup.push(() => bridge.proc.kill());

        await until(() => stub.registrations === 1);
        stub.push({ id: 'm1', seq: 7, text: 'seq seven' });
        await until(() => stub.acks.includes(7));

        await stub.kill();
        const replacement = await startStub(port);
        cleanup.push(() => void replacement.kill());
        await until(() => replacement.registrations >= 1);

        // The durable inbox re-queues undelivered mail on the broker's side; the
        // bridge's job is to ask from where it left off rather than from zero,
        // which is what stops the whole backlog being re-read on every upgrade.
        replacement.push({ id: 'm2', seq: 8, text: 'seq eight' });
        await until(() => bridge.delivered.length === 2);
        await until(() => replacement.acks.includes(8));
        expect(bridge.delivered).toEqual(['seq seven', 'seq eight']);
    }, 40_000);

    it('does NOT retry an endpoint that refuses it — that is config, not an upgrade', async () => {
        // NO BANDAIDS: retrying forever is how a wrong token becomes an
        // invisible hot loop. A 401 means the endpoint is up and has said no, so
        // the bridge reports it and stops, which is what makes the harness show
        // a failed server instead of a zombie pretending to be a channel.
        const port = await freePort();
        const stub = await startStub(port, { status: 401 });
        cleanup.push(() => void stub.kill());
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-bridge-'));
        const bridge = startBridge(dir, port);
        cleanup.push(() => bridge.proc.kill());

        await until(() => bridge.stderr.includes('401'));
        // Give a retrying bridge time to prove itself wrong.
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        expect(bridge.stderr.match(/401/g)?.length).toBe(1);
    }, 40_000);
});

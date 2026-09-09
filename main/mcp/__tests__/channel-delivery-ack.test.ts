import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { claudeChannelBridge } from '../agent-config';

/**
 * genie#549 — the bridge ACKNOWLEDGED A WRITE SYSCALL and called it a delivery.
 *
 * `notifications/claude/channel` is a JSON-RPC NOTIFICATION: Claude Code
 * registers a handler for it and answers nothing, by design. So the bridge's
 * `stdout.write` callback was the only signal it had, and it advanced the
 * DURABLE cursor on it — permanently consuming a message that may never have
 * been surfaced to the model at all.
 *
 * That is not a theoretical gap. Claude Code decides at connect time whether to
 * register the channel handler, and refuses on any of: the negotiated protocol
 * era, a non-first-party provider, a feature gate, org policy, the `--channels`
 * list, the plugin allowlist. Every one of those leaves the bridge writing
 * happily into a stdout nobody reads — and one of them was true on the two
 * machines that reported this, where 7 of 7 messages were consumed unseen.
 *
 * The rule these tests pin: THE TRANSPORT DOES NOT ACKNOWLEDGE ON BEHALF OF THE
 * CONSUMER. The bridge tracks where it has got to in its own process so it does
 * not re-write the same message in a loop, and nothing else. Committing the
 * durable cursor belongs to whoever actually read the message.
 *
 * These run the GENERATED bridge for real against a stub endpoint. Source
 * matching would not do: the property is behavioural — which calls it makes,
 * with which arguments, in which order.
 */

interface ReceiveCall {
    /** Present only when the bridge asked from a position of its own. */
    cursor?: number;
    wait?: boolean;
    acknowledge?: boolean;
    /** Whether the key was in the payload at all — `undefined` and absent differ
     *  to the broker: absent means "resume from my durable cursor". */
    hasCursor: boolean;
}

interface StubEndpoint {
    port: number;
    registrations: number;
    receives: ReceiveCall[];
    /** Cursors the bridge asked the SERVER to commit. Must stay empty. */
    acks: number[];
    push: (message: { id: string; seq: number; text: string }) => void;
    kill: () => Promise<void>;
}

function rpcText(id: unknown, payload: unknown): string {
    return JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
    });
}

function startStub(port: number): Promise<StubEndpoint> {
    const sockets = new Set<import('net').Socket>();
    let waiting: http.ServerResponse | null = null;
    const queue: { id: string; seq: number; text: string }[] = [];
    const state = { registrations: 0, acks: [] as number[], receives: [] as ReceiveCall[] };

    const flush = (): void => {
        if (!waiting || queue.length === 0) return;
        const res = waiting;
        waiting = null;
        const messages = queue.splice(0).map((m) => ({ ...m, from: 'genie:system', kind: 'dm' }));
        res.end(rpcText(1, { messages }));
    };

    const server = http.createServer((req, res) => {
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
                state.receives.push({
                    ...(Object.prototype.hasOwnProperty.call(args, 'cursor')
                        ? { cursor: args.cursor }
                        : {}),
                    wait: args.wait,
                    acknowledge: args.acknowledge,
                    hasCursor: Object.prototype.hasOwnProperty.call(args, 'cursor'),
                });
                if (queue.length > 0) {
                    const messages = queue
                        .splice(0)
                        .map((m) => ({ ...m, from: 'genie:system', kind: 'dm' }));
                    res.end(rpcText(rpc.id, { messages }));
                    return;
                }
                waiting = res; // HOLD it, like the real long-poll.
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
                get receives() {
                    return state.receives;
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
    delivered: string[];
    stderr: string;
}

function startBridge(dir: string, port: number): RunningBridge {
    const file = path.join(dir, 'agentinbox-claude-channel.cjs');
    fs.writeFileSync(file, claudeChannelBridge());
    const proc = spawn(process.execPath, [file], {
        env: { ...process.env, GENIE_MCP_URL: `http://127.0.0.1:${port}/mcp/test-token` },
        stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    const running: RunningBridge = { proc, delivered: [], stderr: '' };
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

    proc.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`,
    );
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

describe('the Claude Channel bridge never consumes a message (genie#549)', () => {
    const cleanup: (() => void)[] = [];
    afterEach(() => {
        for (const fn of cleanup.splice(0)) fn();
    });

    it('writes the notification and asks the server to commit NOTHING', async () => {
        const stub = await startStub(0);
        cleanup.push(() => void stub.kill());
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-bridge-ack-'));
        const bridge = startBridge(dir, stub.port);
        cleanup.push(() => bridge.proc.kill());

        await until(() => stub.registrations === 1);
        stub.push({ id: 'm1', seq: 7, text: 'seq seven' });

        // POSITIVE CONTROL — the message really was handed to the harness. The
        // absence assertions below are worthless without it: a bridge that
        // delivered nothing would also acknowledge nothing.
        await until(() => bridge.delivered.length === 1);
        expect(bridge.delivered).toEqual(['seq seven']);

        // The bug, in one line. A write to stdout is not a delivery, so the
        // durable cursor must not move on it.
        await until(() => stub.receives.length >= 2);
        expect(stub.acks).toEqual([]);
    }, 40_000);

    it('resumes from its DURABLE cursor on a fresh process, and from its own after', async () => {
        const stub = await startStub(0);
        cleanup.push(() => void stub.kill());
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-bridge-ack-'));
        const bridge = startBridge(dir, stub.port);
        cleanup.push(() => bridge.proc.kill());

        await until(() => stub.registrations === 1);
        await until(() => stub.receives.length >= 1);

        // A NEW process knows nothing about what an earlier one wrote, and what
        // it wrote may never have been read. Asking with no cursor means "since
        // I last read" on the broker — so anything the previous session left
        // unacknowledged is re-offered rather than lost. Asking from 0 is the
        // other half of the same mistake: it re-reads the whole in-memory inbox.
        expect(stub.receives[0]).toMatchObject({ hasCursor: false, acknowledge: false });

        stub.push({ id: 'm1', seq: 7, text: 'seq seven' });
        await until(() => bridge.delivered.length === 1);

        // WITHIN the process it must move on, or the same message comes back on
        // every poll forever — the opposite failure (genie#393) and just as bad.
        await until(() => stub.receives.length >= 2);
        expect(stub.receives.at(-1)).toMatchObject({
            cursor: 7,
            hasCursor: true,
            wait: true,
            acknowledge: false,
        });

        // …and it is a position, not a re-read: the next message arrives once.
        stub.push({ id: 'm2', seq: 8, text: 'seq eight' });
        await until(() => bridge.delivered.length === 2);
        expect(bridge.delivered).toEqual(['seq seven', 'seq eight']);
        expect(stub.acks).toEqual([]);
    }, 40_000);

    it('does not spin: one poll per delivery, not a hot loop', async () => {
        const stub = await startStub(0);
        cleanup.push(() => void stub.kill());
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-bridge-ack-'));
        const bridge = startBridge(dir, stub.port);
        cleanup.push(() => bridge.proc.kill());

        await until(() => stub.registrations === 1);
        stub.push({ id: 'm1', seq: 7, text: 'seq seven' });
        await until(() => bridge.delivered.length === 1);
        // Long enough that a bridge re-asking from a cursor it never advanced
        // would have made hundreds of round trips.
        await new Promise((resolve) => setTimeout(resolve, 1_500));

        expect(bridge.delivered).toEqual(['seq seven']);
        expect(stub.receives.length).toBeLessThanOrEqual(3);
    }, 40_000);
});

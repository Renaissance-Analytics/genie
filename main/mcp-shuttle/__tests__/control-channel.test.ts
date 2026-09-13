import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createShuttleCore, SHUTTLE_ERROR_CODES, type ShuttleResponse } from '../core';
import { createPublisherGate } from '../publisher-gate';
import { attachControlServer, connectPublisher, type FrameCodec } from '../control-channel';
import { parseInboundGateMessage, parseOutboundGateMessage } from '../control-channel';

/**
 * THE CONTROL CHANNEL — the pipe a Genie publishes through, end to end.
 *
 * genie#346 Phase 1, `.ai/plans/genie-mcp-shuttle-spec.md` §3.2 and §4.1. The gate,
 * the core and the publisher are each tested alone; this runs them over a REAL
 * named pipe (Windows) or unix socket (POSIX) — the transport the shuttle uses —
 * so what is proven is what a Genie and a shuttle actually exchange.
 *
 * The pipe is reachable by any process of this user, so every frame from it is
 * untrusted: a frame that is not a well-formed message closes that connection and
 * leaves the shuttle serving everyone else.
 *
 * The frame codec is INJECTED. The spec reuses fancy-term-host's length-prefixed
 * framing, which cannot be imported without its native `node-pty` dependency until
 * Particle-Academy/fancy-term-host#12 lands; the shuttle must ship with no native
 * dependencies. This test's codec is the same 4-byte big-endian framing.
 */

const SECRET = 'publisher-secret-0123456789abcdef';
const WIRE = 1;

/** 4-byte big-endian length prefix + UTF-8 JSON, with a size cap — the test double
 *  for the injected codec. */
const testCodec = (maxFrame = 1024 * 1024): FrameCodec => ({
    encode(message) {
        const body = Buffer.from(JSON.stringify(message), 'utf8');
        const head = Buffer.alloc(4);
        head.writeUInt32BE(body.length, 0);
        return Buffer.concat([head, body]);
    },
    decoder() {
        let buffer: Buffer = Buffer.alloc(0);
        const self = {
            desynced: false,
            push(chunk: Buffer): unknown[] {
                buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
                const out: unknown[] = [];
                while (buffer.length >= 4) {
                    const len = buffer.readUInt32BE(0);
                    if (len > maxFrame) {
                        self.desynced = true;
                        buffer = Buffer.alloc(0);
                        break;
                    }
                    if (buffer.length < 4 + len) break;
                    const body = buffer.subarray(4, 4 + len);
                    buffer = buffer.subarray(4 + len);
                    try {
                        out.push(JSON.parse(body.toString('utf8')));
                    } catch {
                        out.push(undefined); // unparseable — the server must refuse it
                    }
                }
                return out;
            },
        };
        return self;
    },
});

const pipePath = () =>
    process.platform === 'win32'
        ? `\\\\.\\pipe\\genie-shuttle-test-${randomUUID()}`
        : path.join(os.tmpdir(), `genie-shuttle-${randomUUID().slice(0, 8)}.sock`);

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
});

async function shuttle(codec = testCodec()) {
    const core = createShuttleCore({ now: () => 0 });
    const gate = createPublisherGate({ secret: SECRET, wireGeneration: WIRE, core });
    const server = net.createServer();
    attachControlServer(server, { gate, codec });
    // Tracked so cleanup can end them: `server.close` waits for every open
    // connection, and a test that failed mid-way leaves some behind.
    const sockets = new Set<net.Socket>();
    server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    const address = pipePath();
    await new Promise<void>((resolve) => server.listen(address, resolve));
    cleanups.push(
        () =>
            new Promise<void>((resolve) => {
                for (const socket of sockets) socket.destroy();
                server.close(() => resolve());
            }),
    );
    return { core, gate, address, codec };
}

/** A promise that fails with a named reason instead of hanging the suite. */
function within<T>(promise: Promise<T>, what: string, ms = 2_000): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} did not happen within ${ms}ms`)), ms)),
    ]);
}

async function until(test: () => boolean, ms = 2_000): Promise<void> {
    const start = Date.now();
    while (!test()) {
        if (Date.now() - start > ms) throw new Error('condition not met in time');
        await new Promise((r) => setTimeout(r, 5));
    }
}

/** A Genie publishing into the shuttle at `address`, recording what happened. */
function genie(
    address: string,
    opts: { secret?: string; wireGeneration?: number; generation?: number; run?: (f: unknown) => Promise<ShuttleResponse> } = {},
) {
    const events = { welcomed: false, displaced: null as string | null, closed: null as string | null, ran: [] as unknown[] };
    const publisher = connectPublisher({
        connect: () => net.connect(address),
        codec: testCodec(),
        secret: opts.secret ?? SECRET,
        wireGeneration: opts.wireGeneration ?? WIRE,
        generation: opts.generation ?? 1,
        run: async (frame) => {
            events.ran.push(frame);
            return opts.run ? opts.run(frame) : { result: { ok: true } };
        },
        onWelcome: () => void (events.welcomed = true),
        onDisplaced: (reason) => void (events.displaced = reason),
        onClosed: (reason) => void (events.closed = reason),
    });
    cleanups.push(() => publisher.close());
    return { publisher, events };
}

describe('a Genie attaches over the pipe', () => {
    it('with the right secret: welcomed, and the shuttle is attached', async () => {
        const s = await shuttle();
        const g = genie(s.address);
        await until(() => g.events.welcomed);
        expect(s.core.state()).toBe('attached');
    });

    it('with a WRONG secret: told why, closed, and nothing attaches', async () => {
        const s = await shuttle();
        const g = genie(s.address, { secret: 'not-the-secret-0123456789abcdefgh' });
        await until(() => g.events.closed !== null);
        expect(g.events.closed).toMatch(/authentication/i);
        expect(g.events.welcomed).toBe(false);
        expect(s.core.state()).toBe('detached');
    });

    it('on an incompatible wire generation: told BOTH generations', async () => {
        const s = await shuttle();
        const g = genie(s.address, { wireGeneration: WIRE + 1 });
        await until(() => g.events.closed !== null);
        expect(g.events.closed).toContain(String(WIRE));
        expect(g.events.closed).toContain(String(WIRE + 1));
    });
});

describe('a call makes the round trip', () => {
    it('dispatches to the attached Genie and returns its result to the caller', async () => {
        const s = await shuttle();
        const g = genie(s.address, { run: async () => ({ result: { content: [{ type: 'text', text: 'done' }] } }) });
        await until(() => g.events.welcomed);

        const answer = await within(
            new Promise<ShuttleResponse>((resolve) =>
                s.core.call({ id: 7, method: 'tools/call', params: { name: 'imDone' } }, resolve, { token: 't', terminalId: 'term-1' }),
            ),
            'the call answer',
        );

        expect(answer).toEqual({ result: { content: [{ type: 'text', text: 'done' }] } });
        expect(g.events.ran).toHaveLength(1);
        expect(g.events.ran[0]).toMatchObject({ request: { id: 7, method: 'tools/call' }, route: { terminalId: 'term-1' } });
    });

    it('answers an in-flight call as interrupted when the Genie connection dies', async () => {
        const s = await shuttle();
        const g = genie(s.address, { run: () => new Promise<ShuttleResponse>(() => {}) }); // never answers
        await until(() => g.events.welcomed);

        const answer = new Promise<ShuttleResponse>((resolve) => s.core.call({ id: 1, method: 'tools/call' }, resolve));
        await until(() => g.events.ran.length === 1);
        g.publisher.close();

        expect((await within(answer, 'the interrupted answer')).error?.code).toBe(SHUTTLE_ERROR_CODES.GenieSwapInterrupted);
        await until(() => s.core.state() === 'detached');
    });
});

describe('the swap — a newer Genie takes over', () => {
    it('displaces the old one, which is told so, and the next call runs on the new one', async () => {
        const s = await shuttle();
        const oldGenie = genie(s.address, { generation: 1 });
        await until(() => oldGenie.events.welcomed);
        const newGenie = genie(s.address, { generation: 2 });
        await until(() => newGenie.events.welcomed);

        await until(() => oldGenie.events.displaced !== null);
        const answer = await within(
            new Promise<ShuttleResponse>((resolve) => s.core.call({ id: 2, method: 'tools/call' }, resolve)),
            'the call on the new Genie',
        );

        expect(answer.result).toEqual({ ok: true });
        expect(newGenie.events.ran).toHaveLength(1);
        expect(oldGenie.events.ran).toHaveLength(0);
    });
});

describe('the pipe is untrusted', () => {
    const raw = async (address: string, bytes: Buffer): Promise<string> =>
        new Promise((resolve) => {
            const socket = net.connect(address, () => socket.write(bytes));
            let closed = false;
            socket.on('data', () => {});
            socket.on('close', () => {
                if (!closed) resolve('closed');
                closed = true;
            });
            setTimeout(() => {
                if (!closed) resolve('still open');
                closed = true;
            }, 2_000);
            socket.on('error', () => {});
            cleanups.push(() => void socket.destroy());
        });

    it('closes a connection that sends something that is not a message, and keeps serving', async () => {
        const s = await shuttle();
        const frame = s.codec.encode({ type: 'hello', wireGeneration: 'one', secret: 42 });
        expect(await raw(s.address, frame)).toBe('closed');

        // POSITIVE CONTROL: a real Genie still attaches after the bad one.
        const g = genie(s.address);
        await until(() => g.events.welcomed);
        expect(s.core.state()).toBe('attached');
    });

    it('closes a connection whose framing is garbage (an absurd length prefix)', async () => {
        const s = await shuttle(testCodec(64));
        const head = Buffer.alloc(4);
        head.writeUInt32BE(10_000_000, 0);
        expect(await raw(s.address, Buffer.concat([head, Buffer.from('x')]))).toBe('closed');
    });

    it('reassembles a message split across several writes', async () => {
        // A stream has no message boundaries; one decoder per connection must
        // carry a partial frame until the rest arrives.
        const s = await shuttle();
        const hello = s.codec.encode({ type: 'hello', wireGeneration: WIRE, secret: SECRET, generation: 1 });
        const socket = net.connect(s.address);
        cleanups.push(() => void socket.destroy());
        socket.on('error', () => {});
        await new Promise<void>((resolve) => socket.on('connect', () => resolve()));
        for (let i = 0; i < hello.length; i += 3) {
            socket.write(hello.subarray(i, i + 3));
            await new Promise((r) => setTimeout(r, 1));
        }
        await until(() => s.core.state() === 'attached');
    });
});

describe('message validation', () => {
    it('accepts only hello and result from a publisher', () => {
        expect(parseInboundGateMessage({ type: 'hello', wireGeneration: 1, secret: 's', generation: 3 })).toEqual({
            type: 'hello',
            wireGeneration: 1,
            secret: 's',
            generation: 3,
        });
        expect(parseInboundGateMessage({ type: 'result', correlationId: 4, response: { result: { a: 1 } } })).toMatchObject({
            type: 'result',
            correlationId: 4,
        });
        // The shuttle's own message types, sent BACK at it, are not a publisher's to send.
        expect(parseInboundGateMessage({ type: 'welcome', wireGeneration: 1 })).toBeNull();
        expect(parseInboundGateMessage({ type: 'dispatch', frame: {} })).toBeNull();
    });

    it('refuses a result whose error is not {code: number, message: string}', () => {
        expect(parseInboundGateMessage({ type: 'result', correlationId: 1, response: { error: { code: 'x', message: 1 } } })).toBeNull();
        expect(parseInboundGateMessage({ type: 'result', correlationId: 1.5, response: { result: 1 } })).toBeNull();
    });

    it('accepts only welcome, displaced, closed and dispatch from the shuttle', () => {
        expect(parseOutboundGateMessage({ type: 'displaced', reason: 'newer' })).toEqual({ type: 'displaced', reason: 'newer' });
        expect(parseOutboundGateMessage({ type: 'hello', wireGeneration: 1, secret: 's', generation: 1 })).toBeNull();
        expect(
            parseOutboundGateMessage({ type: 'dispatch', frame: { correlationId: 1, generation: 1, request: { id: 1, method: 'ping' } } }),
        ).toMatchObject({ type: 'dispatch' });
        expect(parseOutboundGateMessage({ type: 'dispatch', frame: { correlationId: 'x' } })).toBeNull();
    });
});

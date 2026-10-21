import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyMemberGrant, type TynnJwk } from '../src/main/relay-grant.js';
import { relayHostLink } from '../src/main/relay-host.js';
import { openRelayMember, PopKeypair } from '../src/main/relay-member.js';
import { buildTicketHostHello } from '../src/main/relay-wire.js';
import { fakeRelay, settle } from './relay-fake.js';

/**
 * ANOTHER WORKSTATION'S SITES, OVER THE TYNN RELAY (browser rebuild step 4, the transport). A window driving another
 * workstation browses THAT workstation's `.gen` sites: the client's browser sends `CONNECT app.gen:443` to a loopback
 * door on the client, the door opens a `site` stream over the relay, and the host CONNECTs its OWN front door — so the
 * TLS runs browser ↔ host front door end to end, and the relay (and the client's main process) carry only ciphertext.
 *
 * - Only the owner's own control link may open one; a guest or a read-only grant is refused in words, and the host's
 *   front door is never dialed (counted, beside the owner's control count of 1).
 * - The door answers the browser only after the host does: 200 once the host's front door accepted, else 502 with the
 *   reason — never a 200 that leads nowhere.
 * - A stream holds at most one window of unacknowledged bytes: genie-cloud's relay closes the WHOLE member session when
 *   a reliable channel backs up, so one large download must not be allowed to end the window's connection.
 *
 * The relay is `relay-fake.ts` (genie-cloud's rules); the front door is a real loopback server answering CONNECT the way
 * `gen-router-server.ts` does, and echoing what it gets.
 */
const relaySite = () => import('../src/main/relay-site.js') as Promise<Record<string, any>>;

const WS_ID = 'ws_host_1';
const tynnKey = generateKeyPairSync('ed25519');
const tynnJwk = { ...(tynnKey.publicKey.export({ format: 'jwk' }) as { kty: string; crv: string; x: string }), kid: 'tynn-1', alg: 'EdDSA' } as TynnJwk;
const hostKey = generateKeyPairSync('ed25519');
const thumbprint = (jwk: { crv: string; kty: string; x: string }) =>
    createHash('sha256').update(`{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}"}`, 'utf8').digest('base64url');
function mintGrant(claims: Record<string, unknown>, key: KeyObject = tynnKey.privateKey): string {
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const head = b64({ alg: 'EdDSA', typ: 'wsgrant+jwt', kid: 'tynn-1' });
    const body = b64({ aud: WS_ID, exp: Math.floor(Date.now() / 1000) + 300, jti: 'g1', sub: 'user_1', name: 'Pat', ...claims });
    return `${head}.${body}.${sign(null, Buffer.from(`${head}.${body}`), key).toString('base64url')}`;
}

/** The host's front door: CONNECT app.gen:443 → 200 then an echo; any other name → 404, as gen-router-server refuses. */
function fakeFrontDoor() {
    const accepted: Socket[] = [];
    const server = createServer((socket) => {
        let head = Buffer.alloc(0);
        const onData = (chunk: Buffer) => {
            head = Buffer.concat([head, chunk]);
            const end = head.indexOf('\r\n\r\n');
            if (end < 0) return;
            socket.off('data', onData);
            const line = head.subarray(0, head.indexOf('\r\n')).toString('latin1');
            if (line !== 'CONNECT app.gen:443 HTTP/1.1') {
                socket.end('HTTP/1.1 404 Not Found\r\n\r\nnothing is serving that name');
                return;
            }
            accepted.push(socket);
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            const rest = head.subarray(end + 4);
            if (rest.length > 0) socket.write(rest);
            socket.pipe(socket);
        };
        socket.on('data', onData);
        socket.on('error', () => {});
    });
    return { server, accepted };
}

const listen = (server: Server) => new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));

/** The browser: CONNECT through the door; the status line and whatever body a refusal carried. */
function browserConnect(port: number, authority: string): Promise<{ status: number; body: string; socket: Socket }> {
    return new Promise((resolve, reject) => {
        const socket = connect(port, '127.0.0.1', () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
        let buf = Buffer.alloc(0);
        const onData = (chunk: Buffer) => {
            buf = Buffer.concat([buf, chunk]);
            const end = buf.indexOf('\r\n\r\n');
            if (end < 0) return;
            const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(buf.toString('latin1'))?.[1] ?? 0);
            if (status === 200) { socket.off('data', onData); resolve({ status, body: '', socket }); return; }
            socket.on('end', () => resolve({ status, body: buf.subarray(end + 4).toString('utf8'), socket }));
        };
        socket.on('data', onData);
        socket.on('error', reject);
    });
}

const readExactly = (socket: Socket, n: number) => new Promise<Buffer>((resolve) => {
    const parts: Buffer[] = [];
    let got = 0;
    socket.on('data', (c: Buffer) => { parts.push(c); got += c.length; if (got >= n) resolve(Buffer.concat(parts).subarray(0, n)); });
});

let relay: ReturnType<typeof fakeRelay>;
let link: ReturnType<typeof relayHostLink>;
let front: ReturnType<typeof fakeFrontDoor>;
let frontPort: number;
const closers: Array<() => void> = [];

beforeEach(async () => {
    const { dialFrontDoor } = await relaySite();
    relay = fakeRelay(() => WS_ID);
    front = fakeFrontDoor();
    frontPort = await listen(front.server);
    link = relayHostLink({
        socket: relay.socket,
        relayUrl: 'wss://relay.example.com',
        workstationId: WS_ID,
        hello: async () => buildTicketHostHello({ ticket: 'ticket-1', workstationId: WS_ID, fingerprint: 'fp', sign: (d) => sign(null, d, hostKey.privateKey) }),
        validateGrant: async (token) => verifyMemberGrant(token, { keys: [tynnJwk], workstationId: WS_ID }),
        reconnect: { minMs: 0, maxMs: 0 },
        popTimeoutMs: 1_000,
        site: { dial: (host: string) => dialFrontDoor(frontPort, host) },
    } as Parameters<typeof relayHostLink>[0]);
    link.onConnection(() => {});
    link.connect();
    await settle();
});

afterEach(async () => {
    for (const c of closers.splice(0)) c();
    link.close();
    await new Promise((r) => front.server.close(r));
    for (const s of front.accepted) s.destroy();
});

/** A member with the given grant, and a door on this client in front of it that lets `app.gen` (and `other.gen`) through. */
async function memberDoor(claims: Record<string, unknown>, opts: { bind?: boolean } = {}) {
    const { siteDoor } = await relaySite();
    const pop = PopKeypair.generate();
    const bound = opts.bind === false ? {} : { cnf: { jkt: thumbprint(pop.publicJwk) } };
    const opened = await openRelayMember({ socket: relay.socket, relayUrl: 'wss://relay.example.com', workstationId: WS_ID, grant: mintGrant({ ...bound, ...claims }), pop });
    if (!opened.ok) throw new Error(opened.reason);
    await settle();
    const transport = opened.transport as typeof opened.transport & { openSite(host: string): Promise<unknown> };
    const opens: string[] = [];
    const door = await siteDoor({ allowed: (h: string) => h === 'app.gen' || h === 'other.gen', open: (h: string) => { opens.push(h); return transport.openSite(h); } });
    closers.push(() => { door.close(); transport.close(); });
    return { door: door as { port: number; close(): void }, transport, opens };
}

const OWNER = { src: 'owner', cap: 'control', scope: ['host:all'] };

describe('the owner browses the host’s site over the relay', () => {
    it('the member transport can open a site stream (the API this rides on)', async () => {
        const { transport } = await memberDoor(OWNER);
        expect(typeof transport.openSite).toBe('function');
    });

    it('3 MiB each way arrives byte-identical through door → relay → host front door, on ONE front-door connection', async () => {
        const { door } = await memberDoor(OWNER);
        const { status, socket } = await browserConnect(door.port, 'app.gen:443');
        expect(status).toBe(200);
        const sent = randomBytes(3 * 1024 * 1024);
        const back = readExactly(socket, sent.length);
        socket.write(sent);
        const got = await back;
        expect(createHash('sha256').update(got).digest('hex')).toBe(createHash('sha256').update(sent).digest('hex'));
        expect(front.accepted).toHaveLength(1);
        socket.destroy();
    }, 30_000);

    it('a name the host does not serve: 502 carrying the front door’s own words, and no stream left open', async () => {
        const { door } = await memberDoor(OWNER);
        const r = await browserConnect(door.port, 'other.gen:443');
        expect(r.status).toBe(502);
        expect(r.body).toContain('nothing is serving that name');
        expect(front.accepted).toHaveLength(0);
    });

    it('the door itself refuses a name it was not given, and a port other than 443 — before anything crosses the relay', async () => {
        const { door, opens } = await memberDoor(OWNER);
        const notListed = await browserConnect(door.port, 'example.com:443');
        const wrongPort = await browserConnect(door.port, 'app.gen:80');
        expect([notListed.status, wrongPort.status]).toEqual([403, 403]);
        expect(front.accepted).toHaveLength(0);
        expect(opens).toEqual([]);
        // CONTROL on the gauge: a listed name on 443 does reach openSite.
        (await browserConnect(door.port, 'app.gen:443')).socket.destroy();
        expect(opens).toEqual(['app.gen']);
    });

    it('the member leaving closes the host’s front-door connection', async () => {
        const { door, transport } = await memberDoor(OWNER);
        const { socket } = await browserConnect(door.port, 'app.gen:443');
        socket.write('ping');
        await readExactly(socket, 4);
        expect(front.accepted).toHaveLength(1);
        const closed = new Promise<void>((r) => front.accepted[0]!.once('close', () => r()));
        transport.close();
        await closed;
        expect(front.accepted[0]!.destroyed).toBe(true);
    });
});

describe('only the owner’s control link may browse', () => {
    for (const [who, claims, bind] of [
        ['a guest of the whole host', { src: 'grant', cap: 'control', scope: ['host:all'] }, true],
        ['a guest of one workspace', { src: 'invite', cap: 'control', scope: ['workspace:tynn'] }, true],
        ['the owner, read-only', { src: 'owner', cap: 'readonly', scope: ['host:all'] }, false],
    ] as const) {
        it(`${who}: 502 in words, and the host’s front door is never dialed (counted)`, async () => {
            const { door } = await memberDoor(claims, { bind });
            const r = await browserConnect(door.port, 'app.gen:443');
            expect(r.status).toBe(502);
            expect(r.body).toMatch(/owner/i);
            expect(front.accepted).toHaveLength(0);
        });
    }

    it('CONTROL: the owner’s control link, same door and name, is dialed exactly once', async () => {
        const { door } = await memberDoor(OWNER);
        const r = await browserConnect(door.port, 'app.gen:443');
        expect(r.status).toBe(200);
        expect(front.accepted).toHaveLength(1);
        r.socket.destroy();
    });
});

describe('a stream never has more than one window of bytes in flight', () => {
    /** A connected loopback pair: what `a` writes, `b` reads. */
    const pair = async () => {
        const server = createServer();
        const port = await listen(server);
        const accepted = new Promise<Socket>((r) => server.once('connection', r));
        const a = connect(port, '127.0.0.1');
        const b = await accepted;
        closers.push(() => { a.destroy(); b.destroy(); server.close(); });
        return { a, b };
    };
    const quiet = () => new Promise((r) => setTimeout(r, 150));

    it('unacknowledged, the pipe sends at most SITE_WINDOW bytes; one ack lets more through (positive control)', async () => {
        const { pipeSiteStream, SITE_WINDOW } = await relaySite();
        const { a, b } = await pair();
        const frames: Array<{ kind: string; payload?: { t?: string; data?: string } }> = [];
        const pipe = pipeSiteStream(b, (f: (typeof frames)[number]) => frames.push(f), () => {});
        const sentBytes = () => frames.filter((f) => f.kind === 'data' && f.payload?.t === 'bytes').reduce((n, f) => n + Buffer.from(f.payload!.data!, 'base64').length, 0);
        a.write(randomBytes(4 * SITE_WINDOW));
        await quiet();
        const first = sentBytes();
        expect(first).toBeGreaterThan(0);
        expect(first).toBeLessThanOrEqual(SITE_WINDOW);
        pipe.receive({ kind: 'data', payload: { t: 'ack', n: first } });
        await quiet();
        expect(sentBytes()).toBeGreaterThan(first);
        expect(sentBytes()).toBeLessThanOrEqual(first + SITE_WINDOW);
    });

    it('bytes from the far end are acknowledged only once written, by their exact count', async () => {
        const { pipeSiteStream } = await relaySite();
        const { a, b } = await pair();
        const acks: number[] = [];
        const pipe = pipeSiteStream(b, (f: { kind: string; payload?: { t?: string; n?: number } }) => { if (f.payload?.t === 'ack') acks.push(f.payload.n!); }, () => {});
        const got = readExactly(a, 5000);
        pipe.receive({ kind: 'data', payload: { t: 'bytes', data: randomBytes(3000).toString('base64') } });
        pipe.receive({ kind: 'data', payload: { t: 'bytes', data: randomBytes(2000).toString('base64') } });
        await got;
        await quiet();
        expect(acks.reduce((s, n) => s + n, 0)).toBe(5000);
    });

    it('a malformed frame ends the stream with an error, never writes garbage', async () => {
        const { pipeSiteStream } = await relaySite();
        const { a, b } = await pair();
        const frames: Array<{ kind: string }> = [];
        let done = 0;
        const pipe = pipeSiteStream(b, (f: { kind: string }) => frames.push(f), () => { done++; });
        let wrote = 0;
        a.on('data', (c: Buffer) => { wrote += c.length; });
        pipe.receive({ kind: 'data', payload: { t: 'bytes', data: 42 } });
        await quiet();
        expect(frames.map((f) => f.kind)).toEqual(['error']);
        expect(done).toBe(1);
        expect(wrote).toBe(0);
    });
});

describe('the running host serves its sites over its relay link', () => {
    const src = (f: string) => readFileSync(join(import.meta.dirname, '..', f), 'utf8');

    it('main hands startRelayHost a site dialer on the composed front door (counted: exactly one)', () => {
        const main = src('src/main/main.ts');
        expect(main.match(/site: \{ dial: \(host\) => dialFrontDoor\(composed\.frontDoorPort, host\) \}/g) ?? []).toHaveLength(1);
    });

    it('startRelayHost passes it to the link (positive control: the reconnect option beside it is found the same way)', () => {
        const net = src('src/main/tynn-network.ts');
        expect(net).toMatch(/\.\.\.\(input\.reconnect \? \{ reconnect: input\.reconnect \} : \{\}\)/);
        expect(net).toMatch(/\.\.\.\(input\.site \? \{ site: input\.site \} : \{\}\)/);
    });
});

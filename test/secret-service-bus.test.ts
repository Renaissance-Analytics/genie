import { randomBytes } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * THE SESSION-BUS CLIENT, AGAINST A FAKE BUS (Tynn story #388, ruling C). The client is ours, so its bytes are tested:
 * the exact bytes of a call on the wire, the whole unlock with the prompt Completed(dismissed=false) and (=true), and a
 * malformed or oversized reply refused, never guessed at. The fake bus speaks over a real local socket (a temp unix
 * socket, or a named pipe on Windows) and frames its replies with its own small encoder, not the client's.
 *
 * Loaded by a computed path ON PURPOSE: before the module exists these are red by assertion, not by an import error.
 */
const BUS_MODULE = '../src/main/secret-service-bus.js';
const bus: Record<string, unknown> = await import(/* @vite-ignore */ BUS_MODULE).catch(() => ({}));
const need = <T,>(name: string): T => { expect(bus[name], `${name} in main/secret-service-bus.ts`).toBeTypeOf('function'); return bus[name] as T; };
type Outcome = { outcome: string; detail: string | null };
type Unlock = (o: { socketPath: string; uid: number; stepTimeoutMs?: number; signal?: AbortSignal }) => Promise<Outcome>;

// ---- An encoder of the fake bus's own (little-endian), independent of the client's.
const pad = (n: number, a: number) => (a - (n % a)) % a;
class Enc {
    parts: number[] = [];
    get len() { return this.parts.length; }
    align(a: number) { for (let i = pad(this.len, a); i > 0; i -= 1) this.parts.push(0); }
    y(v: number) { this.parts.push(v & 0xff); }
    u(v: number) { this.align(4); const b = Buffer.alloc(4); b.writeUInt32LE(v); this.parts.push(...b); }
    str(v: string) { const b = Buffer.from(v, 'utf8'); this.u(b.length); this.parts.push(...b, 0); }
    sig(v: string) { this.y(v.length); this.parts.push(...Buffer.from(v, 'ascii'), 0); }
    buf() { return Buffer.from(this.parts); }
}
/** A whole message: fields as [code, sig, value]; the body already encoded starting at an 8-aligned offset. */
function message(type: number, serial: number, fields: Array<[number, string, string | number]>, body: Buffer = Buffer.alloc(0), opts: { bodyLenOverride?: number } = {}): Buffer {
    const h = new Enc();
    h.y(0x6c); h.y(type); h.y(0); h.y(1);
    h.u(opts.bodyLenOverride ?? body.length); h.u(serial);
    const lenAt = h.len; h.u(0);
    h.align(8);
    const start = h.len;
    for (const [code, sig, value] of fields) {
        h.align(8); h.y(code); h.sig(sig);
        if (sig === 'u') h.u(value as number); else if (sig === 'g') h.sig(value as string); else h.str(value as string);
    }
    const head = h.buf();
    head.writeUInt32LE(head.length - start, lenAt);
    return Buffer.concat([head, Buffer.alloc(pad(head.length, 8)), body]);
}
const reply = (serial: number, replyTo: number, sig: string, body: Buffer) => message(2, serial, [[5, 'u', replyTo], ...(sig ? [[8, 'g', sig] as [number, string, string]] : [])], body);
const signal = (serial: number, path: string, iface: string, member: string, sig: string, body: Buffer) => message(4, serial, [[1, 'o', path], [2, 's', iface], [3, 's', member], [8, 'g', sig]], body);
const aoO = (objects: string[], prompt: string) => { const e = new Enc(); const at = e.len; e.u(0); const start = e.len; for (const o of objects) e.str(o); const b = e.buf(); b.writeUInt32LE(b.length - start, at); const e2 = new Enc(); e2.parts = [...b]; e2.str(prompt); return e2.buf(); };
const bv = (dismissed: boolean) => { const e = new Enc(); e.u(dismissed ? 1 : 0); e.sig('ao'); e.u(0); return e.buf(); };

// ---- A minimal decoder for what the fake bus RECEIVES (method calls): the member, the path, the serial, the body.
function requests(buf: Buffer): { calls: Array<{ serial: number; member: string; path: string; body: Buffer; raw: Buffer }>; rest: Buffer } {
    const calls = [];
    let at = 0;
    while (buf.length - at >= 16) {
        const bodyLen = buf.readUInt32LE(at + 4);
        const fieldsLen = buf.readUInt32LE(at + 12);
        const head = 16 + fieldsLen;
        const total = head + pad(head, 8) + bodyLen;
        if (buf.length - at < total) break;
        const raw = buf.subarray(at, at + total);
        const serial = raw.readUInt32LE(8);
        let p = 16; let member = ''; let path = '';
        while (p < head) {
            p += pad(p, 8);
            const code = raw[p]!; p += 1;
            const sl = raw[p]!; const sig = raw.toString('ascii', p + 1, p + 1 + sl); p += sl + 2;
            if (sig === 'u') { p += pad(p, 4) + 4; continue; }
            if (sig === 'g') { const n = raw[p]!; p += n + 2; continue; }
            p += pad(p, 4); const n = raw.readUInt32LE(p); const v = raw.toString('utf8', p + 4, p + 4 + n); p += 4 + n + 1;
            if (code === 3) member = v; if (code === 1) path = v;
        }
        calls.push({ serial, member, path, body: raw.subarray(head + pad(head, 8)), raw });
        at += total;
    }
    return { calls, rest: buf.subarray(at) };
}

type Behaviour = { unlock: (serial: number, replyTo: number) => Buffer; onPrompt?: (sock: Socket, promptPath: string) => void; auth?: string };
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null))))); });

async function fakeBus(b: Behaviour) {
    const path = process.platform === 'win32' ? `\\\\.\\pipe\\genie-bus-${randomBytes(6).toString('hex')}` : join(tmpdir(), `genie-bus-${randomBytes(6).toString('hex')}.sock`);
    const seen: Array<{ member: string; path: string; body: Buffer; raw: Buffer }> = [];
    let authLine = '';
    let closed = false;
    const server = createServer((sock) => {
        let buf: Buffer = Buffer.alloc(0);
        let authed = false;
        let serial = 100;
        sock.on('close', () => { closed = true; });
        sock.on('data', (chunk: Buffer) => {
            buf = Buffer.concat([buf, chunk]);
            if (!authed) {
                const nl = buf.indexOf('\r\n');
                if (nl < 0) return;
                authLine = buf.toString('ascii', 0, nl);
                buf = buf.subarray(nl + 2);
                sock.write(b.auth ?? 'OK 0123456789abcdef0123456789abcdef\r\n');
                const begin = buf.indexOf('BEGIN\r\n');
                if (begin < 0) { authed = true; return; }
                buf = buf.subarray(begin + 7);
                authed = true;
            }
            if (buf.toString('ascii', 0, 7) === 'BEGIN\r\n') buf = buf.subarray(7);
            const { calls, rest } = requests(buf);
            buf = rest;
            for (const c of calls) {
                seen.push(c);
                if (c.member === 'Hello') { const e = new Enc(); e.str(':1.42'); sock.write(reply(++serial, c.serial, 's', e.buf())); }
                else if (c.member === 'Unlock') sock.write(b.unlock(++serial, c.serial));
                else if (c.member === 'AddMatch') sock.write(reply(++serial, c.serial, '', Buffer.alloc(0)));
                else if (c.member === 'Prompt') { sock.write(reply(++serial, c.serial, '', Buffer.alloc(0))); b.onPrompt?.(sock, c.path); }
            }
        });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(path, () => r()));
    return { path, seen, authLine: () => authLine, closed: () => closed };
}

const DEFAULT = '/org/freedesktop/secrets/aliases/default';
const PROMPT = '/org/freedesktop/secrets/prompt/u7';

describe('the bus address', () => {
    it('unix:path= and unix:abstract= (NUL-prefixed); anything else refused in words', () => {
        const parse = need<(a: string | undefined) => unknown>('parseBusAddress');
        expect(parse('unix:path=/run/user/1000/bus')).toEqual({ path: '/run/user/1000/bus' });
        expect(parse('unix:abstract=/tmp/dbus-XYZ,guid=abc')).toEqual({ path: '\0/tmp/dbus-XYZ' });
        expect(parse('tcp:host=localhost,port=1234')).toMatchObject({ error: expect.stringMatching(/unix:path=/) });
        expect(parse(undefined)).toMatchObject({ error: expect.stringMatching(/DBUS_SESSION_BUS_ADDRESS/) });
    });
});

describe('the bytes on the wire', () => {
    it('Hello, exactly: header, its four fields aligned to 8, no body (128 bytes)', () => {
        const encode = need<(m: Record<string, unknown>) => Buffer>('encodeMethodCall');
        const got = encode({ serial: 1, path: '/org/freedesktop/DBus', iface: 'org.freedesktop.DBus', member: 'Hello', destination: 'org.freedesktop.DBus' });
        const expected = message(1, 1, [[1, 'o', '/org/freedesktop/DBus'], [2, 's', 'org.freedesktop.DBus'], [3, 's', 'Hello'], [6, 's', 'org.freedesktop.DBus']]);
        expect(got.length).toBe(128);
        expect(got.toString('hex')).toBe(expected.toString('hex'));
    });
});

describe('the unlock, against a fake bus', () => {
    it('EXTERNAL auth with the uid in hex; Unlock([default]); a "/" prompt is done at once (no AddMatch, no Prompt)', async () => {
        const unlock = need<Unlock>('unlockDefaultCollection');
        const b = await fakeBus({ unlock: (s, r) => reply(s, r, 'aoo', aoO([DEFAULT], '/')) });
        expect(await unlock({ socketPath: b.path, uid: 1000 })).toEqual({ outcome: 'unlocked', detail: null });
        expect(b.authLine()).toBe(`\0AUTH EXTERNAL ${Buffer.from('1000').toString('hex')}`);
        expect(b.seen.map((c) => c.member)).toEqual(['Hello', 'Unlock']);
        expect(b.seen[1]!.path).toBe('/org/freedesktop/secrets');
        expect(b.seen[1]!.body.toString('latin1')).toContain(DEFAULT);
    });

    it('a prompt: AddMatch for THAT prompt’s Completed only, Prompt(\'\'), then Completed(dismissed=false) = unlocked', async () => {
        const unlock = need<Unlock>('unlockDefaultCollection');
        const b = await fakeBus({ unlock: (s, r) => reply(s, r, 'aoo', aoO([], PROMPT)), onPrompt: (sock, p) => setTimeout(() => sock.write(signal(900, p, 'org.freedesktop.Secret.Prompt', 'Completed', 'bv', bv(false))), 20) });
        expect(await unlock({ socketPath: b.path, uid: 1000 })).toEqual({ outcome: 'unlocked', detail: null });
        expect(b.seen.map((c) => c.member)).toEqual(['Hello', 'Unlock', 'AddMatch', 'Prompt']);
        const rule = b.seen[2]!.body.toString('utf8');
        expect(rule).toContain(`path='${PROMPT}'`);
        expect(rule).toContain("member='Completed'");
        expect(b.seen[3]!.path).toBe(PROMPT);
    });

    it('Completed(dismissed=true) = dismissed; a Completed for ANOTHER prompt is not ours (it keeps waiting)', async () => {
        const unlock = need<Unlock>('unlockDefaultCollection');
        const b = await fakeBus({
            unlock: (s, r) => reply(s, r, 'aoo', aoO([], PROMPT)),
            onPrompt: (sock, p) => {
                sock.write(signal(900, '/org/freedesktop/secrets/prompt/other', 'org.freedesktop.Secret.Prompt', 'Completed', 'bv', bv(false)));
                setTimeout(() => sock.write(signal(901, p, 'org.freedesktop.Secret.Prompt', 'Completed', 'bv', bv(true))), 20);
            },
        });
        expect(await unlock({ socketPath: b.path, uid: 1000 })).toEqual({ outcome: 'dismissed', detail: null });
    });

    it('Cancel while the person decides: cancelled, and the socket is closed', async () => {
        const unlock = need<Unlock>('unlockDefaultCollection');
        const ctl = new AbortController();
        const b = await fakeBus({ unlock: (s, r) => reply(s, r, 'aoo', aoO([], PROMPT)), onPrompt: () => setTimeout(() => ctl.abort(), 20) });
        expect(await unlock({ socketPath: b.path, uid: 1000, signal: ctl.signal })).toEqual({ outcome: 'cancelled', detail: null });
        await new Promise((r) => setTimeout(r, 50));
        expect(b.closed()).toBe(true);
    });
});

describe('refused, never guessed at', () => {
    const unlockWith = async (unlockReply: (s: number, r: number) => Buffer) => {
        const unlock = need<Unlock>('unlockDefaultCollection');
        const b = await fakeBus({ unlock: unlockReply });
        return unlock({ socketPath: b.path, uid: 1000, stepTimeoutMs: 1000 });
    };

    it('a reply of the wrong signature', async () => {
        const e = new Enc(); e.str('surprise');
        expect(await unlockWith((s, r) => reply(s, r, 's', e.buf()))).toMatchObject({ outcome: 'failed', detail: expect.stringMatching(/signature/) });
    });

    it('a type the client does not read (a uint64 in the variant of a signal is the same rule: here, in the reply)', async () => {
        const e = new Enc(); e.u(0); e.u(0); e.u(0);
        expect(await unlockWith((s, r) => reply(s, r, 'aot', e.buf()))).toMatchObject({ outcome: 'failed', detail: expect.stringMatching(/signature|type/) });
    });

    it('non-zero alignment padding', async () => {
        const body = aoO([DEFAULT], '/');
        const bad = reply(1, 2, 'aoo', body);
        // The padding between the header and the body is the last bytes before the body: make one non-zero.
        bad[bad.length - body.length - 1] = 0x7f;
        expect(await unlockWith((s, r) => { const m = reply(s, r, 'aoo', body); m[m.length - body.length - 1] = 0x7f; return m; })).toMatchObject({ outcome: 'failed', detail: expect.stringMatching(/padding/) });
    });

    it('an oversized message (a body larger than 64 KiB announced)', async () => {
        expect(await unlockWith((s, r) => message(2, s, [[5, 'u', r], [8, 'g', 'aoo']], Buffer.alloc(0), { bodyLenOverride: 1024 * 1024 }))).toMatchObject({ outcome: 'failed', detail: expect.stringMatching(/larger than/) });
    });

    it('an auth the bus refuses', async () => {
        const unlock = need<Unlock>('unlockDefaultCollection');
        const b = await fakeBus({ unlock: (s, r) => reply(s, r, 'aoo', aoO([DEFAULT], '/')), auth: 'REJECTED EXTERNAL\r\n' });
        expect(await unlock({ socketPath: b.path, uid: 1000, stepTimeoutMs: 1000 })).toMatchObject({ outcome: 'failed', detail: expect.stringMatching(/refused the sign-in/) });
    });
});

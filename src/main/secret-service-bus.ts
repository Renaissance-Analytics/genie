import { createConnection, type Socket } from 'node:net';
import { afterUnlockReply, DEFAULT_COLLECTION, SECRET_SERVICE, unlockCall, unlockOutcome, type UnlockOutcome } from '../core/keyring-unlock.js';

/**
 * THE SESSION BUS, FOR ONE THING ONLY (Tynn story #388; the coordinator's ruling C): unlock the default Secret Service
 * collection. A minimal client of our own rather than a dependency in a public app — and exactly that scope:
 *
 *   connect to DBUS_SESSION_BUS_ADDRESS (`unix:path=` or `unix:abstract=`; anything else is refused in words) →
 *   EXTERNAL auth with this process's uid → Hello → Service.Unlock([default]) → when it answers with a prompt:
 *   AddMatch for Prompt.Completed on THAT prompt path only → Prompt.Prompt('') → wait for Completed → close.
 *
 * Fail closed and bounded: every message at most {@link MAX_MESSAGE_BYTES}; header fields validated by code and type;
 * alignment padding must be zero bytes; only the types this needs (y, b, u, s, o, g, ao, v, a{sv}, and the header's
 * a(yv)) — anything else is an error, never a guess. Every step has a timeout except the prompt wait, which is the
 * person's own time; an AbortSignal (the card's Cancel) ends it and closes the socket.
 */

export const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_DEPTH = 8;

/** Where the session bus is, from DBUS_SESSION_BUS_ADDRESS: a socket path (abstract names start with NUL), or why not. */
export function parseBusAddress(address: string | undefined): { path: string } | { error: string } {
    if (!address) return { error: 'No session bus: DBUS_SESSION_BUS_ADDRESS is not set.' };
    for (const entry of address.split(';')) {
        const colon = entry.indexOf(':');
        if (colon < 0 || entry.slice(0, colon) !== 'unix') continue;
        const keys = new Map(entry.slice(colon + 1).split(',').map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)] as const; }));
        const decode = (v: string) => decodeURIComponent(v);
        const path = keys.get('path');
        if (path) return { path: decode(path) };
        const abstract = keys.get('abstract');
        if (abstract) return { path: `\0${decode(abstract)}` };
    }
    return { error: `The session bus address is not one Genie can use (only unix:path= and unix:abstract=): ${address}` };
}

// ---------------------------------------------------------------------------------------------------------------------
// The wire format (D-Bus specification, "Message Protocol"): little-endian written; either read.

class Writer {
    #buf = Buffer.alloc(256);
    #len = 0;
    get length(): number { return this.#len; }
    #room(n: number): void {
        if (this.#len + n > MAX_MESSAGE_BYTES) throw new Error('message too large');
        if (this.#len + n <= this.#buf.length) return;
        const next = Buffer.alloc(Math.max(this.#buf.length * 2, this.#len + n));
        this.#buf.copy(next, 0, 0, this.#len);
        this.#buf = next;
    }
    align(n: number): void { const pad = (n - (this.#len % n)) % n; this.#room(pad); this.#buf.fill(0, this.#len, this.#len + pad); this.#len += pad; }
    y(v: number): void { this.#room(1); this.#buf.writeUInt8(v, this.#len); this.#len += 1; }
    u(v: number): void { this.align(4); this.#room(4); this.#buf.writeUInt32LE(v >>> 0, this.#len); this.#len += 4; }
    b(v: boolean): void { this.u(v ? 1 : 0); }
    s(v: string): void { const bytes = Buffer.from(v, 'utf8'); this.u(bytes.length); this.#room(bytes.length + 1); bytes.copy(this.#buf, this.#len); this.#len += bytes.length; this.#buf.writeUInt8(0, this.#len); this.#len += 1; }
    o(v: string): void { if (!isObjectPath(v)) throw new Error(`not an object path: ${v}`); this.s(v); }
    g(v: string): void { const bytes = Buffer.from(v, 'ascii'); if (bytes.length > 255) throw new Error('signature too long'); this.y(bytes.length); this.#room(bytes.length + 1); bytes.copy(this.#buf, this.#len); this.#len += bytes.length; this.#buf.writeUInt8(0, this.#len); this.#len += 1; }
    /** An array: its byte length, then padding to the element's alignment, then the elements. */
    array(elementAlign: number, write: () => void): void {
        this.align(4);
        const at = this.#len;
        this.u(0);
        this.align(elementAlign);
        const start = this.#len;
        write();
        this.#buf.writeUInt32LE(this.#len - start, at);
    }
    bytes(): Buffer { return Buffer.from(this.#buf.subarray(0, this.#len)); }
}

/** An object path as the specification defines it. */
export function isObjectPath(v: string): boolean {
    return v === '/' || /^(\/[A-Za-z0-9_]+)+$/.test(v);
}

class Reader {
    readonly #buf: Buffer;
    readonly #le: boolean;
    #at: number;
    constructor(buf: Buffer, le: boolean, at = 0) { this.#buf = buf; this.#le = le; this.#at = at; }
    get offset(): number { return this.#at; }
    #need(n: number): void { if (this.#at + n > this.#buf.length) throw new Error('message truncated'); }
    align(n: number): void {
        const pad = (n - (this.#at % n)) % n;
        this.#need(pad);
        for (let i = 0; i < pad; i += 1) if (this.#buf[this.#at + i] !== 0) throw new Error('non-zero alignment padding');
        this.#at += pad;
    }
    y(): number { this.#need(1); return this.#buf.readUInt8(this.#at++); }
    u(): number { this.align(4); this.#need(4); const v = this.#le ? this.#buf.readUInt32LE(this.#at) : this.#buf.readUInt32BE(this.#at); this.#at += 4; return v; }
    b(): boolean { const v = this.u(); if (v > 1) throw new Error('boolean out of range'); return v === 1; }
    #nul(): void { this.#need(1); if (this.#buf[this.#at] !== 0) throw new Error('string not NUL-terminated'); this.#at += 1; }
    s(): string { const n = this.u(); this.#need(n); const v = this.#buf.toString('utf8', this.#at, this.#at + n); this.#at += n; this.#nul(); return v; }
    o(): string { const v = this.s(); if (!isObjectPath(v)) throw new Error(`not an object path: ${v}`); return v; }
    g(): string { const n = this.y(); this.#need(n); const v = this.#buf.toString('ascii', this.#at, this.#at + n); this.#at += n; this.#nul(); return v; }
    array<T>(elementAlign: number, read: () => T): T[] {
        const n = this.u();
        if (n > MAX_MESSAGE_BYTES) throw new Error('array too long');
        this.align(elementAlign);
        const end = this.#at + n;
        this.#need(n);
        const out: T[] = [];
        while (this.#at < end) out.push(read());
        if (this.#at !== end) throw new Error('array length does not match its elements');
        return out;
    }
}

/** A value of one of the types this client reads: s o b ao a{sv}, and v of those. */
export type BusValue = string | boolean | readonly string[] | { readonly [key: string]: BusValue };

function readValue(r: Reader, sig: string, depth: number): BusValue {
    if (depth > MAX_DEPTH) throw new Error('value nested too deep');
    switch (sig) {
        case 's': return r.s();
        case 'o': return r.o();
        case 'b': return r.b();
        case 'ao': return r.array(4, () => r.o());
        case 'a{sv}': {
            const out: Record<string, BusValue> = {};
            r.array(8, () => { r.align(8); const k = r.s(); out[k] = readVariant(r, depth + 1); return null; });
            return out;
        }
        default: throw new Error(`unexpected type "${sig}"`);
    }
}

function readVariant(r: Reader, depth: number): BusValue {
    const sig = r.g();
    return readValue(r, sig, depth);
}

// Header field codes (D-Bus specification) and the one type each must carry.
const FIELD = { PATH: 1, INTERFACE: 2, MEMBER: 3, ERROR_NAME: 4, REPLY_SERIAL: 5, DESTINATION: 6, SENDER: 7, SIGNATURE: 8, UNIX_FDS: 9 } as const;
const FIELD_TYPE: Record<number, string> = { 1: 'o', 2: 's', 3: 's', 4: 's', 5: 'u', 6: 's', 7: 's', 8: 'g', 9: 'u' };

export const MESSAGE = { METHOD_CALL: 1, METHOD_RETURN: 2, ERROR: 3, SIGNAL: 4 } as const;

export interface BusMessage {
    readonly type: number;
    readonly serial: number;
    readonly path?: string;
    readonly iface?: string;
    readonly member?: string;
    readonly errorName?: string;
    readonly replySerial?: number;
    readonly sender?: string;
    readonly signature: string;
    /** The body, still encoded, and how to read it. */
    readonly body: Buffer;
    readonly le: boolean;
}

/** One method call, encoded. `signature` names the body's types; `body` writes them. */
export function encodeMethodCall(m: { serial: number; path: string; iface: string; member: string; destination: string; signature?: string; body?: (w: Writer) => void }): Buffer {
    const body = new Writer();
    m.body?.(body);
    const bodyBytes = body.bytes();
    const w = new Writer();
    w.y(0x6c); // 'l': little-endian
    w.y(MESSAGE.METHOD_CALL);
    w.y(0); // flags
    w.y(1); // protocol version
    w.u(bodyBytes.length);
    w.u(m.serial);
    w.array(8, () => {
        const field = (code: number, sig: string, write: () => void) => { w.align(8); w.y(code); w.g(sig); write(); };
        field(FIELD.PATH, 'o', () => w.o(m.path));
        field(FIELD.INTERFACE, 's', () => w.s(m.iface));
        field(FIELD.MEMBER, 's', () => w.s(m.member));
        field(FIELD.DESTINATION, 's', () => w.s(m.destination));
        if (m.signature) field(FIELD.SIGNATURE, 'g', () => w.g(m.signature!));
    });
    w.align(8);
    const head = w.bytes();
    if (head.length + bodyBytes.length > MAX_MESSAGE_BYTES) throw new Error('message too large');
    return Buffer.concat([head, bodyBytes]);
}

/** How many bytes the message at the start of `buf` takes, or null while its fixed header has not all arrived. */
export function frameLength(buf: Buffer): number | null {
    if (buf.length < 16) return null;
    const le = buf[0] === 0x6c;
    if (!le && buf[0] !== 0x42) throw new Error('not a D-Bus message (endianness byte)');
    if (buf[3] !== 1) throw new Error('unsupported D-Bus protocol version');
    const bodyLen = le ? buf.readUInt32LE(4) : buf.readUInt32BE(4);
    const fieldsLen = le ? buf.readUInt32LE(12) : buf.readUInt32BE(12);
    const head = 16 + fieldsLen;
    const total = head + ((8 - (head % 8)) % 8) + bodyLen;
    if (total > MAX_MESSAGE_BYTES || bodyLen > MAX_MESSAGE_BYTES || fieldsLen > MAX_MESSAGE_BYTES) throw new Error(`message larger than ${MAX_MESSAGE_BYTES} bytes`);
    return total;
}

/** One whole message, decoded and validated (header fields by code and type; the body kept for its reader). */
export function decodeMessage(buf: Buffer): BusMessage {
    const total = frameLength(buf);
    if (total === null || total > buf.length) throw new Error('message truncated');
    const le = buf[0] === 0x6c;
    const r = new Reader(buf.subarray(0, total), le);
    r.y(); const type = r.y(); r.y(); r.y();
    if (type < 1 || type > 4) throw new Error(`unknown message type ${type}`);
    const bodyLen = r.u();
    const serial = r.u();
    if (serial === 0) throw new Error('message serial 0');
    const fields: Record<number, string | number> = {};
    r.array(8, () => {
        r.align(8);
        const code = r.y();
        const sig = r.g();
        const expected = FIELD_TYPE[code];
        if (expected === undefined) {
            // Unknown codes MUST be ignored by the specification — but only as a type this reader can skip.
            if (sig !== 's' && sig !== 'o' && sig !== 'u' && sig !== 'g') throw new Error(`unexpected header field ${code} of type "${sig}"`);
        } else if (sig !== expected) throw new Error(`header field ${code} has type "${sig}", not "${expected}"`);
        const v = sig === 'u' ? r.u() : sig === 'g' ? r.g() : sig === 'o' ? r.o() : r.s();
        if (expected !== undefined) fields[code] = v;
        return null;
    });
    r.align(8);
    const body = buf.subarray(r.offset, r.offset + bodyLen);
    if (body.length !== bodyLen) throw new Error('message truncated');
    return {
        type, serial, le,
        signature: (fields[FIELD.SIGNATURE] as string | undefined) ?? '',
        body,
        ...(fields[FIELD.PATH] !== undefined ? { path: fields[FIELD.PATH] as string } : {}),
        ...(fields[FIELD.INTERFACE] !== undefined ? { iface: fields[FIELD.INTERFACE] as string } : {}),
        ...(fields[FIELD.MEMBER] !== undefined ? { member: fields[FIELD.MEMBER] as string } : {}),
        ...(fields[FIELD.ERROR_NAME] !== undefined ? { errorName: fields[FIELD.ERROR_NAME] as string } : {}),
        ...(fields[FIELD.REPLY_SERIAL] !== undefined ? { replySerial: fields[FIELD.REPLY_SERIAL] as number } : {}),
        ...(fields[FIELD.SENDER] !== undefined ? { sender: fields[FIELD.SENDER] as string } : {}),
    };
}

/** A message body, read as exactly `expected` (a sequence of the types above). A different signature is an error. */
export function readBody(m: BusMessage, expected: readonly string[]): BusValue[] {
    const want = expected.join('');
    if (m.signature !== want) throw new Error(`reply has signature "${m.signature}", not "${want}"`);
    const r = new Reader(m.body, m.le);
    const out = expected.map((sig) => (sig === 'v' ? readVariant(r, 0) : readValue(r, sig, 0)));
    if (r.offset !== m.body.length) throw new Error('reply has bytes past its values');
    return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// The connection.

export interface UnlockOptions {
    /** Where the bus is (a socket path; abstract names start with NUL). */
    readonly socketPath: string;
    /** This process's uid, for EXTERNAL auth. */
    readonly uid: number;
    /** Each step's bound (connect, auth, every call). The prompt wait has none. */
    readonly stepTimeoutMs?: number;
    /** Ends the prompt wait (the card's Cancel), and the socket with it. */
    readonly signal?: AbortSignal;
    /** For tests: open the socket another way. */
    readonly connect?: (path: string) => Socket;
}

class BusConnection {
    readonly #socket: Socket;
    #buf = Buffer.alloc(0);
    #serial = 0;
    #closed: Error | null = null;
    readonly #waiters = new Set<(m: BusMessage | Error) => void>();
    #lineWaiter: ((line: string | Error) => void) | null = null;
    #authed = false;

    constructor(socket: Socket) {
        this.#socket = socket;
        socket.on('data', (chunk: Buffer) => this.#data(chunk));
        socket.on('error', (e) => this.#fail(e));
        socket.on('close', () => this.#fail(new Error('the session bus closed the connection')));
    }

    #fail(e: Error): void {
        if (this.#closed) return;
        this.#closed = e;
        this.#lineWaiter?.(e);
        for (const w of [...this.#waiters]) w(e);
    }

    #data(chunk: Buffer): void {
        this.#buf = Buffer.concat([this.#buf, chunk]);
        if (this.#buf.length > MAX_MESSAGE_BYTES * 2) { this.#fail(new Error('the session bus sent more than Genie reads')); this.#socket.destroy(); return; }
        try {
            if (!this.#authed) {
                const nl = this.#buf.indexOf('\r\n');
                if (nl < 0) { if (this.#buf.length > 512) throw new Error('auth line too long'); return; }
                const line = this.#buf.toString('ascii', 0, nl);
                this.#buf = this.#buf.subarray(nl + 2);
                this.#lineWaiter?.(line);
                return;
            }
            for (;;) {
                const n = frameLength(this.#buf);
                if (n === null || n > this.#buf.length) return;
                const m = decodeMessage(this.#buf.subarray(0, n));
                this.#buf = this.#buf.subarray(n);
                for (const w of [...this.#waiters]) w(m);
            }
        } catch (error) {
            this.#fail(error instanceof Error ? error : new Error(String(error)));
            this.#socket.destroy();
        }
    }

    async auth(uid: number, timeoutMs: number): Promise<void> {
        const hex = Buffer.from(String(uid), 'ascii').toString('hex');
        const line = new Promise<string>((resolve, reject) => {
            this.#lineWaiter = (l) => (l instanceof Error ? reject(l) : resolve(l));
        });
        this.#socket.write(Buffer.concat([Buffer.from([0]), Buffer.from(`AUTH EXTERNAL ${hex}\r\n`, 'ascii')]));
        const answer = await bounded(line, timeoutMs, 'the session bus did not answer the sign-in');
        this.#lineWaiter = null;
        if (!/^OK [0-9a-f]+$/.test(answer)) throw new Error(`the session bus refused the sign-in: ${answer.slice(0, 80)}`);
        this.#authed = true;
        this.#socket.write('BEGIN\r\n');
        // Anything that came with the OK line is the first message.
        if (this.#buf.length > 0) this.#data(Buffer.alloc(0));
    }

    /** One method call; its reply (or error) within `timeoutMs`. */
    async call(destination: string, path: string, iface: string, member: string, signature: string, body: ((w: Writer) => void) | undefined, timeoutMs: number): Promise<BusMessage> {
        if (this.#closed) throw this.#closed;
        const serial = ++this.#serial;
        const reply = this.next((m) => (m.type === MESSAGE.METHOD_RETURN || m.type === MESSAGE.ERROR) && m.replySerial === serial);
        this.#socket.write(encodeMethodCall({ serial, path, iface, member, destination, ...(signature ? { signature } : {}), ...(body ? { body } : {}) }));
        const m = await bounded(reply.promise, timeoutMs, `${iface}.${member} did not answer`).finally(reply.cancel);
        if (m.type === MESSAGE.ERROR) {
            let words = '';
            try { if (m.signature.startsWith('s')) words = String(new Reader(m.body, m.le).s()); } catch { /* no words */ }
            throw new Error(`${m.errorName ?? 'error'}${words ? `: ${words}` : ''}`);
        }
        return m;
    }

    /** The next message `match` accepts (no timeout of its own); `cancel` stops waiting. */
    next(match: (m: BusMessage) => boolean): { promise: Promise<BusMessage>; cancel: () => void } {
        let waiter: ((m: BusMessage | Error) => void) | null = null;
        const promise = new Promise<BusMessage>((resolve, reject) => {
            if (this.#closed) { reject(this.#closed); return; }
            waiter = (m) => {
                if (m instanceof Error) { this.#waiters.delete(waiter!); reject(m); return; }
                if (!match(m)) return;
                this.#waiters.delete(waiter!);
                resolve(m);
            };
            this.#waiters.add(waiter);
        });
        return { promise, cancel: () => { if (waiter) this.#waiters.delete(waiter); } };
    }

    close(): void { this.#socket.destroy(); this.#fail(new Error('closed')); }
}

function bounded<T>(p: Promise<T>, ms: number, why: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${why} within ${Math.round(ms / 1000)} s`)), ms);
        p.then((v) => { clearTimeout(t); resolve(v); }, (e: unknown) => { clearTimeout(t); reject(e); });
    });
}

const BUS = { destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', iface: 'org.freedesktop.DBus' } as const;

/**
 * Ask the Secret Service to unlock the default collection, the desktop's own dialog included, and answer how it ended.
 * Never throws: a failure is `failed`, with the reason in `detail`.
 */
export async function unlockDefaultCollection(options: UnlockOptions): Promise<{ outcome: UnlockOutcome; detail: string | null; via?: 'unlock' | 'prompt' }> {
    const step = options.stepTimeoutMs ?? 5_000;
    if (options.signal?.aborted) return { outcome: 'cancelled', detail: null };
    let conn: BusConnection | null = null;
    try {
        const socket = (options.connect ?? ((path: string) => createConnection({ path })))(options.socketPath);
        await bounded(new Promise<void>((resolve, reject) => { socket.once('connect', () => resolve()); socket.once('error', reject); }), step, 'the session bus did not accept the connection');
        conn = new BusConnection(socket);
        await conn.auth(options.uid, step);
        await conn.call(BUS.destination, BUS.path, BUS.iface, 'Hello', '', undefined, step);
        const first = unlockCall();
        const unlockReply = await conn.call(SECRET_SERVICE, first.path, first.iface, first.member, 'ao', (w) => w.array(4, () => w.o(DEFAULT_COLLECTION)), step);
        const [unlocked, prompt] = readBody(unlockReply, ['ao', 'o']) as [string[], string];
        const next = afterUnlockReply({ unlocked, prompt });
        // No prompt object: the Secret Service unlocked it (or it was) with no dialog — e.g. a collection with no password.
        if ('done' in next) return { outcome: unlockOutcome({ kind: 'done' }), detail: null, via: 'unlock' };
        // Only THIS prompt's Completed: the match rule names its path.
        const rule = `type='signal',interface='${next.wait.iface}',member='${next.wait.member}',path='${next.wait.path}'`;
        await conn.call(BUS.destination, BUS.path, BUS.iface, 'AddMatch', 's', (w) => w.s(rule), step);
        const completed = conn.next((m) => m.type === MESSAGE.SIGNAL && m.path === next.wait.path && m.iface === next.wait.iface && m.member === next.wait.member);
        await conn.call(SECRET_SERVICE, next.prompt.path, next.prompt.iface, next.prompt.member, 's', (w) => w.s(''), step);
        // The person's own time: no timeout. Cancel ends it.
        const cancelled = new Promise<'cancelled'>((resolve) => options.signal?.addEventListener('abort', () => resolve('cancelled'), { once: true }));
        const signal = await Promise.race([completed.promise, cancelled]);
        if (signal === 'cancelled') { completed.cancel(); return { outcome: 'cancelled', detail: null }; }
        const [dismissed] = readBody(signal, ['b', 'v']) as [boolean, BusValue];
        return { outcome: unlockOutcome({ kind: 'completed', dismissed }), detail: null, via: 'prompt' };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { outcome: unlockOutcome({ kind: 'error', message }), detail: message };
    } finally {
        conn?.close();
    }
}

export { Writer as BusWriter, Reader as BusReader };

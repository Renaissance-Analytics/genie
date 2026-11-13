import type { WireAttachment } from '../core/engine-protocol.js';

/**
 * BYTES ACROSS THE ENGINE LINK'S REVERSE CALL (Tynn #657). genie-host's remote host swaps a phone's staged ids for the
 * bytes (remote-host.ts `#materialize`), then a connected window answers the call through `client.remoteInvoke`, which is
 * JSON — and JSON has no bytes: a Uint8Array becomes `{"0":255,"1":216,…}` and the window's host API refuses it ("an
 * attachment is not a file"). So the two methods that carry staged bytes, `prompt` (its attachments) and `files.upload`
 * (its file), cross as base64 (`WireAttachment`, as `engine.promptWith` does) and are bytes again on the window's side.
 * Every other call, and anything not in that shape, passes through untouched for the host API to judge.
 */

const isBytes = (v: unknown): v is Uint8Array => v instanceof Uint8Array;
const isWire = (v: unknown): v is WireAttachment => typeof v === 'object' && v !== null && typeof (v as { name?: unknown }).name === 'string' && typeof (v as { b64?: unknown }).b64 === 'string';

function toWire(v: unknown): unknown {
    const f = v as { name?: unknown; type?: unknown; bytes?: unknown } | null;
    if (!f || typeof f.name !== 'string' || !isBytes(f.bytes)) return v;
    return { name: f.name, type: typeof f.type === 'string' ? f.type : '', b64: Buffer.from(f.bytes.buffer, f.bytes.byteOffset, f.bytes.byteLength).toString('base64') } satisfies WireAttachment;
}

function fromWire(v: unknown): unknown {
    if (!isWire(v)) return v;
    return { name: v.name, type: typeof v.type === 'string' ? v.type : '', bytes: new Uint8Array(Buffer.from(v.b64, 'base64')) };
}

function mapBytes(method: string, args: readonly unknown[], one: (v: unknown) => unknown): unknown[] {
    if (method === 'prompt' && Array.isArray(args[2])) return [args[0], args[1], (args[2] as unknown[]).map(one), ...args.slice(3)];
    if (method === 'files.upload' && args.length > 2) return [args[0], args[1], one(args[2]), ...args.slice(3)];
    return [...args];
}

/** genie-host's side: a call's staged bytes as base64, before it is sent to the window. */
export function encodeRemoteInvokeArgs(method: string, args: readonly unknown[]): unknown[] {
    return mapBytes(method, args, toWire);
}

/** The window's side: the bytes again, before its host API answers the call. */
export function decodeRemoteInvokeArgs(method: string, args: readonly unknown[]): unknown[] {
    return mapBytes(method, args, fromWire);
}

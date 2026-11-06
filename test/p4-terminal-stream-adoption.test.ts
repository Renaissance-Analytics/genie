import { afterEach, expect, it, vi } from 'vitest';
import { TerminalViewStreams } from '../src/main/terminal-streams.js';
import { splitTerminalText, TERMINAL_CHUNK_BYTES, TERMINAL_QUEUE_BYTES } from '../src/core/terminal-stream.js';
import { resourceDoor } from './support/local-resource-door.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const inputModule = async () => { const path: string = '../src/main/local-terminal-input.js'; return import(path); };
const clientModule = async () => { const path: string = '../src/renderer/local-terminal-client.js'; return import(path); };

async function inputFixture() {
    const { LocalTerminalInputs } = await inputModule(), calls: Array<{ method: string; args: unknown[] }> = [];
    let gate: Promise<boolean> | null = null;
    const inputs = new LocalTerminalInputs({ invoke: async (method: string, args: unknown[]) => { calls.push({ method, args }); return gate ? await gate : true; } });
    return { inputs, calls, block: (promise: Promise<boolean> | null) => { gate = promise; } };
}
it('logical input ownership holds a terminal across chunks and queues other views and resize in arrival order', async () => {
    const h = await inputFixture(), ticket = await h.inputs.begin('a', 'live');
    let granted = false;
    const next = h.inputs.begin('b', 'live').then((id: string) => { granted = true; return id; });
    const resize = h.inputs.run('c', 'live', 'resize', ['live', 81.5, 25.5]);
    await h.inputs.chunk('a', ticket, 'first'); await tick(); expect(granted).toBe(false);
    await h.inputs.chunk('a', ticket, 'second'); await h.inputs.finish('a', ticket);
    const second = await next; await h.inputs.chunk('b', second, 'third'); await h.inputs.finish('b', second); await resize;
    expect(h.calls).toEqual([{ method: 'write', args: ['live', 'first'] }, { method: 'write', args: ['live', 'second'] }, { method: 'write', args: ['live', 'third'] }, { method: 'resize', args: ['live', 81.5, 25.5] }]);
});
it('input chunks use the existing bounded queue and resolve only after actual native acknowledgement', async () => {
    const h = await inputFixture(), gate = deferred<boolean>(); h.block(gate.promise);
    const ticket = await h.inputs.begin('a', 'live'), text = '🧪\u001b[31m'.repeat(350_000);
    let done = false;
    const chunks = [...splitTerminalText(text)].map(chunk => h.inputs.chunk('a', ticket, chunk.data));
    const finished = h.inputs.finish('a', ticket).then(() => { done = true; });
    await tick(); expect(done).toBe(false); expect(h.inputs.pendingBytes('live')).toBeGreaterThan(0); expect(h.inputs.pendingBytes('live')).toBeLessThanOrEqual(TERMINAL_QUEUE_BYTES);
    h.block(null); gate.resolve(true); await Promise.all(chunks); await finished;
    expect(h.calls.map(call => call.args[1]).join('') === text).toBe(true);
    expect(h.calls.every(call => Buffer.byteLength(JSON.stringify(call.args[1])) - 2 <= TERMINAL_CHUNK_BYTES)).toBe(true);
    expect(h.inputs.pendingBytes('live')).toBe(0);
});
it('disconnect drains accepted input, refuses its remaining work, and releases the next owner without closing its pty', async () => {
    const h = await inputFixture(), gate = deferred<boolean>(); h.block(gate.promise);
    const ticket = await h.inputs.begin('a', 'live'), accepted = h.inputs.chunk('a', ticket, 'accepted');
    const next = h.inputs.begin('b', 'live'); let granted = false; void next.then(() => { granted = true; });
    h.inputs.dropOwner('a'); await tick(); expect(granted).toBe(false);
    await expect(h.inputs.chunk('a', ticket, 'refused')).rejects.toThrow(/disconnect|closed/i);
    h.block(null); gate.resolve(true); await accepted;
    const second = await next; await h.inputs.chunk('b', second, 'other-owner'); await h.inputs.finish('b', second);
    expect(h.calls.map(call => call.args[1])).toEqual(['accepted', 'other-owner']); expect(h.calls.some(call => call.method === 'close')).toBe(false);
});
it('another terminal progresses while a terminal is blocked, and input tickets are owner scoped', async () => {
    const h = await inputFixture(), ticket = await h.inputs.begin('a', 'live');
    await expect(h.inputs.chunk('b', ticket, 'forged')).rejects.toThrow(/owner|connection|closed/i); expect(h.calls).toEqual([]);
    const other = await h.inputs.begin('b', 'other'); await h.inputs.chunk('b', other, 'independent'); await h.inputs.finish('b', other); await h.inputs.finish('a', ticket);
    expect(h.calls).toEqual([{ method: 'write', args: ['other', 'independent'] }]);
});
it('a native refusal is visible in words and queued close follows all accepted writes', async () => {
    const h = await inputFixture(), ticket = await h.inputs.begin('a', 'live');
    const close = h.inputs.run('b', 'live', 'close', ['live']); await h.inputs.chunk('a', ticket, 'before-close'); await h.inputs.finish('a', ticket); await close;
    expect(h.calls.map(call => call.method)).toEqual(['write', 'close']);
    const other = await h.inputs.begin('a', 'gone'); h.block(Promise.resolve(false));
    await expect(h.inputs.chunk('a', other, 'x')).rejects.toThrow(/gone|closed/i); h.inputs.dropOwner('a');
});

function asyncViews() {
    const snapshot = deferred<{ id: string; tail: string; epoch: string; endOffset: number } | null>();
    const sent: Array<{ kind: string; data?: string; reason?: string }> = []; let listening = false, off = 0;
    let data!: (event: { id: string; data: string; epoch?: string; offset?: number }) => void;
    const streams = new TerminalViewStreams({ snapshot: () => null, listen: listener => { listening = true; data = listener; return () => { off++; }; }, send: async (_owner, _view, event) => { sent.push(event); } });
    const fresh = () => { expect(listening).toBe(true); return snapshot.promise; };
    const watch = () => (streams as unknown as { watchFresh(owner: string, view: string, id: string, read: typeof fresh): Promise<unknown> }).watchFresh('owner', 'view', 'quiet', fresh);
    return { streams, snapshot, sent, watch, data: (text: string, offset: number, epoch = 'epoch') => data({ id: 'quiet', data: text, epoch, offset }), off: () => off };
}
it('async fresh attachment listens first and reconciles overlapping early output against the true producer end', async () => {
    const h = asyncViews(), joined = h.watch(); h.data('tailNEXT', 100);
    h.snapshot.resolve({ id: 'quiet', tail: 'tail', epoch: 'epoch', endOffset: 104 });
    await joined; await tick(); expect(h.sent).toEqual([{ kind: 'data', id: 'quiet', epoch: 'epoch', offset: 104, data: 'NEXT' }]); h.streams.dispose();
});
it('closing a view while its fresh snapshot waits never resurrects it or kills the pty', async () => {
    const h = asyncViews(), joined = h.watch(); h.streams.dropOwner('owner');
    h.snapshot.resolve({ id: 'quiet', tail: '', epoch: 'epoch', endOffset: 0 });
    expect(await joined).toBeNull(); expect(h.streams.refs('quiet')).toBe(0); expect(h.off()).toBe(1); expect(h.sent).toEqual([]);
});
it.each(['gap', 'epoch'])('early %s requires explicit resync instead of guessing offsets or dropping text silently', async kind => {
    const h = asyncViews(), joined = h.watch(); h.data('next', kind === 'gap' ? 101 : 100, kind === 'epoch' ? 'changed' : 'epoch');
    h.snapshot.resolve({ id: 'quiet', tail: '', epoch: 'epoch', endOffset: 100 }); await joined; await tick();
    expect(h.sent).toMatchObject([{ kind: 'resync' }]); h.streams.dispose();
});
it('early async snapshot overflow stays bounded and explicitly resyncs', async () => {
    const h = asyncViews(), joined = h.watch(); h.data('x'.repeat(TERMINAL_QUEUE_BYTES + 1024), 0);
    expect(h.streams.bufferedBytes('owner', 'view')).toBeLessThanOrEqual(TERMINAL_QUEUE_BYTES);
    h.snapshot.resolve({ id: 'quiet', tail: '', epoch: 'epoch', endOffset: 0 }); await joined; await tick();
    expect(h.sent).toMatchObject([{ kind: 'resync' }]); h.streams.dispose();
});

function wireNative() {
    let data: ((event: { id: string; data: string; epoch: string; offset: number }) => void) | null = null;
    let exit: ((event: { id: string; exitCode: number; epoch: string; endOffset: number }) => void) | null = null;
    const calls: Array<{ method: string; args: unknown[] }> = []; let listeners = 0, endOffset = 2_000_000;
    let listed: Array<{ id: string; pid: number; shell: string }> = [];
    const tail = 'tail' + String.fromCharCode(0xd800) + '🧪';
    const value = { id: 'quiet', pid: 41, shell: 'native', scrollback: tail };
    const native = { invoke: async (method: string, args: unknown[]) => { calls.push({ method, args }); return method === 'open' ? { id: 'opened', pid: 51, shell: 'native' } : method === 'attach' ? value : method === 'list' ? listed : true; },
        snapshot: async (_workspace: unknown, id: string) => id === 'quiet' ? { value, position: { epoch: 'epoch', endOffset } } : null,
        listen: (onData: typeof data, onExit: typeof exit) => { listeners++; data = onData; exit = onExit; return () => { listeners--; data = null; exit = null; }; } };
    return { native, calls, tail, setTail: (text: string) => { value.scrollback = text; }, setList: (values: typeof listed) => { listed = values; }, listeners: () => listeners, emit: (text: string) => { const offset = endOffset; endOffset += text.length; data?.({ id: 'quiet', data: text, epoch: 'epoch', offset }); },
        unrelated: () => data?.({ id: 'hidden', data: 'must-not-travel', epoch: 'hidden', offset: 0 }), exit: () => exit?.({ id: 'quiet', exitCode: 7, epoch: 'epoch', endOffset }) };
}
it.each(['write', 'open'])('a large local %s crosses bounded frames without staging and reaches native text intact', async method => {
    const h = wireNative(), f = await resourceDoor(cleanups, {}, { localTerminals: h.native }), c = await f.client();
    const text = '🧪\u001b[31m' + String.fromCharCode(0xd800) + 'x'.repeat(2 * 1024 * 1024);
    if (method === 'write') await c.bridge.terminals.write('quiet', text);
    else await c.bridge.terminals.open('work', { cols: 80, rows: 24, command: text });
    const original = method === 'write' ? h.calls.filter(call => call.method === 'write').map(call => call.args[1]).join('') : (h.calls.find(call => call.method === 'open')!.args[1] as { command: string }).command;
    expect(original === text).toBe(true); expect(f.serialized.every(frame => Buffer.byteLength(frame) <= 1024 * 1024)).toBe(true);
    expect(f.calls.some(call => /upload|stage/i.test(call.method))).toBe(false);
    expect(f.calls.length).toBeGreaterThan(8); // A whole oversized command in one unchecked frame is not a pass.
});
it('local display membership shares one producer listener, sends no unrelated data and releases interest without pty close', async () => {
    const { watchTerminal } = await clientModule(), h = wireNative(), f = await resourceDoor(cleanups, {}, { localTerminals: h.native });
    const first = await f.client(), second = await f.client(), a: string[] = [], b: string[] = [], errors: string[] = [];
    const observer = (values: string[]) => ({ snapshot: (value: { scrollback: string }) => { values.push(value.scrollback); }, data: (text: string) => { values.push(text); }, exit: () => {}, error: (error: Error) => errors.push(error.message) });
    expect(h.listeners()).toBe(0);
    const stopA = watchTerminal(first.bridge.terminals, null, 'quiet', observer(a)), stopB = watchTerminal(second.bridge.terminals, null, 'quiet', observer(b));
    await vi.waitFor(() => { expect(a.length).toBe(1); expect(b.length).toBe(1); }); expect(a[0] === h.tail).toBe(true); expect(h.listeners()).toBe(1);
    const count = f.serialized.length; h.unrelated(); await tick(); expect(f.serialized.length).toBe(count);
    h.emit('next'); await vi.waitFor(() => { expect(a.at(-1)).toBe('next'); expect(b.at(-1)).toBe('next'); });
    stopA(); await tick(); expect(h.listeners()).toBe(1); h.emit('second'); await vi.waitFor(() => expect(b.at(-1)).toBe('second')); expect(a.at(-1)).toBe('next');
    stopB(); await vi.waitFor(() => expect(h.listeners()).toBe(0)); expect(h.calls.some(call => call.method === 'close')).toBe(false); expect(errors).toEqual([]);
});
it('local stream ACK waits for actual snapshot and data application, and exit follows final output', async () => {
    const { watchTerminal } = await clientModule(), h = wireNative(), f = await resourceDoor(cleanups, {}, { localTerminals: h.native }), c = await f.client();
    const snapshot = deferred<void>(), applied = deferred<void>(), order: string[] = [], errors: string[] = [];
    const stop = watchTerminal(c.bridge.terminals, null, 'quiet', { snapshot: async () => { order.push('snapshot'); await snapshot.promise; }, data: async (text: string) => { order.push(text); await applied.promise; }, exit: (code: number) => order.push(`exit:${code}`), error: (error: Error) => errors.push(error.message) });
    await vi.waitFor(() => expect(order).toEqual(['snapshot'])); h.emit('last'); h.exit(); await tick(); expect(order).toEqual(['snapshot']);
    snapshot.resolve(); await vi.waitFor(() => expect(order).toEqual(['snapshot', 'last']));
    expect(f.calls.filter(call => call.method === 'terminals.localAck')).toHaveLength(0);
    applied.resolve(); await vi.waitFor(() => expect(order).toEqual(['snapshot', 'last', 'exit:7']));
    expect(f.calls.some(call => call.method === 'terminals.localAck')).toBe(true); expect(errors).toEqual([]); stop();
});
it.each(['attach', 'list'])('large native %s DTOs use owner-scoped JSON blobs, preserving UTF-16 and frame limits', async method => {
    const h = wireNative(), f = await resourceDoor(cleanups, {}, { localTerminals: h.native }), c = await f.client();
    const tail = (String.fromCharCode(0xd800) + '\u001b').repeat(131_070) + '🧪' + String.fromCharCode(0xdc00);
    const listed = Array.from({ length: 6000 }, (_, index) => ({ id: `native-${index}-${'x'.repeat(500)}`, pid: index + 1, shell: tail.slice(-10) }));
    h.setTail(tail); h.setList(listed);
    const result = method === 'attach' ? await c.bridge.terminals.attach(null, 'quiet') : await c.bridge.terminals.list('work');
    expect(JSON.stringify(result) === JSON.stringify(method === 'attach' ? { id: 'quiet', pid: 41, shell: 'native', scrollback: tail } : listed)).toBe(true);
    expect(f.serialized.every(frame => Buffer.byteLength(frame) <= 1024 * 1024)).toBe(true);
    expect(f.calls.some(call => call.method === 'blob.open' && call.args[0] === 'terminal-json')).toBe(true);
    expect(f.calls.some(call => call.method === 'content.release')).toBe(true); expect(h.listeners()).toBe(0);
});

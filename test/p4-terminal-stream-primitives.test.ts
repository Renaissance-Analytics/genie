import { Buffer } from 'node:buffer';
import { expect, it, vi } from 'vitest';
import { IPC_INVENTORY } from '../src/core/ipc-inventory.js';
import { serveSpawnHost } from '../src/main/spawn-host-server.js';
import type { SpawnChannel, SpawnFrame, SpawnMethod } from '../src/main/spawn-host-protocol.js';
import type { PtyPort } from '../src/main/terminal-host.js';

const core = async () => { const file: string = '../src/core/terminal-stream.js'; return import(file); };
const host = async () => { const file: string = '../src/main/terminal-streams.js'; return import(file); };
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

it('uses the approved 256KiB chunk and 4MiB in-flight queue limits', async () => {
    const m = await core(); expect(m.TERMINAL_CHUNK_BYTES).toBe(256 * 1024); expect(m.TERMINAL_QUEUE_BYTES).toBe(4 * 1024 * 1024);
});
it.each(['ascii', 'unicode', 'escaped'])('splits %s text lazily without loss, oversized JSON strings or a split surrogate pair', async kind => {
    const { splitTerminalText, TERMINAL_CHUNK_BYTES } = await core();
    const source = (kind === 'ascii' ? 'plain' : kind === 'unicode' ? '雪😀' : '\u0000\n"\\').repeat(150_000);
    const iterator = splitTerminalText(source, 73); expect(iterator[Symbol.iterator]()).toBe(iterator);
    const chunks = [...iterator]; expect(chunks.length).toBeGreaterThan(1);
    let offset = 73;
    for (const [i, chunk] of chunks.entries()) {
        expect(chunk.offset).toBe(offset); offset += chunk.data.length;
        expect(Buffer.byteLength(chunk.data, 'utf8')).toBeLessThanOrEqual(TERMINAL_CHUNK_BYTES);
        expect(Buffer.byteLength(JSON.stringify(chunk.data), 'utf8')).toBeLessThanOrEqual(TERMINAL_CHUNK_BYTES + 2);
        if (i > 0) { const before = chunks[i - 1].data.charCodeAt(chunks[i - 1].data.length - 1), after = chunk.data.charCodeAt(0); expect(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff).toBe(false); }
    }
    expect(chunks.map(c => c.data).join('') === source).toBe(true); expect(offset).toBe(73 + source.length);
});
it('preserves empty input and lone surrogate code units rather than normalizing native terminal text', async () => {
    const { splitTerminalText } = await core(); expect([...splitTerminalText('', 4)]).toEqual([{ data: '', offset: 4, bytes: 0 }]);
    const text = 'a\ud800b\udc00'; expect([...splitTerminalText(text, 0)].map(c => c.data).join('') === text).toBe(true);
});
it('counts UTF-16 code units monotonically and never derives a lifetime offset from a retained tail', async () => {
    const { TerminalOutputCounter } = await core(), counter = new TerminalOutputCounter('epochA');
    expect(counter.append('A雪')).toEqual({ epoch: 'epochA', offset: 0, endOffset: 2 });
    expect(counter.append('😀')).toEqual({ epoch: 'epochA', offset: 2, endOffset: 4 });
    expect(counter.append('last')).toEqual({ epoch: 'epochA', offset: 4, endOffset: 8 });
    expect(counter.snapshot()).toEqual({ epoch: 'epochA', endOffset: 8 });
});

function producer() {
    const frames: SpawnFrame[] = []; let receive!: (frame: SpawnFrame) => void, data!: (id: string, text: string) => void, exit!: (id: string, code: number) => void, serial = 0, request = 0;
    const tails = new Map<string, string>();
    const pty: PtyPort = { open: () => { const id = 'engine-' + ++serial; tails.set(id, ''); return { id, pid: 100 + serial, shell: 'sh', scrollback: '' }; },
        write: () => true, resize: () => true, kill: id => tails.delete(id), scrollback: id => tails.get(id)?.slice(-4),
        onData: fn => { data = fn; return () => {}; }, onExit: fn => { exit = fn; return () => {}; } };
    const channel: SpawnChannel = { send: frame => { frames.push(frame); }, onFrame: fn => { receive = fn; }, onClose: () => {} };
    const server = serveSpawnHost(channel, { exec: vi.fn() as never, stream: vi.fn() as never, pty });
    const call = (method: SpawnMethod, args: unknown[]) => { const id = ++request; receive({ kind: 'call', id, method, args }); return id; };
    const emit = (text: string) => { const id = 'engine-' + serial; tails.set(id, (tails.get(id) ?? '') + text); data(id, text); };
    const payloads = (name: string) => frames.filter((f): f is Extract<SpawnFrame, { kind: 'event' }> => f.kind === 'event' && f.channel === name).map(f => f.payload as Record<string, unknown>);
    return { frames, call, emit, payloads, end: () => exit('engine-' + serial, 0), close: () => server.killAll() };
}
it('the real spawn producer attaches true offsets and one epoch to every data frame', () => {
    const f = producer(); f.call('pty.open', ['t', { cwd: '/synthetic' }, { kind: 'terminal', workspaceId: 'w', shell: 'sh' }]);
    for (const text of ['A雪', '😀', 'last']) f.emit(text);
    const rows = f.payloads('pty.data'); expect(rows.map(x => x.offset)).toEqual([0, 2, 4]);
    const epoch = rows[0]!.epoch; expect(typeof epoch).toBe('string'); expect(rows.every(x => x.epoch === epoch)).toBe(true);
    f.close();
});
it('the real bounded tail snapshot carries the sum of all output code units rather than its retained length', () => {
    const f = producer(); f.call('pty.open', ['t', { cwd: '/synthetic' }]); for (const text of ['A雪', '😀', 'last']) f.emit(text);
    const id = f.call('pty.list', []), result = f.frames.find((x): x is Extract<SpawnFrame, { kind: 'result'; ok: true }> => x.kind === 'result' && x.id === id && x.ok);
    expect((result!.value as Array<Record<string, unknown>>)[0]).toMatchObject({ id: 't', scrollback: 'last', epoch: expect.any(String), endOffset: 8 }); f.close();
});
it('the real producer exit carries the final authoritative epoch and offset after its last data', () => {
    const f = producer(); f.call('pty.open', ['t', { cwd: '/synthetic' }]); f.emit('雪😀'); f.end();
    expect(f.payloads('pty.exit').at(-1)).toMatchObject({ id: 't', epoch: expect.any(String), endOffset: 3, code: 0 }); f.close();
});
it('a newly counted pty has a new epoch even when a public terminal id is reused', () => {
    const f = producer(); f.call('pty.open', ['t', { cwd: '/synthetic' }]); f.emit('first'); const first = f.payloads('pty.data').at(-1)!; f.end();
    f.call('pty.open', ['t', { cwd: '/synthetic' }]); f.emit('new'); const second = f.payloads('pty.data').at(-1)!;
    expect(typeof first.epoch).toBe('string'); expect(second.epoch).not.toBe(first.epoch); expect(second.offset).toBe(0); f.close();
});
it('versions the counter-bearing spawn protocol', async () => {
    const spawnFile: string = '../src/main/spawn-host-protocol.js'; expect((await import(spawnFile)).SPAWN_PROTOCOL).toBe(2);
});
it('the actual spawn producer announces its counter-bearing protocol version', () => {
    const f = producer(); expect(f.payloads('host.ready')[0]).toMatchObject({ protocol: 2 }); f.close();
});
it('versions the counter-bearing engine protocol', async () => {
    const engineFile: string = '../src/core/engine-protocol.js'; expect((await import(engineFile)).ENGINE_PROTOCOL).toBe(2);
});
it('classifies TakeOver as the existing window capability it opens', () => {
    expect(IPC_INVENTORY.find(([channel]) => channel === 'genie:take-over')?.[1]).toBe('window-port');
});

it('applies a tail at its authoritative endOffset and discards duplicate/overlapping live code units', async () => {
    const { TerminalStreamReceiver } = await core(), receiver = new TerminalStreamReceiver();
    expect(receiver.attach({ epoch: 'e', endOffset: 100, tail: 'tail' })).toMatchObject({ kind: 'attached', data: 'tail' });
    expect(receiver.snapshot()).toMatchObject({ epoch: 'e', expectedOffset: 100 });
    expect(receiver.data({ epoch: 'e', offset: 98, data: 'ilAB' })).toMatchObject({ kind: 'data', data: 'AB' });
    expect(receiver.data({ epoch: 'e', offset: 98, data: 'ilAB' })).toMatchObject({ kind: 'ignored' });
    expect(receiver.data({ epoch: 'e', offset: 102, data: '😀' })).toMatchObject({ kind: 'data', data: '😀' });
    expect(receiver.snapshot()).toMatchObject({ expectedOffset: 104 });
});
it.each(['gap', 'epoch'])('a live %s requires resync without guessing or advancing the held stream', async fault => {
    const { TerminalStreamReceiver } = await core(), receiver = new TerminalStreamReceiver(); receiver.attach({ epoch: 'e', endOffset: 100, tail: 'tail' });
    expect(receiver.data({ epoch: fault === 'epoch' ? 'new' : 'e', offset: fault === 'gap' ? 103 : 100, data: 'x' })).toMatchObject({ kind: 'resync' });
    expect(receiver.snapshot()).toMatchObject({ epoch: 'e', expectedOffset: 100 });
});
it.each([{ tail: 'tail' }, { epoch: 'e', tail: 'tail' }, { epoch: 'e', endOffset: 2, tail: 'tail' }])('missing or inconsistent producer counters require full resync: %j', async snapshot => {
    const { TerminalStreamReceiver } = await core(), receiver = new TerminalStreamReceiver();
    expect(receiver.attach(snapshot)).toMatchObject({ kind: 'resync' }); expect(receiver.snapshot()).toMatchObject({ epoch: null, expectedOffset: null });
});
it('exit follows the final offset; an exit beyond received output requires re-attachment', async () => {
    const { TerminalStreamReceiver } = await core(), receiver = new TerminalStreamReceiver(); receiver.attach({ epoch: 'e', endOffset: 100, tail: 'tail' });
    expect(receiver.exit({ epoch: 'e', endOffset: 103, exitCode: 0 })).toMatchObject({ kind: 'resync' });
    receiver.data({ epoch: 'e', offset: 100, data: 'abc' }); expect(receiver.exit({ epoch: 'e', endOffset: 103, exitCode: 0 })).toMatchObject({ kind: 'exit', exitCode: 0 });
});

function inputPorts() { return { write: vi.fn(async (_id: string, _data: string) => true), resize: vi.fn(async (_id: string, _cols: number, _rows: number) => true), close: vi.fn(async (_id: string) => true) }; }
it('backpressures a large write at the 4MiB in-flight bound and applies later writes/resize/close in order', async () => {
    const { TerminalInputQueue } = await host(), { TERMINAL_QUEUE_BYTES, TERMINAL_CHUNK_BYTES } = await core(), ports = inputPorts(), blocked = deferred<boolean>();
    const queue = new TerminalInputQueue(ports), text = 'a'.repeat(5 * 1024 * 1024), order: string[] = [];
    ports.write.mockImplementation(async (_id, data) => { order.push('write:' + data); return true; }); ports.write.mockImplementationOnce(() => blocked.promise);
    ports.resize.mockImplementation(async () => { order.push('resize'); return true; }); ports.close.mockImplementation(async () => { order.push('close'); return true; });
    let done = false; const first = queue.write('t', text).then(() => { done = true; }), second = queue.write('t', 'later'), resize = queue.resize('t', 90, 30), close = queue.close('t');
    await flush(); expect(done).toBe(false); expect(queue.pendingBytes('t')).toBeLessThanOrEqual(TERMINAL_QUEUE_BYTES); expect(queue.pendingBytes('t')).toBeGreaterThan(TERMINAL_QUEUE_BYTES - 2 * TERMINAL_CHUNK_BYTES);
    expect(ports.resize).not.toHaveBeenCalled(); expect(ports.close).not.toHaveBeenCalled(); blocked.resolve(true); await Promise.all([first, second, resize, close]);
    expect(ports.write.mock.calls.map(call => call[1]).join('') === text + 'later').toBe(true); expect(order.slice(-2)).toEqual(['resize', 'close']); expect(queue.pendingBytes('t')).toBe(0);
});
it('one blocked terminal does not block another terminal and no write has a new aggregate size ceiling', async () => {
    const { TerminalInputQueue } = await host(), ports = inputPorts(), blocked = deferred<boolean>(); ports.write.mockImplementationOnce(() => blocked.promise);
    const queue = new TerminalInputQueue(ports), a = queue.write('a', 'held'); await flush(); await queue.write('b', 'independent');
    expect(ports.write).toHaveBeenCalledWith('b', 'independent'); blocked.resolve(true); await a;
});
it('disconnect refuses queued input in words, drains resources and never closes a pty as view cleanup', async () => {
    const { TerminalInputQueue } = await host(), ports = inputPorts(), blocked = deferred<boolean>(); ports.write.mockImplementationOnce(() => blocked.promise);
    const queue = new TerminalInputQueue(ports), outcomes = [queue.write('t', 'a'.repeat(5 * 1024 * 1024)), queue.resize('t', 1, 1)].map(p => p.then(() => null, (error: Error) => error.message));
    await flush(); queue.disconnect(); const refused = await Promise.all(outcomes); expect(refused.every(text => /closed|disconnect/i.test(text))).toBe(true); expect(queue.pendingBytes('t')).toBe(0);
    blocked.resolve(true); await flush(); expect(ports.write).toHaveBeenCalledTimes(1); expect(ports.close).not.toHaveBeenCalled();
});
it('terminal-gone refusal drains only that terminal and leaves other queues usable', async () => {
    const { TerminalInputQueue } = await host(), ports = inputPorts(); ports.write.mockResolvedValueOnce(false); const queue = new TerminalInputQueue(ports);
    await expect(queue.write('gone', 'x')).rejects.toThrow(/gone|closed/i); expect(queue.pendingBytes('gone')).toBe(0); await queue.write('live', 'kept');
});

function views() {
    let data!: (event: Record<string, unknown>) => void, exit!: (event: Record<string, unknown>) => void;
    const off = vi.fn(), send = vi.fn(async (_owner: string, _view: string, _event: Record<string, unknown>) => {});
    const listen = vi.fn((onData: typeof data, onExit: typeof exit) => { data = onData; exit = onExit; return off; });
    const snapshot = vi.fn((id: string) => ({ id, epoch: 'e', endOffset: 100, tail: 'tail' }));
    return { ports: { send, listen, snapshot }, send, listen, off, data: (event: Record<string, unknown>) => data?.(event), exit: (event: Record<string, unknown>) => exit?.(event) };
}
it('displayed terminal views share one producer listener/refcount and undisplayed terminals send nothing', async () => {
    const { TerminalViewStreams } = await host(), f = views(), hub = new TerminalViewStreams(f.ports);
    hub.watch('a', 'v1', 't'); hub.watch('b', 'v2', 't'); expect(f.listen).toHaveBeenCalledTimes(1); expect(hub.refs('t')).toBe(2);
    f.data({ id: 'unshown', epoch: 'e', offset: 0, data: 'private' }); await flush(); expect(f.send).not.toHaveBeenCalled();
    f.data({ id: 't', epoch: 'e', offset: 100, data: 'x' }); await flush(); expect(f.send).toHaveBeenCalledTimes(2);
    hub.unwatch('a', 'v1'); expect(hub.refs('t')).toBe(1); expect(f.off).not.toHaveBeenCalled(); hub.dropOwner('b'); expect(hub.refs('t')).toBe(0); expect(f.off).toHaveBeenCalledTimes(1); hub.dispose();
});
it('attach/live overlap uses the returned endOffset; the receiver never duplicates the tail', async () => {
    const { TerminalViewStreams } = await host(), { TerminalStreamReceiver } = await core(), f = views(), receiver = new TerminalStreamReceiver(), delivered: string[] = [];
    f.send.mockImplementation(async (_owner, _view, event) => { const result = event.kind === 'data' ? receiver.data(event) : null; if (result?.kind === 'data') delivered.push(result.data); });
    const hub = new TerminalViewStreams(f.ports), snapshot = hub.watch('a', 'v', 't'); receiver.attach(snapshot);
    f.data({ id: 't', epoch: 'e', offset: 98, data: 'ilNEW' }); await flush(); expect(delivered.join('')).toBe('NEW'); hub.dispose();
});
it('bounded output chunks retain offsets and exit is sent only after the final data acknowledgement', async () => {
    const { TerminalViewStreams } = await host(), f = views(), blocked = deferred<void>(); f.send.mockImplementationOnce(() => blocked.promise);
    const hub = new TerminalViewStreams(f.ports); hub.watch('a', 'v', 't'); const text = '雪😀'.repeat(100_000);
    f.data({ id: 't', epoch: 'e', offset: 100, data: text }); f.exit({ id: 't', epoch: 'e', endOffset: 100 + text.length, exitCode: 0 }); await flush();
    expect(f.send).toHaveBeenCalledTimes(1); blocked.resolve(); await flush(); const events = f.send.mock.calls.map(call => call[2]);
    expect(events.at(-1)).toMatchObject({ kind: 'exit', endOffset: 100 + text.length }); const chunks = events.filter(x => x.kind === 'data'); expect(chunks.map(x => x.data).join('') === text).toBe(true);
    let at = 100; for (const chunk of chunks) { expect(chunk.offset).toBe(at); at += (chunk.data as string).length; expect(Buffer.byteLength(JSON.stringify(chunk))).toBeLessThan(512 * 1024); } hub.dispose();
});
it('subscriber overflow sends explicit resync, keeps its queue bounded and never silently invents a missing prefix', async () => {
    const { TerminalViewStreams } = await host(), { TERMINAL_QUEUE_BYTES } = await core(), f = views(), blocked = deferred<void>(); f.send.mockImplementationOnce(() => blocked.promise);
    const hub = new TerminalViewStreams(f.ports); hub.watch('a', 'v', 't'); f.data({ id: 't', epoch: 'e', offset: 100, data: 'x' }); await flush();
    f.data({ id: 't', epoch: 'e', offset: 101, data: 'z'.repeat(5 * 1024 * 1024) }); expect(hub.bufferedBytes('a', 'v')).toBeLessThanOrEqual(TERMINAL_QUEUE_BYTES);
    blocked.resolve(); await flush(); expect(f.send.mock.calls.some(call => call[2].kind === 'resync')).toBe(true); hub.dispose();
});
it('owner/view cleanup cancels late queued sends without affecting another view or ending the terminal', async () => {
    const { TerminalViewStreams } = await host(), f = views(), blocked = deferred<void>(); f.send.mockImplementationOnce(() => blocked.promise);
    const hub = new TerminalViewStreams(f.ports); hub.watch('a', 'same-view', 't'); hub.watch('b', 'same-view', 't');
    f.data({ id: 't', epoch: 'e', offset: 100, data: 'first' }); await flush(); hub.dropOwner('a'); f.data({ id: 't', epoch: 'e', offset: 105, data: 'second' }); blocked.resolve(); await flush();
    const a = f.send.mock.calls.filter(call => call[0] === 'a'), b = f.send.mock.calls.filter(call => call[0] === 'b');
    expect(a).toHaveLength(1); expect(b.map(call => call[2].data)).toEqual(['first', 'second']); expect(hub.refs('t')).toBe(1); hub.dispose();
});

import { readFile } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { IPC_INVENTORY } from '../src/core/ipc-inventory.js';
import { localSession } from '../src/renderer/local-session.js';
import { resourceDoor, resultValue } from './support/local-resource-door.js';

const nativeModule = async () => { const file: string = '../src/main/local-terminal-native.js'; return import(file); };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
const oddText = 'native ' + String.fromCharCode(0xd800) + ' 🧪 ' + String.fromCharCode(0xdc00);
const methods = ['open', 'write', 'resize', 'close', 'list', 'attach'] as const;
const alias = (method: string) => `terminals.local${method[0]!.toUpperCase()}${method.slice(1)}`;

async function nativeFixture() {
    const module = await nativeModule(), calls: Array<{ method: string; args: unknown[] }> = [], errors: Array<{ path: string; error: unknown }> = [];
    let available = true, track: unknown = undefined, openError: Error | null = null, snapshots = 0;
    const env = { GENIE_MCP_URL: 'http://synthetic.invalid/mcp', GENIE_MCP_TOKEN: 'synthetic-only' };
    const records = new Map([
        ['live', { id: 'live', pid: 41, shell: 'native-shell', workspaceId: 'work' as string | null, scrollback: oddText, epoch: 'epoch-live' as string | undefined, endOffset: 1_000_000 as number | undefined }],
        ['other', { id: 'other', pid: 42, shell: 'other-shell', workspaceId: 'elsewhere' as string | null, scrollback: 'other', epoch: 'epoch-other' as string | undefined, endOffset: 500 as number | undefined }],
        ['quiet', { id: 'quiet', pid: 43, shell: 'quiet-shell', workspaceId: null as string | null, scrollback: '', epoch: 'epoch-quiet' as string | undefined, endOffset: 0 as number | undefined }],
    ]);
    const backend = {
        openReady: async (options: Record<string, unknown>) => { calls.push({ method: 'open', args: [options] }); if (openError) throw openError; return { id: 'opened', pid: 51, shell: 'native-shell' }; },
        lastCwd: (id: string) => { calls.push({ method: 'lastCwd', args: [id] }); return '/remembered'; },
        write: (id: string, data: string) => { calls.push({ method: 'write', args: [id, data] }); return records.has(id); },
        resize: (id: string, cols: number, rows: number) => { calls.push({ method: 'resize', args: [id, cols, rows] }); return records.has(id); },
        close: (id: string) => { calls.push({ method: 'close', args: [id] }); return records.delete(id); },
        list: () => [...records.values()].filter(record => record.id !== 'quiet'),
        attach: () => { throw new Error('cached attach is not an authoritative snapshot'); },
    };
    const port = module.createNativeTerminalPort({
        terminals: () => available ? backend : null,
        workspaces: () => [{ id: 'work', path: '/workspace' }], trackCwd: () => track,
        environment: (id: string) => { calls.push({ method: 'env', args: [id] }); return env; },
        freshSnapshot: async (id: string) => { snapshots++; return records.get(id) ?? null; },
        openError: (path: string, error: unknown) => errors.push({ path, error }),
    });
    return { port, calls, records, env, errors, snapshots: () => snapshots,
        available: (value: boolean) => { available = value; }, track: (value: unknown) => { track = value; }, failOpen: (error: Error) => { openError = error; } };
}

it('native open keeps current cwd tracking, environment, personal ownership and positive floored options', async () => {
    const h = await nativeFixture(), command = '  echo native\r\n';
    expect(await h.port.invoke('open', ['work', { cols: 81.9, rows: 25.8, command }])).toEqual({ id: 'opened', pid: 51, shell: 'native-shell' });
    const options = h.calls.find(call => call.method === 'open')!.args[0] as Record<string, unknown>;
    expect(options).toEqual({ workspaceId: 'work', cwd: '/remembered', command, cols: 81, rows: 25, personal: true, env: h.env });
    expect(h.calls.filter(call => call.method === 'env').map(call => call.args)).toEqual([['work']]);
});
it('native open honors track_cwd=false and leaves absent/blank options absent', async () => {
    const h = await nativeFixture(); h.track(false);
    await h.port.invoke('open', ['work', { cols: 0, rows: -1, command: ' \r\n ' }]);
    const options = h.calls.find(call => call.method === 'open')!.args[0] as Record<string, unknown>;
    expect(options).toMatchObject({ cwd: '/workspace', command: undefined, cols: undefined, rows: undefined, personal: true });
    expect(h.calls.some(call => call.method === 'lastCwd')).toBe(false);
});
it('native open passes a large command whole and unchanged, without a new aggregate limit', async () => {
    const h = await nativeFixture(), command = '  ' + oddText + 'x'.repeat(2 * 1024 * 1024) + '\r\n';
    await h.port.invoke('open', ['work', { command }]);
    expect((h.calls.find(call => call.method === 'open')!.args[0] as { command: string }).command === command).toBe(true);
});
it('native open reports and rethrows the engine error without fabricating a pid or shell', async () => {
    const h = await nativeFixture(), error = new Error('synthetic native open refusal'); h.failOpen(error);
    await expect(h.port.invoke('open', ['work', null])).rejects.toBe(error);
    expect(h.errors).toEqual([{ path: '/workspace', error }]);
});
it.each([null, 7, false, {}, 'missing'])('native open refuses invalid workspace %j before environment or backend work', async workspace => {
    const h = await nativeFixture(); expect(await h.port.invoke('open', [workspace, {}])).toBeNull(); expect(h.calls).toEqual([]);
});
it('native unavailable-engine guards preserve null, false and empty-list results', async () => {
    const h = await nativeFixture(); h.available(false);
    expect(await h.port.invoke('open', ['work', {}])).toBeNull();
    expect(await h.port.invoke('write', ['live', 'x'])).toBe(false); expect(await h.port.invoke('resize', ['live', 80, 24])).toBe(false);
    expect(await h.port.invoke('close', ['live'])).toBe(false); expect(await h.port.invoke('list', ['work'])).toEqual([]);
    expect(await h.port.invoke('attach', [null, 'live'])).toBeNull(); expect(h.snapshots()).toBe(0);
});
it('native write and close keep strict string guards and boolean wire values', async () => {
    const h = await nativeFixture();
    expect(await h.port.invoke('write', [7, 'x'])).toBe(false); expect(await h.port.invoke('write', ['live', 7])).toBe(false);
    expect(await h.port.invoke('close', [null])).toBe(false); expect(h.calls).toEqual([]);
    expect(await h.port.invoke('write', ['live', ''])).toBe(true); expect(await h.port.invoke('write', ['gone', 'x'])).toBe(false);
    expect(await h.port.invoke('close', ['live'])).toBe(true); expect(await h.port.invoke('close', ['live'])).toBe(false);
});
it('native resize floors numbers without coercing non-numbers or adding a positive-only guard', async () => {
    const h = await nativeFixture();
    expect(await h.port.invoke('resize', ['live', '80', 24])).toBe(false); expect(await h.port.invoke('resize', [null, 80, 24])).toBe(false);
    expect(await h.port.invoke('resize', ['live', -2.1, 0])).toBe(true);
    expect(h.calls.filter(call => call.method === 'resize').map(call => call.args)).toEqual([['live', -3, 0]]);
});
it('native list returns only id/pid/shell for the named workspace; null is not a list-all request', async () => {
    const h = await nativeFixture();
    expect(await h.port.invoke('list', ['work'])).toEqual([{ id: 'live', pid: 41, shell: 'native-shell' }]);
    expect(await h.port.invoke('list', [null])).toEqual([]); expect(await h.port.invoke('list', ['missing'])).toEqual([]);
});
it('native attach uses one fresh snapshot and preserves its old public shape and UTF-16 text', async () => {
    const h = await nativeFixture();
    const joined = await h.port.invoke('attach', ['work', 'live']);
    expect(joined).toEqual({ id: 'live', pid: 41, shell: 'native-shell', scrollback: oddText }); expect(h.snapshots()).toBe(1);
    const snapshot = await h.port.snapshot('work', 'live');
    expect(snapshot.position).toEqual({ epoch: 'epoch-live', endOffset: 1_000_000 });
    expect(snapshot.value.scrollback === oddText).toBe(true); // End is authoritative, never the retained tail's length.
});
it('native null-workspace attach joins quiet/disposable terminals absent from the cached list', async () => {
    const h = await nativeFixture();
    expect(await h.port.invoke('attach', [null, 'quiet'])).toEqual({ id: 'quiet', pid: 43, shell: 'quiet-shell', scrollback: '' });
    expect((await h.port.snapshot(null, 'quiet')).position).toEqual({ epoch: 'epoch-quiet', endOffset: 0 });
    expect(await h.port.invoke('attach', ['work', 'quiet'])).toBeNull(); expect(await h.port.invoke('attach', ['work', 'other'])).toBeNull();
});
it('native invalid attach arguments refuse before snapshot work, while gone returns null', async () => {
    const h = await nativeFixture();
    for (const args of [[undefined, 'live'], [false, 'live'], [null, 7]]) expect(await h.port.invoke('attach', args)).toBeNull();
    expect(h.snapshots()).toBe(0); expect(await h.port.invoke('attach', [null, 'gone'])).toBeNull();
});
it('unknown or invalid producer positions stay unknown rather than becoming zero or tail length', async () => {
    const h = await nativeFixture(), record = h.records.get('live')!;
    record.epoch = undefined; expect((await h.port.snapshot('work', 'live')).position).toBeNull();
    record.epoch = 'epoch-live'; record.endOffset = undefined; expect((await h.port.snapshot('work', 'live')).position).toBeNull();
    record.endOffset = Number.MAX_SAFE_INTEGER + 1; expect((await h.port.snapshot('work', 'live')).position).toBeNull();
});

const nativeArgs: Record<string, unknown[]> = { open: ['work', { command: 'native' }], write: ['live', 'x'], resize: ['live', 80, 24], close: ['live'], list: ['work'], attach: [null, 'live'] };
const nativeValues: Record<string, unknown> = { open: { id: 'opened', pid: 51, shell: 'native-shell' }, write: true, resize: false, close: false, list: [{ id: 'live', pid: 41, shell: 'native-shell' }], attach: { id: 'live', pid: 41, shell: 'native-shell', scrollback: oddText } };
function nativeStub() {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    return { calls, invoke: async (method: string, args: unknown[]) => { const name = method.replace(/^terminals\.local/, '').toLowerCase(); calls.push({ method: name, args }); return nativeValues[name]; } };
}
it.each(methods)('the authenticated local door carries native %s result on the actual wire', async method => {
    const native = nativeStub(), f = await resourceDoor(cleanups, {}, { localTerminals: native }), raw = await f.raw();
    const value = resultValue(await raw.call(alias(method), nativeArgs[method]!));
    expect(value).toEqual(nativeValues[method]); expect(native.calls).toEqual([{ method, args: nativeArgs[method] }]);
});
it.each(methods)('a paired remote owner cannot call local %s or trigger any native work', async method => {
    const native = nativeStub(), f = await resourceDoor(cleanups, {}, { localTerminals: native }), raw = await f.raw('tailnet');
    const frame = await raw.call(alias(method), nativeArgs[method]!);
    expect(frame).toMatchObject({ kind: 'result', ok: false, reason: expect.stringMatching(/local|own .*window/i) }); expect(native.calls).toEqual([]);
});
it('remote terminal methods still use their existing route rather than the local native port', async () => {
    const native = nativeStub(), f = await resourceDoor(cleanups, {}, { localTerminals: native }), raw = await f.raw('tailnet');
    resultValue(await raw.call('terminals.list', ['work'])); expect(native.calls).toEqual([]);
    expect(f.invoke).toHaveBeenCalledWith('terminals.list', ['work']);
});
it('the local renderer bridge dispatches open through its native-local alias', async () => {
    const native = nativeStub(), f = await resourceDoor(cleanups, {}, { localTerminals: native }), c = await f.client();
    expect(await c.bridge.terminals.open('work', { cols: 80, rows: 24, command: 'native' })).toEqual(nativeValues.open);
    expect(f.calls.some(call => call.method === 'terminals.localOpen')).toBe(true);
    expect(f.calls.some(call => call.method === 'terminals.open')).toBe(false);
});
it('a failed local connection exposes terminal methods and reports disconnect instead of falling back to native IPC', async () => {
    const facade = localSession(undefined) as unknown as { terminals: { write(id: string, data: string): Promise<void> } };
    expect(facade.terminals).toBeDefined();
    await expect(facade.terminals.write('live', 'x')).rejects.toThrow(/connection|closed|not available/i);
});
it('the adoption removes all six native handlers/preload calls and both native broadcasts while retaining window ports', async () => {
    const main = await readFile(new URL('../src/main/main.ts', import.meta.url), 'utf8'), preload = await readFile(new URL('../src/main/preload.ts', import.meta.url), 'utf8');
    for (const method of methods) {
        const channel = `genie:terminal-${method}`;
        expect(main.includes(`'${channel}'`)).toBe(false); expect(preload.includes(`'${channel}'`)).toBe(false);
        expect(IPC_INVENTORY.some(([registered]) => registered === channel)).toBe(false);
    }
    for (const event of ['data', 'exit']) { const channel = `genie:terminal-${event}`; expect(main.includes(`'${channel}'`)).toBe(false); expect(preload.includes(`'${channel}'`)).toBe(false); }
    expect(IPC_INVENTORY).toContainEqual(['genie:scratch-terminal-open', 'window-port']); expect(IPC_INVENTORY).toContainEqual(['genie:take-over', 'window-port']);
});

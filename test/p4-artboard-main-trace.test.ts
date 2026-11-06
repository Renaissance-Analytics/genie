import * as path from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';

const load = async () => { const file: string = '../scripts/artboard-main-trace.mjs'; return import(file); };
const nativeEvents = (trace: { snapshot(): { events: Array<Record<string, unknown>> } }) => trace.snapshot().events.filter(event => event.kind !== 'trace-install');
const root = path.resolve('owned-artboard-home');
const aclArgs = (target = path.join(root, 'agent-credentials')) => ['-NoProfile', '-EncodedCommand', Buffer.from(`$targets=@(@{Path=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${Buffer.from(target, 'utf16le').toString('base64')}'));Directory=$true})`, 'utf16le').toString('base64')];
function fixture() {
    let time = 10, complete: ((error: Error | null, stdout?: string, stderr?: string) => void) | undefined;
    let resolve!: (value: { stdout: string; stderr: string }) => void;
    const child = { pid: 42 }, finished = Object.assign(new Promise<{ stdout: string; stderr: string }>(done => { resolve = done; }), { child });
    const exec = vi.fn((_file: string, _args: string[], _options: unknown, callback?: typeof complete) => { time += 3; complete = callback; return child; });
    Object.defineProperty(exec, promisify.custom, { configurable: true, value: vi.fn(() => { time += 5; return finished; }) });
    class Session { post(method: string, _params: unknown, callback?: (error: Error | null) => void): string { time += method === 'Profiler.start' ? 611 : 2; callback?.(null); return 'native-post-result'; } }
    const ports = { child: { execFile: exec }, inspector: { Session }, path, util: { promisify }, syncBuiltinESMExports: vi.fn(), now: () => time, wallNow: () => 1_700_000_000_000 + time, cpuUsage: () => ({ user: time * 1000, system: 0 }) };
    return { ports, exec, child, finished, advance: (ms: number) => { time += ms; }, complete: () => complete?.(null, 'native stdout', 'native stderr'), resolve, session: () => new Session() };
}

it('identifies only the owned ACL target and separates synchronous launch cost from asynchronous duration', async () => {
    const f = fixture(), { installArtboardMainTrace } = await load(), trace = installArtboardMainTrace(root, f.ports), callback = vi.fn();
    expect(f.ports.child.execFile('powershell.exe', aclArgs(), {}, callback)).toBe(f.child);
    f.advance(50); f.complete();
    expect(callback).toHaveBeenCalledExactlyOnceWith(null, 'native stdout', 'native stderr');
    expect(nativeEvents(trace)).toEqual([expect.objectContaining({ kind: 'private-acl', targets: ['agent-credentials'], syncMs: 3, durationMs: 53, state: 'done' })]);
    expect(JSON.stringify(trace.snapshot())).not.toContain('EncodedCommand'); trace.stop();
});
it('preserves promisified execFile child identity and result while recording the real completion', async () => {
    const f = fixture(), { installArtboardMainTrace } = await load(), trace = installArtboardMainTrace(root, f.ports);
    const run = promisify(f.ports.child.execFile) as unknown as (...args: unknown[]) => typeof f.finished;
    const result = run('powershell.exe', aclArgs(), {});
    expect(result.child).toBe(f.child); f.advance(40); f.resolve({ stdout: 'kept', stderr: '' });
    expect(await result).toEqual({ stdout: 'kept', stderr: '' });
    expect(nativeEvents(trace)).toEqual([expect.objectContaining({ kind: 'private-acl', syncMs: 5, durationMs: 45, state: 'done' })]); trace.stop();
});
it('never records encoded commands, stdout, arguments or paths outside the owned test home', async () => {
    const f = fixture(), { installArtboardMainTrace } = await load(), trace = installArtboardMainTrace(root, f.ports);
    f.ports.child.execFile('powershell.exe', aclArgs(path.resolve('foreign-secret-home', 'secret.key')), {}, vi.fn()); f.complete();
    const snapshot = JSON.stringify(trace.snapshot()); expect(snapshot).not.toContain('foreign-secret-home'); expect(snapshot).not.toContain('secret.key'); expect(snapshot).not.toContain('native stdout');
    expect(nativeEvents(trace)[0]!.targets).toEqual(['outside-owned-home']); trace.stop();
});
it('ignores non-ACL processes and preserves their arguments and return value', async () => {
    const f = fixture(), { installArtboardMainTrace } = await load(), trace = installArtboardMainTrace(root, f.ports), callback = vi.fn();
    expect(f.ports.child.execFile('git', ['status'], {}, callback)).toBe(f.child); f.complete();
    expect(f.exec).toHaveBeenCalledWith('git', ['status'], {}, expect.any(Function)); expect(nativeEvents(trace)).toEqual([]); trace.stop();
});
it('records a failed synchronous launch without replacing the original error', async () => {
    const f = fixture(), error = new Error('synthetic launch refused'); f.exec.mockImplementationOnce(() => { throw error; });
    const { installArtboardMainTrace } = await load(), trace = installArtboardMainTrace(root, f.ports);
    expect(() => f.ports.child.execFile('powershell.exe', aclArgs(), {}, vi.fn())).toThrow(error);
    expect(nativeEvents(trace)[0]).toMatchObject({ kind: 'private-acl', state: 'failed' }); trace.stop();
});
it('times Profiler.start synchronously without changing callback or return semantics', async () => {
    const f = fixture(), { installArtboardMainTrace } = await load(), trace = installArtboardMainTrace(root, f.ports), callback = vi.fn();
    expect(f.session().post('Profiler.start', {}, callback)).toBe('native-post-result'); expect(callback).toHaveBeenCalledExactlyOnceWith(null);
    expect(nativeEvents(trace)[0]).toMatchObject({ kind: 'profiler', method: 'Profiler.start', syncMs: 611, durationMs: 611, state: 'done' }); trace.stop();
});
it('bounds diagnostic records and exposes the dropped count', async () => {
    const f = fixture(), { installArtboardMainTrace } = await load(), trace = installArtboardMainTrace(root, f.ports), session = f.session();
    for (let i = 0; i < 1030; i++) session.post('Profiler.stop', {}, vi.fn());
    expect(trace.snapshot().events).toHaveLength(1024); expect(trace.snapshot().dropped).toBe(7); trace.stop();
});
it('restores native functions and builtin ESM bindings on stop, which is idempotent', async () => {
    const f = fixture(), originalPost = f.ports.inspector.Session.prototype.post, { installArtboardMainTrace } = await load(), trace = installArtboardMainTrace(root, f.ports);
    expect(f.ports.child.execFile).not.toBe(f.exec); trace.stop(); trace.stop();
    expect(f.ports.child.execFile).toBe(f.exec); expect(f.ports.inspector.Session.prototype.post).toBe(originalPost); expect(f.ports.syncBuiltinESMExports).toHaveBeenCalledTimes(2);
});

it('records a labelled synthetic installation marker and live hook status before any native work', async () => {
    const f = fixture(), { installArtboardMainTrace } = await load(), trace = installArtboardMainTrace(root, f.ports);
    expect(trace.snapshot()).toMatchObject({ installed: { execFile: true, inspectorPost: true }, events: [expect.objectContaining({ kind: 'trace-install', synthetic: true, label: 'synthetic-install-marker', state: 'done', startedMs: 10 })] }); trace.stop();
});
it('reports effective off modes and accepts only the mandatory installation event when native work is not expected', async () => {
    const f = fixture(), { installArtboardMainTrace, validateArtboardMainTrace } = await load(), trace = installArtboardMainTrace(root, f.ports);
    const modes = { profiler: false, profilerPolicy: 'stallStacksWanted', privateAclLaunch: false }; trace.setModes(modes);
    expect(trace.snapshot().modes).toEqual(modes); expect(nativeEvents(trace)).toEqual([]); expect(() => validateArtboardMainTrace(trace.snapshot())).not.toThrow(); trace.stop();
});
it('requires an actual profiler span when stack sampling is effectively on; a marker alone is insufficient', async () => {
    const f = fixture(), { installArtboardMainTrace, validateArtboardMainTrace } = await load(), trace = installArtboardMainTrace(root, f.ports);
    trace.setModes({ profiler: true, profilerPolicy: 'legacy-always-on', privateAclLaunch: false });
    expect(() => validateArtboardMainTrace(trace.snapshot())).toThrow(/profiler/i);
    f.session().post('Profiler.start', {}, vi.fn()); expect(() => validateArtboardMainTrace(trace.snapshot())).not.toThrow(); trace.stop();
});
it('keeps the private ACL launch positive control mandatory where that path is expected', async () => {
    const f = fixture(), { installArtboardMainTrace, validateArtboardMainTrace } = await load(), trace = installArtboardMainTrace(root, f.ports);
    trace.setModes({ profiler: false, profilerPolicy: 'stallStacksWanted', privateAclLaunch: true });
    expect(() => validateArtboardMainTrace(trace.snapshot())).toThrow(/ACL|launch/i);
    f.ports.child.execFile('powershell.exe', aclArgs(), {}, vi.fn()); f.complete(); expect(() => validateArtboardMainTrace(trace.snapshot())).not.toThrow(); trace.stop();
});
it('never accepts a missing marker or an uninstalled hook even when both native modes are off', async () => {
    const f = fixture(), { installArtboardMainTrace, validateArtboardMainTrace } = await load(), trace = installArtboardMainTrace(root, f.ports);
    trace.setModes({ profiler: false, profilerPolicy: 'stallStacksWanted', privateAclLaunch: false });
    expect(() => validateArtboardMainTrace({ ...trace.snapshot(), events: [] })).toThrow(/marker|install/i);
    expect(() => validateArtboardMainTrace({ ...trace.snapshot(), installed: { execFile: true, inspectorPost: false } })).toThrow(/hook|install/i);
    trace.stop(); expect(() => validateArtboardMainTrace(trace.snapshot())).toThrow(/hook|install|stopped/i);
});
it('refuses an unconfigured trace instead of assuming native work is disabled', async () => {
    const f = fixture(), { installArtboardMainTrace, validateArtboardMainTrace } = await load(), trace = installArtboardMainTrace(root, f.ports);
    expect(() => validateArtboardMainTrace(trace.snapshot())).toThrow(/mode/i); trace.stop();
});

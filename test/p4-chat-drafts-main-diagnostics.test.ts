import { expect, it, vi } from 'vitest';

const helper = async () => { const path: string = '../scripts/chat-drafts-main-diagnostics.mjs'; return import(path); };
function rig() {
    let time = 0, gc: (entries: Array<{ startTime: number; duration: number; detail: { kind: number } }>) => void = () => {};
    const encode = vi.fn(function(this: { length: number }, encoding?: string) { time += 3; return encoding === 'base64' ? 'YQ==' : 'a'; });
    const from = vi.fn((...args: unknown[]) => { time += 2; return { length: args[1] === 'base64' ? 1 : 7 }; });
    const buffer = { from, prototype: { toString: encode } }, stopGc = vi.fn();
    return { buffer, from, encode, stopGc, now: () => time, advance: (ms: number) => { time += ms; }, emit: (entries: Parameters<typeof gc>[0]) => gc(entries),
        onGc: (listen: typeof gc) => { gc = listen; return stopGc; } };
}
it('counts actual base64 decode and encode time/bytes, with a zero then one positive control', async () => {
    const { installDraftMainDiagnostics } = await helper(), f = rig(), d = installDraftMainDiagnostics(f);
    expect(d.snapshot().decode.calls).toBe(0);
    const value = f.buffer.from('YQ==', 'base64'); expect(value.length).toBe(1);
    expect(f.buffer.prototype.toString.call({ length: 1 }, 'base64')).toBe('YQ==');
    expect(d.snapshot()).toMatchObject({ decode: { calls: 1, bytes: 1, totalMs: 2, maxMs: 2 }, encode: { calls: 1, bytes: 1, totalMs: 3, maxMs: 3 } });
    d.stop(); expect(f.buffer.from).toBe(f.from); expect(f.buffer.prototype.toString).toBe(f.encode); expect(f.stopGc).toHaveBeenCalledOnce();
});
it('preserves every original argument/receiver and excludes non-base64 conversions', async () => {
    const { installDraftMainDiagnostics } = await helper(), f = rig(), d = installDraftMainDiagnostics(f), bytes = new Uint8Array([1, 2]);
    f.buffer.from(bytes, 0, 2); f.buffer.prototype.toString.call({ length: 9 }, 'utf8');
    expect(f.from).toHaveBeenCalledWith(bytes, 0, 2); expect(d.snapshot().decode.calls).toBe(0); expect(d.snapshot().encode.calls).toBe(0); d.stop();
});
it('reset separates rows while observer records GC time/position without content', async () => {
    const { installDraftMainDiagnostics } = await helper(), f = rig(), d = installDraftMainDiagnostics(f);
    f.buffer.from('YQ==', 'base64'); f.emit([{ startTime: 20, duration: 330, detail: { kind: 4 } }]);
    expect(d.snapshot()).toMatchObject({ gc: { count: 1, totalMs: 330, maxMs: 330, events: [{ startTime: 20, duration: 330, kind: 4 }] } });
    d.reset(); expect(d.snapshot()).toMatchObject({ decode: { calls: 0 }, gc: { count: 0, totalMs: 0, events: [] } }); d.stop();
});
it('bounds retained GC records, preserves total/max and restores only its own wrappers', async () => {
    const { installDraftMainDiagnostics } = await helper(), f = rig(), d = installDraftMainDiagnostics(f);
    for (let i = 0; i < 300; i++) f.emit([{ startTime: i, duration: i + 1, detail: { kind: 1 } }]);
    const snapshot = d.snapshot(); expect(snapshot.gc.count).toBe(300); expect(snapshot.gc.events.length).toBeLessThanOrEqual(256); expect(snapshot.gc.maxMs).toBe(300);
    const other = vi.fn(); f.buffer.from = other; d.stop(); expect(f.buffer.from).toBe(other); expect(f.buffer.prototype.toString).toBe(f.encode);
});
it('does not retain the source bytes or base64 text in diagnostic output', async () => {
    const { installDraftMainDiagnostics } = await helper(), f = rig(), d = installDraftMainDiagnostics(f), secret = 'private-generated-content';
    f.buffer.from(secret, 'base64'); const rendered = JSON.stringify(d.snapshot()); expect(rendered).not.toContain(secret); d.stop();
});
it('records a failed original conversion and still restores instrumentation on stop', async () => {
    const { installDraftMainDiagnostics } = await helper(), f = rig(), fail = vi.fn(() => { f.advance(7); throw new Error('synthetic'); }); f.buffer.from = fail;
    const d = installDraftMainDiagnostics(f); expect(() => f.buffer.from('YQ==', 'base64')).toThrow('synthetic');
    expect(d.snapshot().decode).toMatchObject({ calls: 1, errors: 1, totalMs: 7 }); d.stop(); expect(f.buffer.from).toBe(fail);
});

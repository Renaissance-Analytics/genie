import { afterEach, expect, it } from 'vitest';
import { MAX_OPEN_PAGES } from '../src/core/local-content.js';
import { resourceDoor } from './support/local-resource-door.js';

/*
 * Tynn #547, the terminal slot: a terminal answer over the inline size (a snapshot's scrollback) is a held response on the
 * same connection as Files. Terminals mounting together must never fill the cap, and a full cap names them.
 */
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
const scrollback = 'scrollback 雪 '.repeat(20_000);
function gate() { let open!: () => void; const promise = new Promise<void>(resolve => { open = resolve; }); return { promise, open }; }

function native(wait: Promise<void> | null = null) {
    const calls: string[] = [];
    return { calls, invoke: async (method: string, args: unknown[]) => {
        const name = method.replace(/^terminals\.local/, '').toLowerCase(); calls.push(name);
        if (name === 'attach') { if (wait) await wait; const id = String(args[1]); return { id, pid: 41, shell: 'native-shell', scrollback }; }
        if (name === 'write') return true;
        return null;
    } };
}

it('many terminals attaching at once on one connection never hit the cap', async () => {
    const g = gate(), stub = native(g.promise), f = await resourceDoor(cleanups, {}, { localTerminals: stub }), c = await f.client();
    const attaches = Array.from({ length: MAX_OPEN_PAGES + 4 }, (_, i) => c.bridge.terminals.attach('work', `t${i}`));
    for (const a of attaches) a.catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 20));
    g.open();
    const settled = await Promise.allSettled(attaches);
    expect(settled.flatMap(s => s.status === 'rejected' ? [String((s.reason as Error)?.message ?? s.reason)] : [])).toEqual([]);
    for (const [i, s] of settled.entries()) expect(s).toMatchObject({ status: 'fulfilled', value: { id: `t${i}`, scrollback } });
});

it('a keystroke never waits behind held terminal or Files reads', async () => {
    const g = gate(), stub = native(g.promise), f = await resourceDoor(cleanups, {}, { localTerminals: stub }), c = await f.client();
    const attaches = Array.from({ length: MAX_OPEN_PAGES + 4 }, (_, i) => c.bridge.terminals.attach('work', `t${i}`));
    for (const a of attaches) a.catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 20));
    await c.bridge.terminals.write('t0', 'x');
    expect(stub.calls).toContain('write');
    g.open(); await Promise.allSettled(attaches);
});

it('a full cap names the terminal reads that hold it and evicts nothing', async () => {
    const stub = native(), f = await resourceDoor(cleanups, {}, { localTerminals: stub }), raw = await f.raw();
    const held: string[] = [];
    for (let i = 0; i < MAX_OPEN_PAGES; i++) {
        const r = await raw.call('terminals.localAttach', [null, `t${i}`]) as unknown as { ok: boolean; value: { terminalContent: { ref: string } } };
        expect(r.ok).toBe(true); held.push(r.value.terminalContent.ref);
    }
    const refused = await raw.call('terminals.localAttach', [null, 'one-more']) as unknown as { ok: boolean; reason: string };
    expect(refused.ok).toBe(false);
    expect(refused.reason).toMatch(/only 8 lists or responses/);
    expect(refused.reason).toMatch(/terminals\.localAttach/);
    for (const ref of held) expect(await raw.call('content.release', [ref])).toMatchObject({ ok: true, value: { released: true } });
    expect(await raw.call('terminals.localAttach', [null, 'one-more'])).toMatchObject({ ok: true });
});

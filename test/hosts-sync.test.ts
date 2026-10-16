import { describe, expect, it } from 'vitest';
import { HOSTS_BEGIN, hostsFileBlock } from '../src/core/gen-router.js';
import { Elevator, type ElevationOutcome, type PrivilegedStep } from '../src/main/elevate.js';
import { HOSTS_STEP_ID, HostsSync, type HostsIo, type HostsSyncResult } from '../src/main/hosts-file.js';

/**
 * THE HOSTS FILE FOLLOWS THE CONFIGURED NAMES (S4; Genie 1's genie#624 and genie#604). The file is administrator-owned,
 * so every write may be a UAC prompt — which is why it must move only when the person changes WHICH sites exist:
 *
 * - a change whose names are the ones already tried does nothing at all — no read, no write, no prompt (a start/stop);
 * - a burst of changes is ONE write (debounced), and syncs run one at a time — never two prompts on screen;
 * - a write the process may not make is staged and copied through the OS prompt; a declined prompt is reported with
 *   the block to paste and is NOT retried by the next change of the same names — only by the person, or by a Trust;
 * - a Trust pressed while a write is due carries that write in its ONE prompt, and a failure names the step.
 *
 * Everything is a fake: the file, the prompt, the clock (a manual scheduler, so "a burst" is exact, not timing).
 */

const EACCES = () => Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });

function fakeIo(initial: string, opts: { denyPlain?: boolean } = {}) {
    let content = initial;
    let staged: string | null = null;
    const calls: string[] = [];
    const port: HostsIo = {
        read: async () => { calls.push('read'); return content; },
        write: async (next) => { calls.push('write'); if (opts.denyPlain) throw EACCES(); content = next; },
        stage: async (next) => { calls.push('stage'); staged = next; return { command: 'cp', args: ['/home/user/.genie/runtime/hosts.next', '/etc/hosts'] }; },
    };
    return { port, calls, content: () => content, apply: () => { if (staged !== null) content = staged; }, writes: () => calls.filter((c) => c === 'write' || c === 'stage').length };
}

/** The OS prompt: every batch it was handed (by step id), how many were on screen at once, and what it answers. */
function fakePrompt(io: ReturnType<typeof fakeIo>) {
    const batches: string[][] = [];
    let open = 0;
    let mostOpen = 0;
    const state: { declined: boolean; failStep: string | null; gate: Promise<void> | null } = { declined: false, failStep: null, gate: null };
    const elevator = new Elevator(async (steps: readonly PrivilegedStep[]): Promise<ElevationOutcome> => {
        batches.push(steps.map((s) => s.id));
        open += 1;
        mostOpen = Math.max(mostOpen, open);
        try {
            await (state.gate ?? Promise.resolve());
            if (state.declined) return { ok: false, failed: null, error: 'Request dismissed' };
            for (const s of steps) {
                if (s.id === state.failStep) return { ok: false, failed: { id: s.id, label: s.label }, error: `${s.label} failed` };
                if (s.id === HOSTS_STEP_ID) io.apply();
            }
            return { ok: true };
        } finally {
            open -= 1;
        }
    });
    return { elevator, batches, state, mostOpen: () => mostOpen };
}

function manualClock() {
    const pending: Array<{ fn: () => void; ms: number; live: boolean }> = [];
    return {
        schedule: (fn: () => void, ms: number) => { const t = { fn, ms, live: true }; pending.push(t); return () => { t.live = false; }; },
        live: () => pending.filter((t) => t.live).length,
        fire: () => { for (const t of pending.splice(0)) if (t.live) t.fn(); },
    };
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

function setup(initial = '127.0.0.1 localhost\n', opts: { denyPlain?: boolean } = {}) {
    const io = fakeIo(initial, opts);
    const prompt = fakePrompt(io);
    const clock = manualClock();
    let names: string[] = [];
    const results: HostsSyncResult[] = [];
    const sync = new HostsSync({ names: () => names, io: io.port, elevator: prompt.elevator, debounceMs: 250, schedule: clock.schedule, onResult: (r) => results.push(r) });
    return { io, prompt, clock, sync, results, setNames: (n: string[]) => { names = n; } };
}

describe('what is written', () => {
    it('nothing when the block already matches — one read, no write, no prompt', async () => {
        const t = setup(`127.0.0.1 localhost\n${hostsFileBlock(['tynn.gen'])}\n`);
        t.setNames(['tynn.gen']);
        expect(await t.sync.flush()).toEqual({ changed: false, elevated: false });
        expect(t.io.calls).toEqual(['read']);
        expect(t.prompt.batches).toEqual([]);
    });

    it('plainly when the process may; through ONE prompt (the staged copy) only when the plain write is refused', async () => {
        const plain = setup();
        plain.setNames(['tynn.gen']);
        expect(await plain.sync.flush()).toEqual({ changed: true, elevated: false });
        expect(plain.io.content()).toContain('::1 tynn.gen');
        expect(plain.prompt.batches).toEqual([]);

        const locked = setup('127.0.0.1 localhost\n', { denyPlain: true });
        locked.setNames(['tynn.gen']);
        expect(await locked.sync.flush()).toEqual({ changed: true, elevated: true });
        expect(locked.io.calls).toEqual(['read', 'write', 'stage']);
        expect(locked.prompt.batches).toEqual([[HOSTS_STEP_ID]]);
        expect(locked.io.content()).toContain('127.0.0.1 tynn.gen');
    });

    it('a declined prompt is an error with the block the person could paste — and the file is untouched', async () => {
        const t = setup('127.0.0.1 localhost\n', { denyPlain: true });
        t.prompt.state.declined = true;
        t.setNames(['tynn.gen']);
        const r = await t.sync.flush();
        expect(r).toEqual({ changed: false, elevated: false, error: 'Request dismissed', manualBlock: hostsFileBlock(['tynn.gen']) });
        expect(t.io.content()).toBe('127.0.0.1 localhost\n');
    });

    it('the last name removed takes the block out entirely', async () => {
        const t = setup(`127.0.0.1 localhost\n${hostsFileBlock(['old.gen'])}\n`);
        t.setNames([]);
        await t.sync.flush();
        expect(t.io.content()).toBe('127.0.0.1 localhost\n');
        expect(t.io.content()).not.toContain(HOSTS_BEGIN);
    });
});

describe('when it is written', () => {
    it('nothing at all before boot has loaded the sites; begin() is then ONE sync of the whole set', async () => {
        const t = setup('127.0.0.1 localhost\n', { denyPlain: true });
        for (const n of [['a.gen'], ['a.gen', 'b.gen'], ['a.gen', 'b.gen', 'c.gen']]) { t.setNames(n); t.sync.changed(); }
        expect(t.clock.live()).toBe(0);
        expect(t.io.calls).toEqual([]);
        t.sync.begin();
        t.clock.fire();
        await settle();
        expect(t.prompt.batches).toEqual([[HOSTS_STEP_ID]]);
        expect(t.io.content()).toContain('127.0.0.1 c.gen');
    });

    it('a change with the SAME configured names (a site started or stopped) does nothing — zero reads, zero writes, zero prompts', async () => {
        const t = setup('127.0.0.1 localhost\n', { denyPlain: true });
        t.setNames(['docs.gen', 'tynn.gen']);
        t.sync.begin();
        t.clock.fire();
        await settle();
        const before = { calls: t.io.calls.length, batches: t.prompt.batches.length };
        expect(before.batches).toBe(1);
        // Ten starts and stops: the same set, in either order.
        for (let i = 0; i < 10; i++) { t.setNames(i % 2 ? ['tynn.gen', 'docs.gen'] : ['docs.gen', 'tynn.gen']); t.sync.changed(); }
        expect(t.clock.live()).toBe(0);
        t.clock.fire();
        await settle();
        expect(t.io.calls.length).toBe(before.calls);
        expect(t.prompt.batches.length).toBe(1);
        // Positive control in the same run: a NEW name is one write, through one prompt.
        t.setNames(['docs.gen', 'tynn.gen', 'shop.gen']);
        t.sync.changed();
        t.clock.fire();
        await settle();
        expect(t.prompt.batches).toEqual([[HOSTS_STEP_ID], [HOSTS_STEP_ID]]);
        expect(t.io.content()).toContain('::1 shop.gen');
    });

    it('a burst of N changes is ONE write', async () => {
        const t = setup('127.0.0.1 localhost\n', { denyPlain: true });
        t.sync.begin();
        t.clock.fire();
        await settle();
        expect(t.io.writes()).toBe(0); // no names, no block: nothing to write at boot
        const names: string[] = [];
        for (const n of ['a', 'b', 'c', 'd', 'e', 'f']) { names.push(`${n}.gen`); t.setNames([...names]); t.sync.changed(); }
        expect(t.clock.live()).toBe(1);
        t.clock.fire();
        await settle();
        expect(t.io.calls.filter((c) => c === 'stage')).toHaveLength(1);
        expect(t.prompt.batches).toEqual([[HOSTS_STEP_ID]]);
        for (const n of names) expect(t.io.content()).toContain(`127.0.0.1 ${n}`);
    });

    it('syncs run one at a time — two never hold a prompt open together, and the second finds the work done', async () => {
        const t = setup('127.0.0.1 localhost\n', { denyPlain: true });
        let release!: () => void;
        t.prompt.state.gate = new Promise<void>((r) => { release = r; });
        t.setNames(['tynn.gen']);
        const a = t.sync.flush();
        const b = t.sync.flush();
        await settle();
        expect(t.prompt.batches).toHaveLength(1);
        release();
        expect(await a).toEqual({ changed: true, elevated: true });
        expect(await b).toEqual({ changed: false, elevated: false });
        expect(t.prompt.mostOpen()).toBe(1);
        expect(t.prompt.batches).toHaveLength(1);
    });

    it('a declined prompt is not retried by a change of the same names (no prompt loop); the person’s Try again (flush) asks again', async () => {
        const t = setup('127.0.0.1 localhost\n', { denyPlain: true });
        t.prompt.state.declined = true;
        t.setNames(['tynn.gen']);
        t.sync.begin();
        t.clock.fire();
        await settle();
        expect(t.results.at(-1)).toMatchObject({ error: 'Request dismissed' });
        t.sync.changed();
        t.sync.changed();
        expect(t.clock.live()).toBe(0);
        expect(t.prompt.batches).toHaveLength(1);
        t.prompt.state.declined = false;
        expect(await t.sync.flush()).toEqual({ changed: true, elevated: true });
        expect(t.prompt.batches).toHaveLength(2);
    });
});

describe('a Trust carries a due hosts write in its ONE prompt', () => {
    const trust: PrivilegedStep = { id: 'trust', label: 'install Genie’s certificate into the trust store', step: { command: 'certutil', args: ['-addstore', '-f', 'Root', 'C:\\Users\\user\\.genie\\runtime\\gen-ca\\ca.crt'] } };
    const trustWith = (t: ReturnType<typeof setup>) => t.sync.joinElevation(async (hostsSteps) => {
        const steps = [trust, ...hostsSteps];
        return { outcome: await t.prompt.elevator.run(steps), steps };
    });

    it('due (a new name, the plain write refused) → exactly ONE elevation carrying both steps, trust first', async () => {
        const t = setup('127.0.0.1 localhost\n', { denyPlain: true });
        t.setNames(['docs.gen']);
        t.sync.begin(); // the debounce is pending — the Trust takes it now
        expect(await trustWith(t)).toEqual({ ok: true });
        expect(t.prompt.batches).toEqual([['trust', HOSTS_STEP_ID]]);
        expect(t.sync.result).toEqual({ changed: true, elevated: true });
        expect(t.io.content()).toContain('127.0.0.1 docs.gen');
        // The debounce it absorbed raises nothing afterwards.
        t.clock.fire();
        await settle();
        expect(t.prompt.batches).toHaveLength(1);
    });

    it('nothing due → the Trust’s batch is the trust step alone, and the hosts file is not even read', async () => {
        const t = setup('127.0.0.1 localhost\n', { denyPlain: true });
        t.setNames(['docs.gen']);
        await t.sync.flush();
        const reads = t.io.calls.filter((c) => c === 'read').length;
        expect(await trustWith(t)).toEqual({ ok: true });
        expect(t.prompt.batches.at(-1)).toEqual(['trust']);
        expect(t.io.calls.filter((c) => c === 'read')).toHaveLength(reads);
    });

    it('a failed step is reported BY NAME: the trust step failing leaves the hosts write "not done", named', async () => {
        const t = setup('127.0.0.1 localhost\n', { denyPlain: true });
        t.setNames(['docs.gen']);
        t.prompt.state.failStep = 'trust';
        const outcome = await trustWith(t);
        expect(outcome).toEqual({ ok: false, failed: { id: 'trust', label: 'install Genie’s certificate into the trust store' }, error: 'install Genie’s certificate into the trust store failed' });
        expect(t.sync.result).toMatchObject({ changed: false, error: 'not done: install Genie’s certificate into the trust store failed first in the same prompt (install Genie’s certificate into the trust store failed)' });
        expect(t.io.content()).toBe('127.0.0.1 localhost\n');
    });

    it('…and the hosts step failing is the hosts file’s error, with the block to paste', async () => {
        const t = setup('127.0.0.1 localhost\n', { denyPlain: true });
        t.setNames(['docs.gen']);
        t.prompt.state.failStep = HOSTS_STEP_ID;
        await trustWith(t);
        expect(t.sync.result).toEqual({ changed: false, elevated: false, error: 'update the hosts file failed', manualBlock: hostsFileBlock(['docs.gen']) });
    });

    it('a hosts sync declined earlier is due again when the person trusts — one prompt fixes both', async () => {
        const t = setup('127.0.0.1 localhost\n', { denyPlain: true });
        t.setNames(['docs.gen']);
        t.prompt.state.declined = true;
        await t.sync.flush();
        t.prompt.state.declined = false;
        await trustWith(t);
        expect(t.prompt.batches).toEqual([[HOSTS_STEP_ID], ['trust', HOSTS_STEP_ID]]);
        expect(t.sync.result).toEqual({ changed: true, elevated: true });
    });
});

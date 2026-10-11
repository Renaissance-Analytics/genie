import { describe, expect, it } from 'vitest';
import { fancyTermPort, type HostBackend } from '../src/main/fancy-term-port.js';

/**
 * THE ADAPTER between Genie's narrow `PtyPort` and `fancy-term-host`'s `PtyBackend`.
 *
 * The backend is injected here, so this proves the MAPPING — ids, commands, events, the
 * `false` answers — without a pty. Whether a real shell actually starts and echoes is
 * `npm run verify:terminal`, which runs in the test VM against the real engine. A fake can
 * prove the plumbing and can never prove that node-pty loads.
 */

function fakeBackend() {
    const created: Array<Record<string, unknown>> = [];
    const written: Array<{ id: string; data: string }> = [];
    const resized: Array<{ id: string; cols: number; rows: number }> = [];
    const killed: string[] = [];
    const live = new Set<string>();
    const listeners: Record<string, Array<(...a: unknown[]) => void>> = { data: [], exit: [], cwd: [] };

    const backend: HostBackend = {
        create: (opts) => {
            created.push(opts as unknown as Record<string, unknown>);
            live.add(opts.id);
            return { id: opts.id, pid: 5000 + created.length, shell: opts.shell ?? '/bin/sh', existing: false, scrollback: '' };
        },
        write: (id, data) => { if (!live.has(id)) return false; written.push({ id, data }); return true; },
        resize: (id, cols, rows) => { if (!live.has(id)) return false; resized.push({ id, cols, rows }); return true; },
        kill: (id) => { if (!live.has(id)) return false; killed.push(id); live.delete(id); return true; },
        getScrollback: (id) => (live.has(id) ? `scrollback:${id}` : undefined),
        on: ((event: string, listener: (...a: unknown[]) => void) => {
            listeners[event]?.push(listener);
            return backend;
        }) as HostBackend['on'],
    };

    return {
        backend,
        created,
        written,
        resized,
        killed,
        emitData: (id: string, data: string) => listeners['data']?.forEach((l) => l(id, data)),
        emitExit: (id: string, exitCode: number) => listeners['exit']?.forEach((l) => l(id, { exitCode })),
    };
}

describe('opening', () => {
    it('mints an id the engine can key on, and returns what the engine reported', () => {
        const f = fakeBackend();
        const port = fancyTermPort(f.backend, { defaultShell: () => ({ command: '/bin/bash', args: ['-l'] }) });

        const opened = port.open({ cwd: '/repo' });

        // `fancy-term-host` keys the pty on a caller-chosen id ("stable id chosen by the
        // renderer"); the port chooses it so the host never has to.
        expect(opened.id).toMatch(/^term_[0-9a-f-]{8,}$/);
        expect(f.created[0]).toMatchObject({ id: opened.id, cwd: '/repo' });
        expect(opened.pid).toBe(5001);
    });

    it('runs the user’s DEFAULT shell when no command is given', () => {
        /**
         * `+terminal` names no command, and the engine already knows how to find the login
         * shell per platform. Inventing one here is how a build spawns `/bin/sh` for somebody
         * whose shell is fish — so the resolver is the engine's, injected for the test.
         */
        const f = fakeBackend();
        const port = fancyTermPort(f.backend, { defaultShell: () => ({ command: '/usr/bin/fish', args: ['-l'] }) });

        port.open({ cwd: '/repo' });

        expect(f.created[0]).toMatchObject({ shell: '/usr/bin/fish', args: ['-l'] });
    });

    it('parses a COMMAND into the shell and its args', () => {
        const f = fakeBackend();
        const port = fancyTermPort(f.backend, { defaultShell: () => ({ command: '/bin/sh', args: [] }) });

        port.open({ cwd: '/repo', command: 'npm test --filter=Challenge' });

        expect(f.created[0]).toMatchObject({ shell: 'npm', args: ['test', '--filter=Challenge'] });
    });

    it('passes the initial size through', () => {
        const f = fakeBackend();
        const port = fancyTermPort(f.backend, { defaultShell: () => ({ command: '/bin/sh', args: [] }) });

        port.open({ cwd: '/repo', cols: 120, rows: 30 });

        expect(f.created[0]).toMatchObject({ cols: 120, rows: 30 });
    });

    it('gives every terminal its own id', () => {
        // COUNTED: two opens, two distinct ids. A port that reused an id would make the second
        // terminal "join" the first — the engine's `existing: true` path — silently.
        const f = fakeBackend();
        const port = fancyTermPort(f.backend, { defaultShell: () => ({ command: '/bin/sh', args: [] }) });

        const ids = [port.open({ cwd: '/a' }).id, port.open({ cwd: '/b' }).id];

        expect(new Set(ids).size).toBe(2);
    });
});

describe('using', () => {
    it('writes, resizes, reads scrollback and kills through the engine', () => {
        const f = fakeBackend();
        const port = fancyTermPort(f.backend, { defaultShell: () => ({ command: '/bin/sh', args: [] }) });
        const { id } = port.open({ cwd: '/repo' });

        expect(port.write(id, 'ls\r')).toBe(true);
        expect(port.resize(id, 100, 40)).toBe(true);
        expect(port.scrollback(id)).toBe(`scrollback:${id}`);
        expect(port.kill(id)).toBe(true);

        expect(f.written).toEqual([{ id, data: 'ls\r' }]);
        expect(f.resized).toEqual([{ id, cols: 100, rows: 40 }]);
        expect(f.killed).toEqual([id]);
    });

    it('answers false for an id the engine does not have, rather than throwing', () => {
        const f = fakeBackend();
        const port = fancyTermPort(f.backend, { defaultShell: () => ({ command: '/bin/sh', args: [] }) });

        expect(port.write('term_nope', 'x')).toBe(false);
        expect(port.resize('term_nope', 1, 1)).toBe(false);
        expect(port.kill('term_nope')).toBe(false);
        expect(port.scrollback('term_nope')).toBeUndefined();
    });
});

describe('events', () => {
    it('forwards output with the terminal id', () => {
        const f = fakeBackend();
        const port = fancyTermPort(f.backend, { defaultShell: () => ({ command: '/bin/sh', args: [] }) });
        const seen: Array<[string, string]> = [];
        port.onData((id, data) => seen.push([id, data]));

        f.emitData('term_1', 'hello');

        expect(seen).toEqual([['term_1', 'hello']]);
    });

    it('forwards exit as a plain exit code', () => {
        // The engine reports `{ exitCode, signal? }`; Genie's port wants the code. Flattening
        // here keeps the host ignorant of the engine's payload shape.
        const f = fakeBackend();
        const port = fancyTermPort(f.backend, { defaultShell: () => ({ command: '/bin/sh', args: [] }) });
        const seen: Array<[string, number]> = [];
        port.onExit((id, code) => seen.push([id, code]));

        f.emitExit('term_1', 3);

        expect(seen).toEqual([['term_1', 3]]);
    });

    it('stops forwarding after unsubscribe', () => {
        const f = fakeBackend();
        const port = fancyTermPort(f.backend, { defaultShell: () => ({ command: '/bin/sh', args: [] }) });
        const seen: string[] = [];
        const stop = port.onData((_id, data) => seen.push(data));

        f.emitData('term_1', 'one');
        stop();
        f.emitData('term_1', 'two');

        expect(seen).toEqual(['one']);
    });
});

describe('a spawn the engine could not make', () => {
    /**
     * Measured on the INSTALLED app in the Windows VM, 2026-10-10 21:5x (fancy-term-host
     * 0.10.0-rc.1): the engine answered `pid: -1` for a terminal it had not started — the
     * helper could not be executed from inside app.asar — and the port passed that back as if
     * a terminal had opened. The renderer mounted a pane; the driver read `pid -1` with no
     * error anywhere. §5: a terminal that did not open must not look like one that did.
     */
    it('THROWS, naming the shell, when the engine reports no pid — and drops the engine entry', () => {
        const { backend } = fakeBackend();
        backend.create = (opts) => ({ id: opts.id, pid: -1, shell: opts.shell ?? '/bin/sh', existing: false, scrollback: '' });
        // The fixture's kill only records ids its own create registered; this create is overridden,
        // so observe the kill CALL itself — the claim is "the port told the engine to drop the id".
        const dropped: string[] = [];
        backend.kill = (id) => { dropped.push(id); return true; };
        const port = fancyTermPort(backend, { defaultShell: () => ({ command: '/bin/zsh', args: [] }) });
        expect(() => port.open({ cwd: '/tmp' })).toThrow(/could not spawn/);
        expect(() => port.open({ cwd: '/tmp' })).toThrow(/\/bin\/zsh/);
        // The engine was told to forget the id it handed out, so nothing half-open lingers.
        expect(dropped).toHaveLength(2);
        expect(dropped[0]).toMatch(/^term_/);
    });

    it('POSITIVE CONTROL: a real pid opens as before', () => {
        const { backend } = fakeBackend();
        const port = fancyTermPort(backend, { defaultShell: () => ({ command: '/bin/zsh', args: [] }) });
        const opened = port.open({ cwd: '/tmp' });
        expect(opened.pid).toBeGreaterThan(0);
    });
});

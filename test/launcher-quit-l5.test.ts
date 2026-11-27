import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LineTransport } from '../src/core/line-transport.js';
import { quitThroughLauncher, type LauncherCaller } from '../src/core/quit.js';
import { attachLauncher, type LauncherWire } from '../src/main/launcher-control.js';

/*
 * THE TRAY, LOGON AND QUIT IN THE LAUNCHER (Tynn #1058 L5). The launcher owns the tray and the logon entry; the client's
 * own tray and close-to-tray go. The quit's two answers are the launcher's to carry out: "Just close the UI" ends the client
 * processes only, "Shut down everything" stops the host gracefully (waited for on its own progress, Tynn #1079), then the
 * launcher exits.
 */
function caller(answers: Record<string, { ok: true; value: unknown } | { ok: false; reason: string; code?: string }>) {
    const calls: string[] = [];
    const call: LauncherCaller = async (method) => {
        calls.push(method);
        return answers[method] ?? { ok: false, reason: `${method} is not something this launcher does`, code: 'unsupported' };
    };
    return { call, calls };
}

describe('the quit answers go to the launcher', () => {
    it('Shut down everything is launcher.shutDown: this window never ends the host itself (no 5 s kill, Tynn #1079)', async () => {
        const { call, calls } = caller({ 'launcher.shutDown': { ok: true, value: { accepted: true } } });
        let windowShutDowns = 0;
        await expect(quitThroughLauncher('shut-down', { call, windowShutDown: async () => { windowShutDowns += 1; } })).resolves.toEqual({ by: 'launcher' });
        expect(calls).toEqual(['launcher.shutDown']);
        expect(windowShutDowns).toBe(0);
    });

    it('Just close the UI is launcher.closeUi: the host is not touched', async () => {
        const { call, calls } = caller({ 'launcher.closeUi': { ok: true, value: { closed: 1 } } });
        let windowShutDowns = 0;
        await expect(quitThroughLauncher('close-ui', { call, windowShutDown: async () => { windowShutDowns += 1; } })).resolves.toEqual({ by: 'launcher' });
        expect(calls).toEqual(['launcher.closeUi']);
        expect(windowShutDowns).toBe(0);
    });

    it('with no launcher at all (a development run) the window shuts down as it did; Just close the UI only closes it', async () => {
        const none = { ok: false as const, reason: 'Genie’s launcher is not running.', code: 'no-launcher' };
        const a = caller({ 'launcher.shutDown': none, 'launcher.closeUi': none });
        let windowShutDowns = 0;
        await expect(quitThroughLauncher('shut-down', { call: a.call, windowShutDown: async () => { windowShutDowns += 1; } })).resolves.toEqual({ by: 'window' });
        expect(windowShutDowns).toBe(1);
        await expect(quitThroughLauncher('close-ui', { call: a.call, windowShutDown: async () => { windowShutDowns += 1; } })).resolves.toEqual({ by: 'window' });
        expect(windowShutDowns).toBe(1);
    });

    it('a launcher that is there but fails says why, and the window does not fall back to ending the host', async () => {
        const { call } = caller({ 'launcher.shutDown': { ok: false, reason: 'The host refused to stop: busy' } });
        let windowShutDowns = 0;
        await expect(quitThroughLauncher('shut-down', { call, windowShutDown: async () => { windowShutDowns += 1; } })).resolves.toEqual({ by: 'failed', reason: 'The host refused to stop: busy' });
        expect(windowShutDowns).toBe(0);
    });
});

describe('a client attached to its launcher', () => {
    const runtime = join('home', '.genie', 'runtime');
    const files = (file: string): string | null => {
        const name = file.split(/[\\/]/).pop()!;
        return name === 'launcher.json' ? JSON.stringify({ pid: 4242, endpoint: '/run/launcher.sock', build: '2026.11.26-1', schema: '2026.11.25' }) : name === 'launcher.token' ? 'tok' : null;
    };

    it('holds one link open (launcher.attach with its pid) and closes its UI when the launcher says launcher.closeUi', async () => {
        const sent: Record<string, unknown>[] = [];
        let listener: ((text: string) => void) | null = null;
        let closed = false;
        const transport: LineTransport = {
            send: (text) => {
                const f = JSON.parse(text) as Record<string, unknown>;
                sent.push(f);
                const reply = f.kind === 'hello' ? { kind: 'welcome', track: 'launcher' } : f.kind === 'call' ? { kind: 'result', id: f.id, ok: true, value: { attached: true } } : null;
                if (reply) queueMicrotask(() => listener?.(JSON.stringify(reply)));
            },
            onMessage: (l) => { listener = l; return () => { listener = null; }; },
            onClose: () => () => {},
            close: () => { closed = true; },
            trusted: () => {},
        };
        const wire: LauncherWire = { runtimeDir: runtime, track: 'client', readFile: files, alive: () => true, connectTo: async () => transport };
        let closeUi = 0;
        const attached = await attachLauncher(wire, { pid: 31337, onCloseUi: () => { closeUi += 1; } });
        expect(attached).not.toBeNull();
        expect(sent[1]).toMatchObject({ kind: 'call', method: 'launcher.attach', args: [{ pid: 31337 }] });
        expect(closed).toBe(false);
        listener!(JSON.stringify({ kind: 'event', name: 'launcher.closeUi' }));
        expect(closeUi).toBe(1);
        attached!.close();
        expect(closed).toBe(true);
    });

    it('with no launcher it attaches to nothing and dials nothing', async () => {
        let dialled = 0;
        const wire: LauncherWire = { runtimeDir: runtime, track: 'client', readFile: () => null, alive: () => true, connectTo: async () => { dialled += 1; throw new Error('never'); } };
        await expect(attachLauncher(wire, { pid: 1, onCloseUi: () => {} })).resolves.toBeNull();
        expect(dialled).toBe(0);
    });
});

describe('the client has no tray of its own', () => {
    const main = readFileSync(join(__dirname, '..', 'src', 'main', 'main.ts'), 'utf8');

    it('creates no tray and hides no window to one: the launcher owns the tray', () => {
        expect(main).not.toMatch(/\bcreateTray\(/);
        expect(main).not.toMatch(/new Tray\(/);
        expect(main).not.toMatch(/\bwireCloseToTray\(/);
    });

    it('closing the last window ends the client process (not a quit: nothing of the host is stopped)', () => {
        const handler = main.slice(main.indexOf("app.on('window-all-closed'"));
        expect(handler.slice(0, handler.indexOf('\n'))).not.toContain('stays in the tray');
        expect(main).toMatch(/app\.on\('window-all-closed', \(\) => \{ endClientOnLastWindow\(/);
    });

    it('its quit goes through the launcher, and it attaches to the launcher as it starts', () => {
        expect(main).toMatch(/\bquitThroughLauncher\(/);
        expect(main).toMatch(/\battachLauncher\(/);
    });

    it('says the logon settings to the launcher, which writes the entry: the client writes none', () => {
        expect(main).not.toMatch(/\bwireLoginItem\(/);
        expect(main).toMatch(/'launcher\.logon'/);
    });
});

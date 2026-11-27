import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { installQuit, leaveForInstall, quitSequence, runQuit, type QuitPorts, type QuitStep } from '../src/core/quit.js';
import type { UpdateScope } from '../src/core/update-kind.js';
import type { UpdateState } from '../src/main/updater.js';
import { UpdatesReplica } from '../src/main/updates-replica.js';

/*
 * HOST SPLIT P6-1 (Tynn #1036, task #1498): ON A CLIENT-ONLY INSTALL THE WINDOW LEAVES, AND LEAVES GENIE-HOST RUNNING.
 * Measured on Windows (Azure runs 1123-182546-6c95d0 and 1123-182557-b1baec): a real client-only update kept nothing.
 * genie-host's own log, a second after "updater: it has the install; only the window is updated, so this host stays":
 * "shutting down: a window asked", and that was before the installer ran. When the host answers an install, the window
 * quit with "Shut down everything" whatever the update changed (main.ts replica.onInstalling → quit.choose('shut-down') →
 * runQuit: every agent stopped, then engine.shutdown). On a client-only install the window process exits, because the
 * installer replaces its files, but it stops no agent and does not end the host. A full install shuts down as before.
 */

const CLIENT_ONLY: UpdateScope = { kind: 'client-only' };
const FULL: UpdateScope = { kind: 'full', why: 'it carries another host (bbbbbbbbbbbb, running aaaaaaaaaaaa)' };

function ports() {
    const calls: string[] = [];
    const p: QuitPorts = {
        stopAgents: () => { calls.push('stopAll'); },
        closeWindow: () => { calls.push('window'); },
        drained: async () => { calls.push('drained'); },
        shutDownHost: async () => { calls.push('engine.shutdown'); },
    };
    return { calls, p };
}

const installing = (scope: UpdateScope | undefined): UpdateState => ({
    phase: 'installing', version: '2.0.1', percent: 100, error: null, checkedAt: 1,
    installing: { step: 'restarting', agents: 0, left: 0 },
    ...(scope ? { scope } : {}),
});

/**
 * The window's install quit, step for step as main.ts runs it: the replica says the host is installing, with the
 * update's scope; the window chooses how it quits; `app.quit()` reaches before-quit, which runs the step it is given.
 */
async function windowQuitsForInstall(scope: UpdateScope | undefined) {
    const replica = new UpdatesReplica(async () => null, 4000);
    const seq = quitSequence();
    const told: Array<UpdateScope | undefined> = [];
    replica.onInstalling((s) => { told.push(s); seq.markRecorded(); seq.choose(installQuit(s, false)); });
    replica.rebase(installing(scope));
    const { calls, p } = ports();
    const steps: QuitStep[] = [];
    const step = seq.beforeQuit({ ready: true, plan: () => ({ confirm: false }), ask: () => 'cancel' });
    steps.push(step);
    if (step === 'exit-window') leaveForInstall(p);
    else if (step === 'shut-down') await runQuit(p);
    steps.push(seq.beforeQuit({ ready: true, plan: () => ({ confirm: false }), ask: () => 'cancel' }));
    return { told, calls, steps, quitting: seq.quitting };
}

describe('the window’s quit for an install the host runs', () => {
    it('a CLIENT-ONLY install: the window exits, stopping no agent and never sending engine.shutdown', async () => {
        const got = await windowQuitsForInstall(CLIENT_ONLY);
        expect(got.told).toEqual([CLIENT_ONLY]);
        expect(got.steps).toEqual(['exit-window', 'pass']);
        expect(got.calls).toEqual(['window']);
        expect(got.calls).not.toContain('stopAll');
        expect(got.calls).not.toContain('engine.shutdown');
        // A real exit (the installer replaces this window's files): the main window's close is a close, not a hide.
        expect(got.quitting).toBe(true);
    });

    it('a FULL install: shut down as before, every agent stopped and then engine.shutdown', async () => {
        const got = await windowQuitsForInstall(FULL);
        expect(got.told).toEqual([FULL]);
        expect(got.steps).toEqual(['shut-down', 'pass']);
        expect(got.calls).toEqual(['stopAll', 'window', 'drained', 'engine.shutdown']);
    });

    it('an install whose scope the window was never told (an older host): a full shut-down, the safe answer', async () => {
        const got = await windowQuitsForInstall(undefined);
        expect(got.told).toEqual([undefined]);
        expect(got.calls).toEqual(['stopAll', 'window', 'drained', 'engine.shutdown']);
    });
});

describe('installQuit: how the window quits for the install, by what the update changes', () => {
    it('client-only → exit the window; full or unknown → shut down', () => {
        expect(installQuit(CLIENT_ONLY, false)).toBe('exit-window');
        expect(installQuit(FULL, false)).toBe('shut-down');
        expect(installQuit(undefined, false)).toBe('shut-down');
    });
});

describe('quitSequence: exiting the window for an install', () => {
    it('is chosen up front, asks nothing, records nothing, runs once', () => {
        const seq = quitSequence();
        seq.markRecorded();
        seq.choose('exit-window');
        let asked = 0;
        const at = () => seq.beforeQuit({ ready: true, plan: () => ({ confirm: true, defaultChoice: 'cancel', title: 'Quit Genie?', message: '1 agent is running (kit).', buttons: ['Cancel', 'Quit'] }), ask: () => { asked += 1; return 'cancel'; } });
        expect(at()).toBe('exit-window');
        expect(at()).toBe('pass');
        expect(asked).toBe(0);
    });

    it('the OS ending the session still shuts everything down', () => {
        const seq = quitSequence();
        seq.force();
        seq.choose('exit-window');
        expect(seq.beforeQuit({ ready: true, plan: () => ({ confirm: false }), ask: () => 'cancel' })).toBe('record');
        expect(seq.beforeQuit({ ready: true, plan: () => ({ confirm: false }), ask: () => 'cancel' })).toBe('shut-down');
    });
});

describe('UpdatesReplica: the window is told the scope of the install, from the host’s state', () => {
    it('the install answered through this window: the state’s scope', async () => {
        const state: UpdateState = { phase: 'downloaded', version: '2.0.1', percent: 100, error: null, checkedAt: 1, scope: CLIENT_ONLY };
        const replica = new UpdatesReplica(async (method) => { if (method === 'install') { replica.rebase({ ...state, phase: 'installing', installing: { step: 'processes', agents: 0, left: 0 } }); return { killed: [], report: '' }; } return null; }, 4000);
        replica.rebase(state);
        const told: Array<UpdateScope | undefined> = [];
        replica.onInstalling((s) => { told.push(s); });
        await replica.install();
        expect(told).toEqual([CLIENT_ONLY]);
    });
});

/** Source guards, comments stripped by line (CRLF-safe), so prose cannot satisfy them. */
const strip = (file: string) => readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');
const block = (src: string, start: string, end: string) => { const i = src.indexOf(start); expect(i, start).toBeGreaterThan(-1); const j = src.indexOf(end, i); expect(j).toBeGreaterThan(i); return src.slice(i, j); };

describe('wired: main.ts quits for an install by its scope', () => {
    const main = () => strip('src/main/main.ts');

    it('the install’s quit is chosen from the scope the replica names, never shut-down outright', () => {
        const on = block(main(), 'replica.onInstalling(', '\n        });');
        expect(on).toMatch(/replica\.onInstalling\(\(scope\) => \{/);
        expect(on).toMatch(/const how = installQuit\(scope\);/);
        expect(on).toMatch(/quit\.choose\(how\);/);
        expect(on).not.toMatch(/quit\.choose\('shut-down'\)/);
    });

    it('before-quit runs the exit step: the window’s own work closed, its clean end said to the host, no runQuit', () => {
        const quit = block(main(), "app.on('before-quit'", '\n});');
        const exit = block(quit, "if (step === 'exit-window') {", '}\n');
        expect(exit).toMatch(/leaveForInstall\(quitPorts\);/);
        // The host is told this window left cleanly (no crash to answer), and the quit proceeds.
        expect(exit).toMatch(/crashRecorder\.cleanQuit\(\);/);
        expect(exit).toMatch(/heartbeatNow\?\.bye\(\);/);
        expect(exit).toMatch(/return;/);
        expect(exit).not.toMatch(/runQuit|stopAll|shutDownHost|preventDefault/);
        // Before the record step and the shutdown pass: an exit never reaches either.
        expect(quit.indexOf("if (step === 'exit-window')")).toBeLessThan(quit.indexOf("if (step === 'record')"));
    });
});

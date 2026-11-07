import { describe, expect, it } from 'vitest';
import { tableWithin, terminalBusy, trayConfirm, trayConfirmed, type Stopping } from '../src/core/tray-confirm.js';

/**
 * THE TRAY ALWAYS ASKS (the owner, 2026-11-02: "Always ask"). Restart and Shut down everything, chosen from the tray,
 * confirm first, every time: the question lists what will stop — the running agents by name, the open terminals by name
 * (marking any with a command running: a shell mid-command is lost), the kept processes, the services and the sites. Cancel
 * is the default; the confirm button names the action. With nothing running it still asks, briefly. Never asked (elsewhere):
 * the OS ending the session, the upgrade, and the quit dialog's own "Shut down everything" (answered already).
 */

const none: Stopping = { agents: [], terminals: [], processes: [], services: [], sites: [], flows: [], scheduled: [] };
const busy: Stopping = {
    agents: ['atlas', 'bolt'],
    terminals: [{ name: 'tynn · terminal 1', busy: true }, { name: 'tynn · terminal 2', busy: false }],
    processes: ['queue:work'],
    services: ['postgres 17'],
    sites: ['moic.gen'],
    flows: [],
    scheduled: [],
};

describe('trayConfirm', () => {
    it('Shut down everything: lists what stops, Cancel by default, the confirm button names the action', () => {
        expect(trayConfirm('shut-down', busy)).toEqual({
            title: 'Shut down everything?',
            message: 'This stops:\n• 2 agents: atlas, bolt\n• 2 terminals: tynn · terminal 1 (running a command), tynn · terminal 2\n• 1 kept process: queue:work\n• 1 service: postgres 17\n• 1 site: moic.gen',
            buttons: ['Cancel', 'Shut down everything'],
            defaultId: 0,
            cancelId: 0,
        });
    });

    it('names the flows and scheduled tasks that stop firing: the tray stays for them, so it says so', () => {
        expect(trayConfirm('shut-down', { ...none, flows: ['nightly triage'], scheduled: ['backup', 'digest'] }).message).toBe('This stops:\n• 1 armed flow: nightly triage\n• 2 scheduled tasks: backup, digest');
    });

    it('Restart: the same list, and what comes back — the agents do, terminals do not', () => {
        const q = trayConfirm('restart', { ...none, agents: ['atlas'], terminals: [{ name: 'tynn · terminal 1', busy: true }] });
        expect(q.title).toBe('Restart Genie?');
        expect(q.buttons).toEqual(['Cancel', 'Restart']);
        expect(q.defaultId).toBe(0);
        expect(q.cancelId).toBe(0);
        expect(q.message).toBe('This stops:\n• 1 agent: atlas\n• 1 terminal: tynn · terminal 1 (running a command)\nThen Genie starts again: the agents that were running come back; terminals do not.');
    });

    it('with NOTHING running it still asks — briefly ("always" means always)', () => {
        expect(trayConfirm('shut-down', none)).toMatchObject({ title: 'Shut down Genie?', message: 'Nothing is running. Shut down Genie?', buttons: ['Cancel', 'Shut down everything'], defaultId: 0 });
        expect(trayConfirm('restart', none)).toMatchObject({ title: 'Restart Genie?', message: 'Nothing is running. Restart Genie?', buttons: ['Cancel', 'Restart'], defaultId: 0 });
    });
});

describe('trayConfirmed', () => {
    it('only the confirm button goes on; Cancel, Esc and a closed dialog do nothing', () => {
        expect([0, 1, -1, 2].map(trayConfirmed)).toEqual([false, true, false, false]);
    });
});

describe('terminalBusy (a command running in it)', () => {
    const p = (pid: number, ppid: number, name: string) => ({ pid, ppid, name });
    it('a pty helper’s shell with a child of its own: busy; the shell alone at its prompt: not', () => {
        expect(terminalBusy(10, [p(10, 1, 'fancy-pty-helper'), p(11, 10, 'bash'), p(12, 11, 'npm')])).toBe(true);
        expect(terminalBusy(10, [p(10, 1, 'fancy-pty-helper'), p(11, 10, 'bash')])).toBe(false);
    });

    it('a terminal whose pid is the shell itself: any child is a command', () => {
        expect(terminalBusy(20, [p(20, 1, 'bash'), p(21, 20, 'vim')])).toBe(true);
        expect(terminalBusy(20, [p(20, 1, 'bash')])).toBe(false);
    });

    it('a console host beside the shell (Windows ConPTY) is not a command', () => {
        expect(terminalBusy(30, [p(30, 1, 'fancy-pty-helper.exe'), p(31, 30, 'OpenConsole.exe'), p(32, 30, 'pwsh.exe')])).toBe(false);
        expect(terminalBusy(30, [p(30, 1, 'fancy-pty-helper.exe'), p(31, 30, 'conhost.exe'), p(32, 30, 'pwsh.exe'), p(33, 32, 'node.exe')])).toBe(true);
    });

    it('nothing known about the process table: not marked (never guessed busy)', () => {
        expect(terminalBusy(40, null)).toBe(false);
    });
});

/**
 * THE QUESTION COMES AT ONCE (genie-test-windows, ss-repeat5, 2026-11-05): the tray read the process table SYNCHRONOUSLY on
 * the window's main thread to mark busy terminals, and on that machine the read took 30 s; the window froze, and the
 * question came 30 s after the click. The table is now read off main, and only for as long as the question can wait:
 * past the bound the question is asked without the marks.
 */
describe('tableWithin: the busy marks never hold the question', () => {
    it('a table that never comes is null once the bound is over', async () => {
        const started = Date.now();
        expect(await tableWithin(() => new Promise(() => {}), 50)).toBeNull();
        expect(Date.now() - started).toBeLessThan(1_000);
    });

    it('a table that fails is null', async () => {
        expect(await tableWithin(() => Promise.reject(new Error('no table')), 50)).toBeNull();
    });

    it('positive control: a table read in time is the table', async () => {
        const table = [{ pid: 1, ppid: 0, name: 'bash' }];
        expect(await tableWithin(async () => table, 1_000)).toBe(table);
    });
});

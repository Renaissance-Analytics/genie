import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { logonEntry } from '../src/core/logon.js';
import { loginItemPlan } from '../src/core/tray-resident.js';
import { LeftRunningMark } from '../src/main/left-running.js';

/**
 * LOGON (the host split, P6; decision 5 and O4). A host the person left running comes back at logon. With the "start on
 * logon" setting on it also starts after "Shut down everything"; with it off, a full shutdown stays down until Genie is
 * opened. The entry at the OS is the decision: there at logon means it starts.
 */

const WIN = { platform: 'win32' as const, packaged: true, execPath: 'C:\\P\\Genie.exe', appImage: null, configHome: '/unused' };

describe('the logon table', () => {
    it.each([
        ['left running, setting on', true, true, true],
        ['left running, setting off', true, false, true],
        ['shut down, setting on', false, true, true],
        ['shut down, setting off', false, false, false],
    ])('%s', (_name, leftRunning, setting, starts) => {
        expect(logonEntry({ leftRunning, setting, startMinimized: false }).launchAtLogin).toBe(starts);
    });

    it('a host left running comes back with no window, whatever start minimised says: the person had closed the UI', () => {
        expect(logonEntry({ leftRunning: true, setting: false, startMinimized: false }).startMinimized).toBe(true);
        expect(logonEntry({ leftRunning: true, setting: true, startMinimized: false }).startMinimized).toBe(true);
    });

    it('otherwise start minimised is the person\u2019s own', () => {
        expect(logonEntry({ leftRunning: false, setting: true, startMinimized: false }).startMinimized).toBe(false);
        expect(logonEntry({ leftRunning: false, setting: true, startMinimized: true }).startMinimized).toBe(true);
    });

    it('as the OS gets it: left running with the setting off still writes the entry, hidden', () => {
        expect(loginItemPlan({ ...WIN, ...logonEntry({ leftRunning: true, setting: false, startMinimized: false }) })).toEqual({
            kind: 'login-item',
            settings: { openAtLogin: true, path: WIN.execPath, args: ['--hidden'] },
        });
    });
});

describe('LeftRunningMark', () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'left-running-')); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    it('off by default', () => {
        expect(new LeftRunningMark(dir).now()).toBe(false);
    });

    it('survives a restart: a reboot is what it is for', () => {
        new LeftRunningMark(dir).set(true);
        expect(new LeftRunningMark(dir).now()).toBe(true);
    });

    it('cleared leaves nothing behind, and a new read says off', () => {
        const mark = new LeftRunningMark(dir);
        mark.set(true);
        mark.set(false);
        expect(new LeftRunningMark(dir).now()).toBe(false);
        expect(existsSync(join(dir, 'left-running'))).toBe(false);
    });

    it('says when it changes, once, and not when set to what it was', () => {
        const mark = new LeftRunningMark(dir);
        const heard: boolean[] = [];
        mark.onChange((value) => heard.push(value));
        mark.set(true);
        mark.set(true);
        mark.set(false);
        expect(heard).toEqual([true, false]);
    });
});

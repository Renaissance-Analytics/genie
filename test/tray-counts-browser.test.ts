import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BrowserService, type BrowserEvent } from '../src/main/browser-service.js';
import { activityTotal, activityWords, trayOnlyStep, TRAY_ONLY_GRACE_MS, type HostActivity } from '../src/core/tray-only.js';

/**
 * THE GENIE BROWSER COUNTS AS RUNNING (the host split, P2b; decision 5: a site keeps its browser while the workspace window
 * is gone). The tray-only rule shuts everything down once nothing is left, and that must not take a browser somebody is using.
 */

const none: HostActivity = { agents: 0, terminals: 0, processes: 0, services: 0, armedFlows: 0, scheduledTasks: 0, browser: 0 };

describe('the tray-only rule', () => {
    it('a browser open keeps it: stay, the clock reset', () => {
        expect(trayOnlyStep({ uiOpen: false, activity: { ...none, browser: 1 } }, 0, 10 * TRAY_ONLY_GRACE_MS)).toEqual({ quietSince: null, exit: false });
    });

    it('counted and worded with the rest', () => {
        expect(activityTotal({ ...none, agents: 1, browser: 1 })).toBe(2);
        expect(activityWords({ ...none, browser: 1 })).toBe('the Genie browser');
    });

    it('CONTROL: gone, the clock runs', () => {
        expect(trayOnlyStep({ uiOpen: false, activity: none }, 0, TRAY_ONLY_GRACE_MS).exit).toBe(true);
    });
});

describe('the host says whether one is linked', () => {
    const setup = () => {
        const service = new BrowserService();
        const events: BrowserEvent[] = [];
        service.onEvent((e) => events.push(e));
        return { service, events };
    };

    it('up when it links, down when it goes', async () => {
        const { service, events } = setup();
        await service.call('register', [], 'browser');
        expect(events).toContainEqual({ kind: 'browserUp', up: true });
        service.dropped('browser');
        expect(events).toContainEqual({ kind: 'browserUp', up: false });
    });

    it('a window asking later is told', async () => {
        const { service } = setup();
        expect(await service.call('browserUp', [], 'window')).toBe(false);
        await service.call('register', [], 'browser');
        expect(await service.call('browserUp', [], 'window')).toBe(true);
    });

    it('CONTROL: a window going says nothing about it', async () => {
        const { service, events } = setup();
        await service.call('register', [], 'browser');
        const before = events.length;
        service.dropped('window');
        expect(events).toHaveLength(before);
    });
});

describe('the wires', () => {
    it('the window counts it', () => {
        const src = readFileSync('src/main/main.ts', 'utf8');
        expect(src).toMatch(/browser: browserLinked \? 1 : 0/);
        expect(src).toMatch(/event\.kind === 'browserUp'/);
    });
});

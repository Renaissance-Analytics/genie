import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { DOOR_DOWN, doorNotice } from '../src/core/browser-door.js';
import { BrowserService, type BrowserEvent, type BrowserFacts } from '../src/main/browser-service.js';
import { runBrowserLink, type BrowserLinkClient } from '../src/main/browser-process-link.js';

/*
 * THE DOOR ACTUALLY DOWN (Tynn #1046 D2, the half the browser-process row cannot reach: its harness cannot stop genie-host's
 * front door). The door is genie-host's: it is down only when that host has no front door running, and then the browser
 * says so in words that name the host, never "until Genie's window is open again". The chain, end to end in-process:
 * genie-host says no door (no hosting) -> its BrowserService answers a linking browser doorUp: false -> the browser's link
 * hands door(false) on -> the browser's notice is DOOR_DOWN.
 */
const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const DOOR = { frontDoorPort: 4443, caPem: 'CA', hosts: ['a.gen'], workspaceOf: { 'a.gen': 'ws' } };

function linkTo(service: BrowserService) {
    let listener: (event: BrowserEvent) => void = () => {};
    service.onEvent((e) => listener(e));
    const client: BrowserLinkClient = {
        browserCall: (method, args) => service.call(method, args as unknown[], 'browser'),
        onBrowserEvent: (l) => { listener = l; return () => {}; },
        close: () => {},
    };
    const ports = {
        connect: vi.fn(async () => client),
        sleep: vi.fn(async () => {}),
        facts: vi.fn((_f: BrowserFacts) => {}),
        door: vi.fn((_up: boolean) => {}),
        open: vi.fn(), quit: vi.fn(), linked: vi.fn(), log: vi.fn(),
    };
    return { link: runBrowserLink(ports), ports };
}
const notices = (calls: Array<[boolean]>) => calls.map(([up]) => doorNotice(up));

describe('the door down: the host has no front door running', () => {
    it('the notice names the host, not the window', () => {
        expect(doorNotice(false)).toBe(DOOR_DOWN);
        expect(DOOR_DOWN).toMatch(/can.t load: Genie.s host has no front door running/);
        expect(DOOR_DOWN).not.toMatch(/window/);
        expect(doorNotice(true)).toBeNull();
    });

    it('a host that says no door: a browser linking hears it down, and shows the notice', async () => {
        const { link, ports } = linkTo(new BrowserService({}));
        await link.linked;
        expect(notices(ports.door.mock.calls)).toEqual([DOOR_DOWN]);
        link.stop();
    });

    it('CONTROL: a host that says its door: up, and no notice; a window going changes neither', async () => {
        const service = new BrowserService({});
        service.door(DOOR);
        await service.call('publish', [{ launch: { file: 'g', args: [] } }], 'window');
        const { link, ports } = linkTo(service);
        await link.linked;
        service.dropped('window');
        expect(notices(ports.door.mock.calls)).toEqual([null]);
        link.stop();
    });

    it('wired: the browser process shows doorNotice for what the link hands on', () => {
        const proc = src('src/main/browser-process.ts');
        expect(proc).toMatch(/door: \(up\) => \{ if \(!locked\) windows\?\.setNotice\(doorNotice\(up\)\); \},/);
        expect(proc).not.toMatch(/until Genie.s window is open again/);
    });
});

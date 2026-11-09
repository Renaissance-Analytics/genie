import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { runBrowserLink, type BrowserLinkClient } from '../src/main/browser-process-link.js';
import { BrowserService, type BrowserEvent, type BrowserFacts } from '../src/main/browser-service.js';
import { DeviceLinkReplica } from '../src/main/device-link-replica.js';

/**
 * THE WINDOW BUILDS NO UPDATER, ISSUEWATCH, TYNN PAGE READER OR BROWSER WINDOWS OF ITS OWN (Tynn #585, host split P6,
 * forward-only). The site panels are the allowed exception: webviews in the window by design, one login per site.
 */
const code = (path: string) => readFileSync(path, 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('source', () => {
    const main = code('src/main/main.ts');

    it('no updater of its own', () => {
        expect(main).not.toMatch(/electron-updater-port/);
        expect(main).not.toMatch(/new UpdateHost\(/);
    });

    it('no IssueWatch of its own', () => {
        expect(main).not.toMatch(/issue-watch-emergency/);
        expect(existsSync('src/main/issue-watch-emergency.ts')).toBe(false);
    });

    it('no Tynn page reader of its own', () => {
        expect(main).not.toMatch(/readTynnPage\(tynnBoardPorts\(\)/);
    });

    it('no browser windows of its own: every one is the Genie browser process’s', () => {
        expect(main).not.toMatch(/genieBrowserWindows\(/);
    });

    it('THE ALLOWED EXCEPTION, and the control: the site panels stay in the window', () => {
        expect(main).toMatch(/livePanels = sitePanels\(\{/);
    });
});

const REMOTE = { key: 'relay:ws1', title: 'Studio', port: 5151, ca: 'CA', hosts: ['moic.gen'] };

describe('another workstation’s browser window goes through the host to the browser process', () => {
    it('the host hands on what to open, to the process that opens it', async () => {
        const service = new BrowserService();
        const events: BrowserEvent[] = [];
        service.onEvent((e) => events.push(e));
        await service.call('register', [], 'browser');
        await service.call('open', ['https://moic.gen/', 'user-gesture', REMOTE], 'window');
        expect(events.at(-1)).toEqual({ kind: 'open', url: 'https://moic.gen/', activation: 'user-gesture', remote: REMOTE });
    });

    it.each([
        ['a key that is no relay’s', { ...REMOTE, key: 'local' }],
        ['no port', { ...REMOTE, port: 'x' }],
        ['hosts that are not a list', { ...REMOTE, hosts: 'moic.gen' }],
    ])('refuses %s', async (_name, remote) => {
        const service = new BrowserService();
        await service.call('register', [], 'browser');
        await expect(service.call('open', ['https://moic.gen/', 'user-gesture', remote], 'window')).rejects.toThrow(/another workstation/);
    });

    it('a door that moves, or learns its CA, reaches the browser process live', async () => {
        const service = new BrowserService();
        const events: BrowserEvent[] = [];
        service.onEvent((e) => events.push(e));
        await service.call('register', [], 'browser');
        await service.call('remoteVia', ['relay:ws1', 6262, 'NEWCA'], 'window');
        expect(events.at(-1)).toEqual({ kind: 'remoteVia', key: 'relay:ws1', port: 6262, ca: 'NEWCA' });
    });

    it('the host’s word about a door is heard from the device link', () => {
        const replica = new DeviceLinkReplica(async () => null) as unknown as { onVia(l: (channel: string, port: number, ca: string | null) => void): () => void; apply(event: unknown): void };
        const heard: unknown[] = [];
        replica.onVia((...via) => heard.push(via));
        replica.apply({ type: 'via', channel: 'c1', port: 6262, ca: 'NEWCA' });
        expect(heard).toEqual([['c1', 6262, 'NEWCA']]);
    });

    it('CONTROL: this machine’s own open carries no remote', async () => {
        const service = new BrowserService();
        const events: BrowserEvent[] = [];
        service.onEvent((e) => events.push(e));
        await service.call('register', [], 'browser');
        await service.call('open', ['https://moic.gen/', 'user-gesture'], 'window');
        expect(events.at(-1)).toEqual({ kind: 'open', url: 'https://moic.gen/', activation: 'user-gesture' });
    });

    it('the browser process’s link passes it to its windows', async () => {
        const FACTS: BrowserFacts = { frontDoorPort: 4443, caPem: 'CA', hosts: ['moic.gen'], workspaceOf: {}, launch: { file: 'Genie.exe', args: [] } };
        let emit: (event: BrowserEvent) => void = () => {};
        const client: BrowserLinkClient = { browserCall: vi.fn(async () => ({ facts: FACTS, doorUp: true })), onBrowserEvent: (l) => { emit = l; return () => {}; }, close: vi.fn() };
        const open = vi.fn((..._args: unknown[]) => {});
        const link = runBrowserLink({ connect: async () => client, sleep: async () => {}, facts: () => {}, door: () => {}, open, quit: () => {}, log: () => {} });
        await link.linked;
        emit({ kind: 'open', url: 'https://moic.gen/', activation: 'user-gesture', remote: REMOTE } as unknown as BrowserEvent);
        expect(open).toHaveBeenCalledWith('https://moic.gen/', 'user-gesture', REMOTE);
        link.stop();
    });
});

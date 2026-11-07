import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { BrowserService, type BrowserEvent, type BrowserPage } from '../src/main/browser-service.js';
import { BrowserPagesReplica } from '../src/main/browser-pages-replica.js';

/**
 * THE GENIE BROWSER'S PAGES, FOR THE `pages` TOOL (the host split, P2b). The tool reads its pages at once and drives them
 * through a transport, and its pages now live in another process. So that process says what it has, the window keeps a
 * replica, and a call crosses the host and back. What may be driven stays the tool's rule, unchanged.
 */

const PAGE: BrowserPage = { id: 'window:local:tab-1', url: 'https://moic.gen/', title: 'Moic', revision: 3 };

function serviceWith(ports: ConstructorParameters<typeof BrowserService>[0] = {}) {
    const service = new BrowserService(ports);
    const events: BrowserEvent[] = [];
    service.onEvent((event) => events.push(event));
    return { service, events };
}

describe('the service', () => {
    it('hands on what the browser has, and keeps it for a window that links later', async () => {
        const { service, events } = serviceWith();
        await service.call('register', [], 'browser');
        await service.call('pages', [[PAGE]], 'browser');
        expect(events.at(-1)).toEqual({ kind: 'pages', pages: [PAGE] });
        expect(await service.call('pagesNow', [], 'window')).toEqual([PAGE]);
    });

    it('only the linked browser says what the pages are', async () => {
        const { service } = serviceWith();
        await service.call('register', [], 'browser');
        await expect(service.call('pages', [[PAGE]], 'window')).rejects.toThrow(/browser/);
    });

    it('the browser going: no pages, and said', async () => {
        const { service, events } = serviceWith();
        await service.call('register', [], 'browser');
        await service.call('pages', [[PAGE]], 'browser');
        service.dropped('browser');
        expect(events.at(-1)).toEqual({ kind: 'pages', pages: [] });
        expect(await service.call('pagesNow', [], 'window')).toEqual([]);
    });

    it('a call crosses to the browser and its answer comes back', async () => {
        const { service, events } = serviceWith();
        await service.call('register', [], 'browser');
        const answer = service.call('pageCall', ['window:local:tab-1', 'describe', [1]], 'window');
        const asked = events.at(-1) as Extract<BrowserEvent, { kind: 'pageCall' }>;
        expect(asked).toMatchObject({ kind: 'pageCall', pageId: 'window:local:tab-1', method: 'describe', args: [1] });
        await service.call('pageReply', [asked.requestId, true, { seen: 1 }], 'browser');
        await expect(answer).resolves.toEqual({ seen: 1 });
    });

    it('its failure comes back as a failure', async () => {
        const { service, events } = serviceWith();
        await service.call('register', [], 'browser');
        const answer = service.call('pageCall', ['p', 'describe', []], 'window');
        const asked = events.at(-1) as Extract<BrowserEvent, { kind: 'pageCall' }>;
        await service.call('pageReply', [asked.requestId, false, 'the page went away'], 'browser');
        await expect(answer).rejects.toThrow('the page went away');
    });

    it('no browser: refused at once, in words', async () => {
        await expect(serviceWith().service.call('pageCall', ['p', 'describe', []], 'window')).rejects.toThrow(/browser/);
    });

    it('the browser going mid-call: the call fails, it does not hang', async () => {
        const { service } = serviceWith();
        await service.call('register', [], 'browser');
        const answer = service.call('pageCall', ['p', 'describe', []], 'window');
        service.dropped('browser');
        await expect(answer).rejects.toThrow(/browser/);
    });

    it('a browser that never answers: the call fails at its limit', async () => {
        vi.useFakeTimers();
        try {
            const { service } = serviceWith();
            await service.call('register', [], 'browser');
            const answer = service.call('pageCall', ['p', 'describe', []], 'window');
            const check = expect(answer).rejects.toThrow(/did not answer/);
            await vi.advanceTimersByTimeAsync(60_000);
            await check;
        } finally { vi.useRealTimers(); }
    });

    it('a reply from anyone but the browser, or to nothing, changes nothing', async () => {
        const { service, events } = serviceWith();
        await service.call('register', [], 'browser');
        const answer = service.call('pageCall', ['p', 'describe', []], 'window');
        const asked = events.at(-1) as Extract<BrowserEvent, { kind: 'pageCall' }>;
        await expect(service.call('pageReply', [asked.requestId, true, 'forged'], 'window')).rejects.toThrow(/browser/);
        await service.call('pageReply', ['no-such', true, 'x'], 'browser');
        await service.call('pageReply', [asked.requestId, true, 'real'], 'browser');
        await expect(answer).resolves.toBe('real');
    });
});

describe('the replica in the window', () => {
    it('reads as the tool needs, at once', () => {
        const replica = new BrowserPagesReplica(async () => null);
        replica.apply([PAGE]);
        const [page] = replica.list();
        expect(page).toMatchObject({ id: PAGE.id, url: PAGE.url, title: PAGE.title });
        expect(page!.revision()).toBe(3);
    });

    it('a page held across a change reads the revision now: a navigation cancels what the agent saw', () => {
        const replica = new BrowserPagesReplica(async () => null);
        replica.apply([PAGE]);
        const [page] = replica.list();
        replica.apply([{ ...PAGE, revision: 4 }]);
        expect(page!.revision()).toBe(4);
    });

    it('its transport goes through the host', async () => {
        const call = vi.fn(async () => 'answer');
        const replica = new BrowserPagesReplica(call);
        replica.apply([PAGE]);
        await expect(replica.list()[0]!.transport.call('describe', [1])).resolves.toBe('answer');
        expect(call).toHaveBeenCalledWith(PAGE.id, 'describe', [1]);
    });

    it('a page gone reads gone', () => {
        const replica = new BrowserPagesReplica(async () => null);
        replica.apply([PAGE]);
        replica.apply([]);
        expect(replica.list()).toEqual([]);
    });
});

describe('the wires', () => {
    const strip = (file: string) => readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');

    it('the tool reads this process’s pages and the browser’s', () => {
        expect(strip('src/main/main.ts')).toMatch(/pages: \{ open: \(\) => \[\.\.\.drivablePages\(\), \.\.\.browserPages\.list\(\)\] \}/);
    });

    it('the browser’s process says what it has when it changes, and answers calls', () => {
        const src = strip('src/main/browser-process.ts');
        expect(src).toMatch(/onPagesChanged\(/);
        expect(src).toMatch(/browserCall\('pages', /);
        expect(src).toMatch(/browserCall\('pageReply', /);
    });

    it('a page says when it moves or is named, not only when it attaches', () => {
        const src = strip('src/main/page-navigation-electron.ts');
        expect(src).toMatch(/export function onPagesChanged\(/);
        expect(src).toMatch(/wc\.on\('page-title-updated'/);
    });
});

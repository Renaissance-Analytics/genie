import { describe, expect, it } from 'vitest';
import { BrowserService, type BrowserEvent, type BrowserFacts } from '../src/main/browser-service.js';

/**
 * THE GENIE BROWSER'S PROCESS, AS THE HOST SEES IT (the host split, P2b; decision 5: "its own process, not dependent on the
 * workspace UX"). The window and the browser never talk directly: each is a client of the host. The window says what the
 * browser needs and what to open; the host holds it until a browser is linked. The front door is the window's until P5.
 */

const FACTS: BrowserFacts = { frontDoorPort: 4443, caPem: 'CA', hosts: ['moic.gen'], workspaceOf: { 'moic.gen': 'ws' }, launch: { file: 'Genie.exe', args: ['--genie-browser'] } };

function setup(ports: ConstructorParameters<typeof BrowserService>[0] = {}) {
    const service = new BrowserService(ports);
    const events: BrowserEvent[] = [];
    service.onEvent((event) => events.push(event));
    return { service, events };
}
const opens = (events: BrowserEvent[]) => events.filter((e) => e.kind === 'open').map((e) => (e as { url: string }).url);

describe('opening a site', () => {
    it('with no browser linked: held, and the window is told to start one', async () => {
        const { service, events } = setup();
        expect(await service.call('open', ['https://moic.gen/', 'user-gesture'], 'window')).toEqual({ browserUp: false });
        expect(opens(events)).toEqual([]);
    });

    it('a browser linking gets what was held, in order, once', async () => {
        const { service, events } = setup();
        await service.call('open', ['https://a.gen/', 'background'], 'window');
        await service.call('open', ['https://b.gen/', 'user-gesture'], 'window');
        await service.call('register', [], 'browser');
        expect(opens(events)).toEqual(['https://a.gen/', 'https://b.gen/']);
        expect(events.find((e) => e.kind === 'open')).toMatchObject({ activation: 'background' });
        await service.call('register', [], 'browser');
        expect(opens(events)).toHaveLength(2);
    });

    it('with a browser linked: straight through', async () => {
        const { service, events } = setup();
        await service.call('register', [], 'browser');
        expect(await service.call('open', ['https://moic.gen/', 'background'], 'window')).toEqual({ browserUp: true });
        expect(opens(events)).toEqual(['https://moic.gen/']);
    });

    it('what is held is bounded: a browser that never comes does not grow it', async () => {
        const { service, events } = setup();
        for (let i = 0; i < 50; i += 1) await service.call('open', [`https://s${i}.gen/`, 'background'], 'window');
        await service.call('register', [], 'browser');
        expect(opens(events)).toHaveLength(20);
        expect(opens(events).at(-1)).toBe('https://s49.gen/');
    });

    it('only an activation it knows: anything else opens in the background, never taking the keyboard', async () => {
        const { service, events } = setup();
        await service.call('register', [], 'browser');
        await service.call('open', ['https://moic.gen/', 'whatever'], 'window');
        expect(events.at(-1)).toMatchObject({ kind: 'open', activation: 'background' });
    });

    it('an address that is not text is refused', async () => {
        const { service } = setup();
        await expect(service.call('open', [42, 'background'], 'window')).rejects.toThrow(/address/);
    });
});

describe('starting a browser', () => {
    const counted = () => {
        let now = 0;
        const started: unknown[] = [];
        return { started, ports: { startBrowser: (launch: unknown) => { started.push(launch); }, now: () => now }, advance: (ms: number) => { now += ms; } };
    };

    it('an open with no browser starts one, as the window said to', async () => {
        const c = counted();
        const { service } = setup(c.ports);
        await service.call('publish', [FACTS], 'window');
        await service.call('open', ['https://moic.gen/', 'background'], 'window');
        expect(c.started).toEqual([FACTS.launch]);
    });

    it('one held open before the window has said how: started when it says', async () => {
        const c = counted();
        const { service } = setup(c.ports);
        await service.call('open', ['https://moic.gen/', 'background'], 'window');
        expect(c.started).toEqual([]);
        await service.call('publish', [FACTS], 'window');
        expect(c.started).toEqual([FACTS.launch]);
    });

    it('CONTROL: publishing with nothing to open starts nothing', async () => {
        const c = counted();
        const { service } = setup(c.ports);
        await service.call('publish', [FACTS], 'window');
        expect(c.started).toEqual([]);
    });

    it('not twice while one is on its way; again if it never linked', async () => {
        const c = counted();
        const { service } = setup(c.ports);
        await service.call('publish', [FACTS], 'window');
        await service.call('open', ['https://a.gen/', 'background'], 'window');
        await service.call('open', ['https://b.gen/', 'background'], 'window');
        expect(c.started).toHaveLength(1);
        c.advance(30_000);
        await service.call('open', ['https://c.gen/', 'background'], 'window');
        expect(c.started).toHaveLength(2);
    });

    it('a browser linked: nothing started', async () => {
        const c = counted();
        const { service } = setup(c.ports);
        await service.call('publish', [FACTS], 'window');
        await service.call('register', [], 'browser');
        await service.call('open', ['https://a.gen/', 'background'], 'window');
        expect(c.started).toEqual([]);
    });
});

describe('opening with no address', () => {
    it('is the browser with its first site: null, not a refusal', async () => {
        const { service, events } = setup();
        await service.call('register', [], 'browser');
        await service.call('open', [null, 'user-gesture'], 'window');
        expect(events.at(-1)).toEqual({ kind: 'open', url: null, activation: 'user-gesture' });
    });
});

describe('the host ending', () => {
    it('says so, for the browser to end too', () => {
        const { service, events } = setup();
        service.quit();
        expect(events.at(-1)).toEqual({ kind: 'quit' });
    });
});

describe('what the browser needs', () => {
    it('published by the window, handed to a browser that links later', async () => {
        const { service, events } = setup();
        await service.call('publish', [FACTS], 'window');
        expect(await service.call('register', [], 'browser')).toEqual({ facts: FACTS, doorUp: true });
        expect(events).toContainEqual({ kind: 'facts', facts: FACTS });
    });

    it('nothing published yet: the browser hears null, and hears the facts when they come', async () => {
        const { service, events } = setup();
        expect(await service.call('register', [], 'browser')).toEqual({ facts: null, doorUp: false });
        await service.call('publish', [FACTS], 'window');
        expect(events).toContainEqual({ kind: 'facts', facts: FACTS });
    });

    it('the facts have to be whole: a bad publish changes nothing', async () => {
        const { service } = setup();
        await service.call('publish', [FACTS], 'window');
        await expect(service.call('publish', [{ frontDoorPort: 'x' }], 'window')).rejects.toThrow(/facts/);
        expect(await service.call('register', [], 'browser')).toEqual({ facts: FACTS, doorUp: true });
    });
});

describe('a browser leaving', () => {
    it('its own connection going means no browser; the next open is held again', async () => {
        const { service } = setup();
        await service.call('register', [], 'browser');
        service.dropped('browser');
        expect(await service.call('open', ['https://moic.gen/', 'background'], 'window')).toEqual({ browserUp: false });
    });

    it('CONTROL: a window going changes nothing for the browser', async () => {
        const { service } = setup();
        await service.call('register', [], 'browser');
        service.dropped('window');
        expect(await service.call('open', ['https://moic.gen/', 'background'], 'window2')).toEqual({ browserUp: true });
    });

    it('the window that published going means the front door is gone: the browser hears it, in time to say so', async () => {
        const { service, events } = setup();
        await service.call('publish', [FACTS], 'window');
        await service.call('register', [], 'browser');
        service.dropped('window');
        expect(events.at(-1)).toEqual({ kind: 'door', up: false });
        await service.call('publish', [FACTS], 'window2');
        expect(events).toContainEqual({ kind: 'door', up: true });
    });

    it('CONTROL: another client going says nothing about the door', async () => {
        const { service, events } = setup();
        await service.call('publish', [FACTS], 'window');
        const before = events.length;
        service.dropped('someone-else');
        expect(events).toHaveLength(before);
    });

    it('a browser linking after the window went hears that too', async () => {
        const { service } = setup();
        await service.call('publish', [FACTS], 'window');
        service.dropped('window');
        expect(await service.call('register', [], 'browser')).toEqual({ facts: FACTS, doorUp: false });
    });

    it('a method it does not know is refused', async () => {
        await expect(setup().service.call('nope', [], 'window')).rejects.toThrow(/nope/);
    });
});

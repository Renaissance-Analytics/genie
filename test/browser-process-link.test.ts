import { describe, expect, it, vi } from 'vitest';
import type { BrowserEvent, BrowserFacts } from '../src/main/browser-service.js';
import { runBrowserLink, type BrowserLinkClient } from '../src/main/browser-process-link.js';

/**
 * THE GENIE BROWSER'S PROCESS, ITS LINK TO THE HOST (the host split, P2b). It adopts a running host and never starts or
 * replaces one. It outlives the window, and a host that drops is tried again while its pages stay up. The host going down
 * on purpose ends it, because an installer needs the binary free.
 */

const FACTS: BrowserFacts = { frontDoorPort: 4443, caPem: 'CA', hosts: ['moic.gen'], workspaceOf: { 'moic.gen': 'ws' }, launch: { file: 'Genie.exe', args: ['--genie-browser'] } };

function fakeClient(answer: { facts: BrowserFacts | null; doorUp: boolean }) {
    let listener: (event: BrowserEvent) => void = () => {};
    const client: BrowserLinkClient = {
        browserCall: vi.fn(async () => answer),
        onBrowserEvent: (l) => { listener = l; return () => {}; },
        close: vi.fn(),
    };
    return { client, emit: (event: BrowserEvent) => listener(event) };
}

function setup(clients: Array<ReturnType<typeof fakeClient> | null>) {
    let lost: () => void = () => {};
    const ports = {
        connect: vi.fn(async (onLost: () => void) => { lost = onLost; return clients.shift()?.client ?? null; }),
        sleep: vi.fn(async () => {}),
        facts: vi.fn(),
        door: vi.fn(),
        open: vi.fn(),
        quit: vi.fn(),
        linked: vi.fn(),
        log: vi.fn(),
    };
    return { ports, lose: () => lost() };
}

describe('linking', () => {
    it('registers, and hands on the facts and the door', async () => {
        const c = fakeClient({ facts: FACTS, doorUp: true });
        const { ports } = setup([c]);
        const link = runBrowserLink(ports);
        await link.linked;
        expect(c.client.browserCall).toHaveBeenCalledWith('register', []);
        expect(ports.facts).toHaveBeenCalledWith(FACTS);
        expect(ports.door).toHaveBeenLastCalledWith(true);
        link.stop();
    });

    it('no host yet: it tries again, and never starts one', async () => {
        const c = fakeClient({ facts: FACTS, doorUp: true });
        const { ports } = setup([null, null, c]);
        const link = runBrowserLink(ports);
        await link.linked;
        expect(ports.connect).toHaveBeenCalledTimes(3);
        expect(ports.sleep).toHaveBeenCalledTimes(2);
        link.stop();
    });
});

describe('the order on linking (batch SS: a store opened by a held open asked for cookies with no link yet)', () => {
    it('the link is handed on before anything held is opened', async () => {
        const c = fakeClient({ facts: FACTS, doorUp: true });
        const order: string[] = [];
        const { ports } = setup([c]);
        ports.linked = vi.fn(() => { order.push('linked'); });
        ports.open = vi.fn(() => { order.push('open'); });
        ports.facts = vi.fn(() => { order.push('facts'); });
        (c.client.browserCall as ReturnType<typeof vi.fn>).mockImplementation(async () => {
            c.emit({ kind: 'open', url: 'https://a.gen/', activation: 'background' });
            return { facts: FACTS, doorUp: true };
        });
        const link = runBrowserLink(ports as never);
        await link.linked;
        expect(order).toEqual(['linked', 'facts', 'open']);
        link.stop();
    });
});

describe('what the host says', () => {
    it('opens a site once the facts are known, in order; before that it holds them', async () => {
        const c = fakeClient({ facts: null, doorUp: false });
        const { ports } = setup([c]);
        const link = runBrowserLink(ports);
        await link.linked;
        c.emit({ kind: 'open', url: 'https://a.gen/', activation: 'background' });
        c.emit({ kind: 'open', url: null, activation: 'user-gesture' });
        expect(ports.open).not.toHaveBeenCalled();
        c.emit({ kind: 'facts', facts: FACTS });
        expect(ports.open.mock.calls).toEqual([['https://a.gen/', 'background'], [null, 'user-gesture']]);
        c.emit({ kind: 'open', url: 'https://b.gen/', activation: 'background' });
        expect(ports.open).toHaveBeenLastCalledWith('https://b.gen/', 'background');
        link.stop();
    });

    it('the door going and coming is handed on', async () => {
        const c = fakeClient({ facts: FACTS, doorUp: true });
        const { ports } = setup([c]);
        const link = runBrowserLink(ports);
        await link.linked;
        c.emit({ kind: 'door', up: false });
        expect(ports.door).toHaveBeenLastCalledWith(false);
        c.emit({ kind: 'door', up: true });
        expect(ports.door).toHaveBeenLastCalledWith(true);
        link.stop();
    });

    it('the host ending on purpose ends this process', async () => {
        const c = fakeClient({ facts: FACTS, doorUp: true });
        const { ports } = setup([c]);
        const link = runBrowserLink(ports);
        await link.linked;
        c.emit({ kind: 'quit' });
        expect(ports.quit).toHaveBeenCalledTimes(1);
        link.stop();
    });
});

describe('the link going', () => {
    it('the door reads down, it links again, and the process stays', async () => {
        const first = fakeClient({ facts: FACTS, doorUp: true });
        const second = fakeClient({ facts: FACTS, doorUp: true });
        const { ports, lose } = setup([first, null, second]);
        const link = runBrowserLink(ports);
        await link.linked;
        lose();
        expect(ports.door).toHaveBeenLastCalledWith(false);
        await vi.waitFor(() => expect(second.client.browserCall).toHaveBeenCalledWith('register', []));
        await vi.waitFor(() => expect(ports.door).toHaveBeenLastCalledWith(true));
        expect(ports.quit).not.toHaveBeenCalled();
        link.stop();
    });

    it('stopped, it tries no more', async () => {
        const first = fakeClient({ facts: FACTS, doorUp: true });
        const { ports, lose } = setup([first]);
        const link = runBrowserLink(ports);
        await link.linked;
        link.stop();
        const calls = ports.connect.mock.calls.length;
        lose();
        await new Promise((r) => setTimeout(r, 10));
        expect(ports.connect).toHaveBeenCalledTimes(calls);
    });
});

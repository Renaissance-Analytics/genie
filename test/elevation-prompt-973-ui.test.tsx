// @vitest-environment happy-dom
/**
 * TYNN #973 — GENIE'S PASSWORD PROMPT, IN THE CLIENT THE PERSON CLICKED FROM. Two halves:
 *
 * - The wire: the host asks ONE connection (RemoteHost.promptTo), the client that said it can show the prompt hears it,
 *   and its answer (`elevation.answer`) reaches the broker; another connection's answer for that prompt is not taken, and
 *   a connection that never said it can show the prompt is refused with a reason, never asked.
 * - The prompt as a person sees it: it names the packages and the commands, the field is empty, Allow sends what was typed
 *   and empties the field at once, nothing typed is ever in the page's markup, a wrong password comes back as a new empty
 *   prompt saying so, Cancel says Cancel, and the host's close removes it.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Baton, PairingPins } from '../src/core/remote.js';
import { inMemoryPair, type ServerConnection } from '../src/core/remote-protocol.js';
import { remoteOffer } from '../src/core/protocol-version.js';
import { CAP_ELEVATION_PROMPT, ELEVATION_EVENT, type ElevationBridge, type ElevationPromptEvent } from '../src/core/elevation.js';
import { ElevationBroker, NOT_CAPABLE } from '../src/main/elevation-broker.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost } from '../src/main/remote-host.js';
import { connectRemote } from '../src/renderer/remote-bridge.js';
import { ElevationPrompt } from '../src/renderer/components/ElevationPrompt.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

const PW = 'S3cret-typed-here';
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });

describe('the wire: the asked connection, and only it', () => {
    let dir: string;
    let devices: DeviceStore;
    let host: RemoteHost;
    let broker: ElevationBroker;
    let accept: (c: ServerConnection) => void;
    let accepted = 0;
    const clients: Array<ReturnType<typeof connectRemote>> = [];

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie-973-wire-'));
        devices = await DeviceStore.open(dir, { now: () => 1, random: () => 'token-973' });
        accept = () => {};
        accepted = 0;
        host = new RemoteHost({
            api: {
                invoke: async (method, args, context) => (method === 'elevation.answer' ? broker.answer(context!.connectionId, args[0], args[1]) : null),
                onEvent: () => () => {}, workspaceOfAgent: () => null,
            },
            devices, hostName: 'wire-host', baton: new Baton(),
            pins: new PairingPins({ now: () => 1, random: () => 0.5 }), confirm: allowEveryPairing,
            transport: { onConnection: (listener) => { accept = listener; return () => {}; } },
            protocol: () => remoteOffer('host', null, [`${CAP_ELEVATION_PROMPT}@1`]),
        });
        broker = new ElevationBroker({ send: (id, e) => host.promptTo(id, ELEVATION_EVENT, e), capable: (id) => host.canPrompt(id), newId: () => 'p1' });
    });
    afterEach(async () => {
        for (const c of clients.splice(0)) c.close();
        await devices.flushed();
        await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });

    const localClient = async (label: string, elevationPrompt: boolean) => {
        const pair = inMemoryPair();
        accept({ ...pair.server, preAuth: { kind: 'local', label, isOwner: true, workspaceId: null, readonly: false } });
        const c = connectRemote(pair.client, { kind: 'local' }, label, elevationPrompt ? { elevationPrompt: true } : {});
        clients.push(c);
        expect(await c.ready).toEqual({ ok: true });
        // RemoteHost numbers its connections in the order it accepts them.
        const id: string | null = `conn_${++accepted}`;
        return { c, id };
    };

    it('asks the clicking window, hears its answer; another window\'s answer is not taken; the password never comes back', async () => {
        const mine = await localClient('this window', true);
        const other = await localClient('another window', true);
        expect(mine.id).not.toBeNull();
        const heardMine: ElevationPromptEvent[] = [];
        const heardOther: ElevationPromptEvent[] = [];
        mine.c.bridge.elevation!.onPrompt((e) => heardMine.push(e));
        other.c.bridge.elevation!.onPrompt((e) => heardOther.push(e));
        const asked = broker.ask({ connectionId: mine.id!, isOwner: true, readonly: false }, { title: 'Install git', items: ['git'], commands: ['apt-get install -y git'], attempt: 1, retry: null });
        await new Promise((r) => setTimeout(r, 10));
        expect(heardMine).toEqual([expect.objectContaining({ kind: 'ask', id: 'p1', title: 'Install git', items: ['git'] })]);
        expect(heardOther).toEqual([]); // ONE connection is asked
        expect(await other.c.bridge.elevation!.answer('p1', 'not-mine')).toBe(false);
        expect(await mine.c.bridge.elevation!.answer('p1', PW)).toBe(true);
        expect(await asked).toEqual({ password: PW });
        await new Promise((r) => setTimeout(r, 10));
        expect(heardMine.at(-1)).toEqual({ kind: 'close', id: 'p1' });
        expect(JSON.stringify([heardMine, heardOther])).not.toContain(PW);
    });

    it('a window that never said it can show the prompt is refused with a reason, and hears nothing', async () => {
        const old = await localClient('an older window', false);
        expect(host.canPrompt(old.id!)).toBe(false);
        expect(await broker.ask({ connectionId: old.id!, isOwner: true, readonly: false }, { title: 'Install git', items: ['git'], commands: [], attempt: 1, retry: null })).toEqual({ refused: NOT_CAPABLE });
        // CONTROL: a capable one is capable, so the false above is the hello's doing.
        const capable = await localClient('a new window', true);
        expect(host.canPrompt(capable.id!)).toBe(true);
    });
});

describe('the prompt as a person sees it', () => {
    const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    let el: HTMLDivElement;
    let root: Root;
    beforeEach(() => { g.IS_REACT_ACT_ENVIRONMENT = true; el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el); });
    afterEach(() => { act(() => root.unmount()); el.remove(); });

    const fakeBridge = () => {
        let listener: (e: ElevationPromptEvent) => void = () => {};
        const answers: Array<[string, string | null]> = [];
        const bridge: ElevationBridge = { onPrompt: (l) => { listener = l; return () => {}; }, answer: async (id, pw) => { answers.push([id, pw]); return true; } };
        return { bridge, answers, emit: (e: ElevationPromptEvent) => act(() => listener(e)) };
    };
    const ask = (id: string, retry: string | null = null, attempt = 1): ElevationPromptEvent => ({ kind: 'ask', id, title: 'Install git', items: ['git'], commands: ['apt-get update', 'apt-get install -y git'], attempt, retry, expiresAt: 0 });
    const field = () => document.querySelector<HTMLInputElement>('input[type="password"]');
    const type = (value: string) => { const f = field()!; f.value = value; };
    const press = async (action: string) => { await act(async () => { document.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!.click(); }); await settle(); };

    it('names the packages and the commands; Allow sends what was typed, empties the field at once, and nothing typed is in the markup', async () => {
        const f = fakeBridge();
        act(() => root.render(<ElevationPrompt elevation={f.bridge} />));
        expect(document.querySelector('[data-elevation-prompt]')).toBeNull();
        f.emit(ask('p1'));
        const box = document.querySelector('[data-elevation-prompt="p1"]')!;
        expect(box.getAttribute('role')).toBe('dialog');
        expect(box.querySelector('[data-elevation-items]')!.textContent).toBe('git');
        expect([...box.querySelectorAll('[data-elevation-commands] li')].map((li) => li.textContent)).toEqual(['apt-get update', 'apt-get install -y git']);
        expect(field()!.value).toBe('');
        type(PW);
        await press('elevation-allow');
        expect(f.answers).toEqual([['p1', PW]]);
        expect(field()!.value).toBe('');
        expect(document.body.innerHTML).not.toContain(PW);
        f.emit({ kind: 'close', id: 'p1' });
        expect(document.querySelector('[data-elevation-prompt]')).toBeNull();
    });

    it('a wrong password comes back as a NEW empty prompt that says so; Cancel answers Cancel', async () => {
        const f = fakeBridge();
        act(() => root.render(<ElevationPrompt elevation={f.bridge} />));
        f.emit(ask('p1'));
        type('wrong');
        await press('elevation-allow');
        f.emit({ kind: 'close', id: 'p1' });
        f.emit(ask('p2', 'that password was not accepted', 2));
        expect(document.querySelector('[data-elevation-prompt="p2"]')).not.toBeNull();
        expect(document.querySelector('[data-elevation-retry]')!.textContent).toBe('That password was not accepted. Try again (try 2 of 3).');
        expect(field()!.value).toBe('');
        await press('elevation-cancel');
        expect(f.answers).toEqual([['p1', 'wrong'], ['p2', null]]);
    });

    it('an empty field sends nothing', async () => {
        const f = fakeBridge();
        act(() => root.render(<ElevationPrompt elevation={f.bridge} />));
        f.emit(ask('p1'));
        await press('elevation-allow');
        expect(f.answers).toEqual([]);
    });
});

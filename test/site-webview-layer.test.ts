import { describe, expect, it, vi } from 'vitest';
import { siteWebviewLayer, tabsChanged } from '../src/renderer/site-webview-layer.js';

/**
 * THE LAYER THE PANELS' PAGES LIVE IN. Measured on Electron 45.2.2: moving a <webview> in the DOM reloads it, with
 * `appendChild` and `moveBefore` alike, and a panel's page has to survive its tab being off screen. So a page never lives
 * in the panel: it is a stable element in one layer, placed over the panel's box, hidden and shown, and never moved.
 */

function fakeDocument() {
    const made: FakeElement[] = [];
    const makeElement = (tag: string): FakeElement => {
        const el: FakeElement = {
            tag,
            attrs: {} as Record<string, string>,
            style: {} as Record<string, string>,
            children: [],
            parent: null,
            setAttribute(name: string, value: string) { el.attrs[name] = value; },
            appendChild(child: FakeElement) { child.parent = el; child.attrsAtAttach = { ...child.attrs }; el.children.push(child); child.appended = (child.appended ?? 0) + 1; return child; },
            remove() { if (el.parent) el.parent.children = el.parent.children.filter((c) => c !== el); el.parent = null; el.removed = true; },
            reload: vi.fn(),
            goBack: vi.fn(),
            goForward: vi.fn(),
            canGoBack: vi.fn(() => false),
            canGoForward: vi.fn(() => false),
            listeners: {},
            addEventListener(event: string, listener: () => void) { (el.listeners[event] ??= []).push(listener); },
            emit(event: string) { for (const listener of el.listeners[event] ?? []) listener(); },
        };
        made.push(el);
        return el;
    };
    const body = makeElement('body');
    return { doc: { body, createElement: makeElement } as never, made, views: () => made.filter((e) => e.tag === 'webview') };
}
interface FakeElement {
    tag: string;
    attrs: Record<string, string>;
    attrsAtAttach?: Record<string, string>;
    style: Record<string, string>;
    children: FakeElement[];
    parent: FakeElement | null;
    appended?: number;
    removed?: boolean;
    setAttribute(name: string, value: string): void;
    appendChild(child: FakeElement): FakeElement;
    remove(): void;
    reload: ReturnType<typeof vi.fn>;
    goBack: ReturnType<typeof vi.fn>;
    goForward: ReturnType<typeof vi.fn>;
    canGoBack: ReturnType<typeof vi.fn>;
    canGoForward: ReturnType<typeof vi.fn>;
    listeners: Record<string, Array<() => void>>;
    addEventListener(event: string, listener: () => void): void;
    emit(event: string): void;
}

const BOX = { x: 10, y: 20, width: 300, height: 200 };
const yes = async () => ({ ok: true as const });

describe('showing', () => {
    it('makes one <webview>, its src set BEFORE it attaches (main decides at attach), asking for nothing else', async () => {
        const { doc, views } = fakeDocument();
        const layer = siteWebviewLayer({ doc, prepare: yes });
        expect(await layer.show('ws:t:0', 'moic.gen', BOX)).toEqual({ ok: true });
        const [view] = views();
        expect(views()).toHaveLength(1);
        expect(view!.attrsAtAttach).toEqual({ src: 'https://moic.gen/' });
    });

    it('placed over the box, and visible', async () => {
        const { doc, views } = fakeDocument();
        await siteWebviewLayer({ doc, prepare: yes }).show('ws:t:0', 'moic.gen', BOX);
        expect(views()[0]!.style).toMatchObject({ left: '10px', top: '20px', width: '300px', height: '200px', visibility: 'visible' });
    });

    it('main is asked first, with the site: the session has to be routed before the page loads', async () => {
        const { doc, views } = fakeDocument();
        const prepare = vi.fn(async () => { expect(views()).toHaveLength(0); return { ok: true as const }; });
        await siteWebviewLayer({ doc, prepare }).show('ws:t:0', 'moic.gen', BOX);
        expect(prepare).toHaveBeenCalledWith('moic.gen');
        expect(views()).toHaveLength(1);
    });

    it('the box moving moves the same page: never appended twice, never a second one (a move would reload it)', async () => {
        const { doc, views } = fakeDocument();
        const layer = siteWebviewLayer({ doc, prepare: yes });
        await layer.show('ws:t:0', 'moic.gen', BOX);
        await layer.show('ws:t:0', 'moic.gen', { ...BOX, x: 99 });
        expect(views()).toHaveLength(1);
        expect(views()[0]!.appended).toBe(1);
        expect(views()[0]!.style.left).toBe('99px');
    });

    it('a site main refuses: the words come back, and any page the panel had closes', async () => {
        const { doc, views } = fakeDocument();
        let answer: { ok: true } | { ok: false; error: string } = { ok: true };
        const layer = siteWebviewLayer({ doc, prepare: async () => answer });
        await layer.show('ws:t:0', 'moic.gen', BOX);
        answer = { ok: false, error: 'moic.gen is not served here' };
        expect(await layer.show('ws:t:0', 'moic.gen', BOX)).toEqual({ ok: false, error: 'moic.gen is not served here' });
        expect(views()[0]!.removed).toBe(true);
    });

    it('a different site is a new element, the old one closed: the renderer never changes where a page points', async () => {
        const { doc, views } = fakeDocument();
        const layer = siteWebviewLayer({ doc, prepare: yes });
        await layer.show('ws:t:0', 'moic.gen', BOX);
        await layer.show('ws:t:0', 'shop.gen', BOX);
        expect(views()).toHaveLength(2);
        expect(views()[0]!.removed).toBe(true);
        expect(views()[0]!.attrs.src).toBe('https://moic.gen/');
        expect(views()[1]!.attrsAtAttach).toEqual({ src: 'https://shop.gen/' });
        expect(views()[1]!.style.left).toBe('10px');
    });
});

describe('its history and loading', () => {
    it('back and forward reach that page, and do not throw before it is ready', async () => {
        const { doc, views } = fakeDocument();
        const layer = siteWebviewLayer({ doc, prepare: yes });
        await layer.show('ws:t:0', 'moic.gen', BOX);
        layer.back('ws:t:0');
        layer.forward('ws:t:0');
        expect(views()[0]!.goBack).toHaveBeenCalledTimes(1);
        expect(views()[0]!.goForward).toHaveBeenCalledTimes(1);
        views()[0]!.goBack.mockImplementation(() => { throw new Error('not ready'); });
        expect(() => layer.back('ws:t:0')).not.toThrow();
    });

    it('says what the page can do as it navigates and loads', async () => {
        const { doc, views } = fakeDocument();
        const layer = siteWebviewLayer({ doc, prepare: yes });
        const heard: unknown[] = [];
        layer.onState('ws:t:0', (state) => heard.push(state));
        await layer.show('ws:t:0', 'moic.gen', BOX);
        const view = views()[0]!;
        view.emit('did-start-loading');
        expect(heard.at(-1)).toMatchObject({ loading: true });
        view.canGoBack.mockReturnValue(true);
        view.emit('did-navigate');
        view.emit('did-stop-loading');
        expect(heard.at(-1)).toEqual({ canGoBack: true, canGoForward: false, loading: false });
    });

    it('a listener can leave, and a later page of the panel still reports', async () => {
        const { doc, views } = fakeDocument();
        const layer = siteWebviewLayer({ doc, prepare: yes });
        const heard: unknown[] = [];
        const leave = layer.onState('ws:t:0', (state) => heard.push(state));
        await layer.show('ws:t:0', 'moic.gen', BOX);
        await layer.show('ws:t:0', 'shop.gen', BOX);
        views()[1]!.emit('did-start-loading');
        expect(heard).toHaveLength(1);
        leave();
        views()[1]!.emit('did-stop-loading');
        expect(heard).toHaveLength(1);
describe('tabsChanged: when a panel may be closed for leaving its tabs', () => {
    // Batch SS on omarchy-test: Workspace mounts again before its settings arrive, so "no tabs yet" closed every page.
    it('a change in the same workspace', () => {
        expect(tabsChanged({ workspaceId: 'a', raw: '1' }, { workspaceId: 'a', raw: '2' })).toBe(true);
    });
    it.each([
        ['mounting, nothing seen yet', null, { workspaceId: 'a', raw: '1' }],
        ['the settings not here yet', { workspaceId: 'a', raw: '1' }, { workspaceId: 'a', raw: undefined }],
        ['nothing changed', { workspaceId: 'a', raw: '1' }, { workspaceId: 'a', raw: '1' }],
        ['another workspace, whose settings may not have arrived', { workspaceId: 'a', raw: '1' }, { workspaceId: 'b', raw: '1' }],
    ])('not %s', (_name, before, now) => {
        expect(tabsChanged(before, now)).toBe(false);
    });
});

describe('off screen and gone', () => {
    it('hidden keeps the page in the DOM, where it was', async () => {
        const { doc, views } = fakeDocument();
        const layer = siteWebviewLayer({ doc, prepare: yes });
        await layer.show('ws:t:0', 'moic.gen', BOX);
        layer.hide('ws:t:0');
        expect(views()[0]!.style.visibility).toBe('hidden');
        expect(views()[0]!.removed).toBeUndefined();
        expect(views()[0]!.appended).toBe(1);
    });

    it('a show still waiting on main when the panel left does not bring the page up', async () => {
        const { doc, views } = fakeDocument();
        let release: (v: { ok: true }) => void = () => {};
        const layer = siteWebviewLayer({ doc, prepare: () => new Promise((r) => { release = r; }) });
        const showing = layer.show('ws:t:0', 'moic.gen', BOX);
        layer.hide('ws:t:0');
        release({ ok: true });
        await showing;
        expect(views().filter((v) => v.style.visibility === 'visible')).toHaveLength(0);
    });

    it('a panel no longer in its workspace’s tabs closes; another workspace’s is untouched', async () => {
        const { doc, views } = fakeDocument();
        const layer = siteWebviewLayer({ doc, prepare: yes });
        await layer.show('ws:t:0', 'moic.gen', BOX);
        await layer.show('other:t:0', 'shop.gen', BOX);
        layer.retainIn('ws', new Set());
        expect(views()[0]!.removed).toBe(true);
        expect(views()[1]!.removed).toBeUndefined();
    });

    it('reload reloads that page', async () => {
        const { doc, views } = fakeDocument();
        const layer = siteWebviewLayer({ doc, prepare: yes });
        await layer.show('ws:t:0', 'moic.gen', BOX);
        layer.reload('ws:t:0');
        expect(views()[0]!.reload).toHaveBeenCalledTimes(1);
    });

    it('a page not ready to reload yet does not throw (Electron throws before dom-ready)', async () => {
        const { doc, views } = fakeDocument();
        const layer = siteWebviewLayer({ doc, prepare: yes });
        await layer.show('ws:t:0', 'moic.gen', BOX);
        views()[0]!.reload.mockImplementation(() => { throw new Error('The WebView must be attached to the DOM and the dom-ready event emitted'); });
        expect(() => layer.reload('ws:t:0')).not.toThrow();
    });
});

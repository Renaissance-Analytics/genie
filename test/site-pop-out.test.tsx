import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BrowserService, type BrowserEvent, type BrowserFacts } from '../src/main/browser-service.js';
import { SingleSiteWindow } from '../src/renderer/components/SingleSiteWindow.js';
import { SitePanel } from '../src/renderer/components/SitePanel.js';
import { siteWebviewLayer } from '../src/renderer/site-webview-layer.js';

/**
 * A SITE POPS OUT OF ITS PANEL, AND BACK (the host split, P2b; the owner, 2026-11-03: "a single site ux that can be popped
 * out (and back in) of the panel", the reload accepted and said in the UI). A page can't cross processes, so each way loads
 * fresh. The host holds which panels are out, so a window that comes back knows.
 */

const FACTS: BrowserFacts = { frontDoorPort: 4443, caPem: 'CA', hosts: ['moic.gen'], workspaceOf: { 'moic.gen': 'ws' }, launch: { file: 'Genie.exe', args: ['--genie-browser'] } };

function serviceWith() {
    const service = new BrowserService();
    const events: BrowserEvent[] = [];
    service.onEvent((event) => events.push(event));
    return { service, events };
}

describe('the host', () => {
    it('popping out opens the site alone in the browser, and remembers the panel', async () => {
        const { service, events } = serviceWith();
        await service.call('publish', [FACTS], 'window');
        await service.call('register', [], 'browser');
        await service.call('popOut', ['ws:t:0', 'moic.gen'], 'window');
        expect(events.at(-1)).toEqual({ kind: 'openSingle', panelKey: 'ws:t:0', url: 'https://moic.gen/' });
        expect(await service.call('popped', [], 'window')).toEqual([{ panelKey: 'ws:t:0', host: 'moic.gen' }]);
    });

    it('with no browser yet: held like any open, and the panel is out already', async () => {
        const { service, events } = serviceWith();
        await service.call('popOut', ['ws:t:0', 'moic.gen'], 'window');
        expect(events.filter((e) => e.kind === 'openSingle')).toEqual([]);
        await service.call('register', [], 'browser');
        expect(events.filter((e) => e.kind === 'openSingle')).toHaveLength(1);
    });

    it('back, from either side: the window closes, the panel hears, once', async () => {
        const { service, events } = serviceWith();
        await service.call('register', [], 'browser');
        await service.call('popOut', ['ws:t:0', 'moic.gen'], 'window');
        await service.call('popBack', ['ws:t:0'], 'browser');
        expect(events).toContainEqual({ kind: 'closeSingle', panelKey: 'ws:t:0' });
        expect(events).toContainEqual({ kind: 'poppedBack', panelKey: 'ws:t:0' });
        expect(await service.call('popped', [], 'window')).toEqual([]);
        const count = events.length;
        await service.call('popBack', ['ws:t:0'], 'window');
        expect(events).toHaveLength(count);
    });

    it('the browser going brings every panel back: nothing is left showing "in its own window"', async () => {
        const { service, events } = serviceWith();
        await service.call('register', [], 'browser');
        await service.call('popOut', ['ws:t:0', 'moic.gen'], 'window');
        service.dropped('browser');
        expect(events).toContainEqual({ kind: 'poppedBack', panelKey: 'ws:t:0' });
        expect(await service.call('popped', [], 'window')).toEqual([]);
    });

    it('CONTROL: the window going leaves it out: the browser outlives the window', async () => {
        const { service } = serviceWith();
        await service.call('publish', [FACTS], 'window');
        await service.call('register', [], 'browser');
        await service.call('popOut', ['ws:t:0', 'moic.gen'], 'window');
        service.dropped('window');
        expect(await service.call('popped', [], 'window2')).toEqual([{ panelKey: 'ws:t:0', host: 'moic.gen' }]);
    });

    it('a site name that isn’t one is refused', async () => {
        await expect(serviceWith().service.call('popOut', ['ws:t:0', 'evil.com/x'], 'window')).rejects.toThrow(/site/);
    });
});

describe('the layer', () => {
    const fakeDoc = () => {
        const views: Array<{ removed?: boolean; attrs: Record<string, string> }> = [];
        const make = (tag: string) => {
            const el = { tag, attrs: {} as Record<string, string>, style: {}, removed: false, setAttribute(n: string, v: string) { el.attrs[n] = v; }, appendChild() {}, remove() { el.removed = true; } };
            if (tag === 'webview') views.push(el);
            return el;
        };
        return { doc: { body: { appendChild() {} }, createElement: make } as never, views };
    };
    const BOX = { x: 1, y: 2, width: 30, height: 40 };

    it('out: its page closes, a show makes none, and it says so; back: the next show makes a fresh page', async () => {
        const { doc, views } = fakeDoc();
        const layer = siteWebviewLayer({ doc, prepare: async () => ({ ok: true }) });
        const heard: boolean[] = [];
        layer.onPopped('ws:t:0', (out) => heard.push(out));
        await layer.show('ws:t:0', 'moic.gen', BOX);
        layer.setPopped('ws:t:0', true);
        expect(views[0]!.removed).toBe(true);
        await layer.show('ws:t:0', 'moic.gen', BOX);
        expect(views).toHaveLength(1);
        expect(layer.isPopped('ws:t:0')).toBe(true);
        layer.setPopped('ws:t:0', false);
        await layer.show('ws:t:0', 'moic.gen', BOX);
        expect(views).toHaveLength(2);
        expect(heard).toEqual([true, false]);
    });

    it('a show on its way when it pops out does not bring the page up', async () => {
        const { doc, views } = fakeDoc();
        let release: (v: { ok: true }) => void = () => {};
        const layer = siteWebviewLayer({ doc, prepare: () => new Promise((r) => { release = r; }) });
        const showing = layer.show('ws:t:0', 'moic.gen', BOX);
        layer.setPopped('ws:t:0', true);
        release({ ok: true });
        await showing;
        expect(views).toHaveLength(0);
    });
});

describe('what a person sees', () => {
    const noop = () => {};
    const live = { panelKey: 'ws:t:0', onBounds: noop, onHide: noop, onReload: noop, onBack: noop, onForward: noop, onState: () => noop, onOpenInWindow: noop, popped: true, onPopBack: noop };

    it('a panel whose site is out says where it is, and offers it back, saying it reloads', () => {
        const html = renderToStaticMarkup(<SitePanel host="moic.gen" onPick={noop} live={live} />);
        expect(html).toContain('data-site-popped');
        expect(html).toContain('moic.gen');
        expect(html).not.toContain('data-site-panel-box');
        expect(html).toMatch(/data-site-action="pop-back"/);
        expect(html).toMatch(/reloads/i);
    });

    it('CONTROL: not out, the panel as ever', () => {
        expect(renderToStaticMarkup(<SitePanel host="moic.gen" onPick={noop} live={{ ...live, popped: false }} />)).toContain('data-site-panel-box');
    });

    it('its own window: the same bar, the way back, no tabs, and the door’s notice', () => {
        const tab = { id: 't', url: 'https://moic.gen/x', title: 'Moic', loading: false, canGoBack: true, canGoForward: false, error: null };
        const html = renderToStaticMarkup(<SingleSiteWindow snapshot={{ notice: 'Genie sites can’t load', tabs: [tab], active: 't', presetId: 'fit', presets: [], sites: [] }} onBack={noop} onForward={noop} onReload={noop} onPop={noop} />);
        expect(html).toContain('data-site-bar="window"');
        expect(html).toContain('moic.gen');
        expect(html).toContain('Back to the panel');
        expect(html).not.toContain('data-browser-tab');
        expect(html).toContain('data-browser-notice');
        expect(html).toContain('data-browser-page');
    });
});

describe('the wires', () => {
    const strip = (file: string) => readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');

    it('the browser opens it alone, and closing that window brings it back', () => {
        const src = strip('src/main/genie-browser-electron.ts');
        expect(src).toMatch(/openSingle\(/);
        expect(src).toMatch(/closeSingle\(/);
        expect(src).toMatch(/onSingleClosed/);
        expect(src).toMatch(/search: 'single=1'/);
    });

    it('the bar in a panel pops out through the host, not by opening a tab', () => {
        const workspace = strip('src/renderer/components/Workspace.tsx');
        expect(workspace).toMatch(/sitePanels\.popOut\(/);
    });
    void vi;
});

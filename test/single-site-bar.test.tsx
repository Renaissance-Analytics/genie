import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SingleSiteBar } from '../src/renderer/components/SingleSiteBar.js';

/**
 * THE GENIE BROWSER'S UX FOR ONE SITE (the host split, P2b; the owner, 2026-11-03: "a single site ux that can be popped
 * out (and back in) of the panel"). One bar, in a workspace tab's panel and in the browser's `--single` window: no tabs,
 * no other sites, and the site's name, its history, Reload, and the way to the other place.
 */

const noop = () => {};
const base = { host: 'moic.gen', state: { canGoBack: true, canGoForward: false, loading: false }, onBack: noop, onForward: noop, onReload: noop, onPop: noop };
const render = (over: Partial<Parameters<typeof SingleSiteBar>[0]> = {}) => renderToStaticMarkup(<SingleSiteBar {...base} where="panel" {...over} />);

describe('SingleSiteBar', () => {
    it('names the site and offers back, forward and reload', () => {
        const html = render();
        expect(html).toContain('moic.gen');
        for (const action of ['back', 'forward', 'reload', 'pop']) expect(html).toMatch(new RegExp(`data-site-action="${action}"`));
    });

    it('has no tabs and no list of other sites: it is the one site', () => {
        const html = render();
        expect(html).not.toContain('data-browser-tab');
        expect(html).not.toContain('data-browser-new-tab');
    });

    it('back and forward follow what the page can do', () => {
        const html = render();
        const tag = (action: string) => new RegExp(`<button[^>]*data-site-action="${action}"[^>]*>`).exec(html)?.[0] ?? '';
        // The attribute, not a `disabled:` class.
        expect(tag('forward')).toMatch(/\sdisabled(=|\s|>)/);
        expect(tag('back')).not.toMatch(/\sdisabled(=|\s|>)/);
    });

    it('while it loads, it shows so', () => {
        expect(render({ state: { ...base.state, loading: true } })).toContain('data-site-loading');
        expect(render()).not.toContain('data-site-loading');
    });

    it('in a panel it offers its own window, and says the page reloads there', () => {
        const html = render({ where: 'panel' });
        expect(html).toMatch(/data-site-action="pop"[^>]*>[\s\S]*?Pop out/);
        expect(html).toMatch(/title="[^"]*reloads/i);
    });

    it('in its own window it offers the way back, and says the same', () => {
        const html = render({ where: 'window' });
        expect(html).toMatch(/data-site-action="pop"[^>]*>[\s\S]*?Back to the panel/);
        expect(html).toMatch(/title="[^"]*reloads/i);
    });

    it('its actions are real buttons', () => {
        expect(render()).toMatch(/<button[^>]*data-site-action="reload"/);
    });
});

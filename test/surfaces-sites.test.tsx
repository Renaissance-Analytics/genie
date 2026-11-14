import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AddSiteForm } from '../src/renderer/components/AddForms.js';
import { HostingSurface, SiteRow } from '../src/renderer/components/FeatureSurfaces.js';
import { RowMenu } from '../src/renderer/components/RowMenu.js';
import { EMPTY_FEATURES, type FeatureAction, type FeatureData, type HostedSite, type SiteEditing } from '../src/renderer/features.js';
import type { SiteInfo } from '../src/main/site-manager.js';

/**
 * THE SITES TAB OVER DECLARED SITES (§6.6) — every site a workspace's envelope declares is a row. A running
 * one offers Stop; one that is listed but not running (disabled, its workspace asleep, stopped by you)
 * offers Start; one Genie 2 cannot serve says WHY and offers nothing to click. A site never started shows
 * no port rather than a made-up one.
 */

const site = (over: Partial<SiteInfo> & Pick<SiteInfo, 'id' | 'host' | 'state'>): SiteInfo =>
    ({ name: over.host.replace(/\.gen$/, ''), workspaceId: 'acme', repoPath: '/w/acme', serve: { mode: 'proxy' }, port: null, processIds: [], problem: null, ...over }) as SiteInfo;

const render = (sites: HostedSite[], editing: SiteEditing | null = null) =>
    renderToStaticMarkup(<HostingSurface data={{ ...EMPTY_FEATURES, hosting: { sites, processes: [], adding: null, editing, frontDoor: { running: false, reason: 'off' } } } as FeatureData} onAction={() => {}} onNavigate={() => {}} />);

/** The buttons in the markup, in order, by name: an icon control's label, else its text (genie#1393: icons over words). */
const buttons = (rowHtml: string) => [...rowHtml.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => /aria-label="([^"]*)"/.exec(m[1]!)?.[1] ?? (/data-react-fancy-button-label="[^"]*"[^>]*>([^<]*)</.exec(m[2]!)?.[1] ?? /^([^<]*)$/.exec(m[2]!)?.[1] ?? '').trim());

const row = (html: string, id: string) => {
    const m = new RegExp(`<li[^>]*data-site="${id}"[^>]*>([\\s\\S]*?)</li>`).exec(html);
    expect(m, `a row for ${id}`).not.toBeNull();
    return m![1]!;
};

describe('the Sites tab', () => {
    const html = render([
        site({ id: 'site_shop', host: 'shop.gen', state: 'running', port: 4101, processIds: ['site_shop'] }),
        site({ id: 'site_docs', host: 'docs.gen', state: 'stopped' }),
        site({ id: 'site_acme_aaaa000000000005', host: 'wallet.gen', state: 'unservable', serve: null, problem: 'it runs inside the workspace container (runMode "explicit"); Genie 2 serves sites host-native only, so it is not started here' }),
    ]);

    it('a running site shows its port and offers Open and Stop as icons — Restart, Edit and Remove (behind a confirm) wait in its menu', () => {
        const r = row(html, 'site_shop');
        expect(r).toContain('127.0.0.1:4101');
        expect(buttons(r)).toEqual(['Open', 'Stop', 'More actions']);
        expect(buttons(r)).not.toContain('Start');
    });

    it('a listed site that is not running offers Start (nothing to Open or Stop), and no port it does not have', () => {
        const r = row(html, 'site_docs');
        expect(buttons(r)).toEqual(['Start', 'More actions']);
        expect(buttons(r)).not.toContain('Stop');
        expect(r).not.toContain('127.0.0.1:');
    });

    it('a site Genie 2 cannot serve says why, with nothing to click', () => {
        const r = row(html, 'site_acme_aaaa000000000005');
        expect(r).toContain('data-site-problem');
        expect(r).toMatch(/host-native only/);
        expect(r).not.toMatch(/<button/);
    });
});

/** Every element in a hook-free component's output, depth first — so a test can press a button without a DOM. */
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!isValidElement(node)) return [];
    const el = node as ReactElement<Record<string, unknown>>;
    return [el, ...elements(el.props.children as ReactNode)];
}

/** Press the row's control named `action` (an icon button, or an entry in its "⋯" menu): what the row asked main to do. */
function press(s: HostedSite, action: string, editing: SiteEditing | null = null): FeatureAction[] {
    const sent: FeatureAction[] = [];
    const tree = elements(SiteRow({ site: s, editing, onAction: (a) => sent.push(a) }));
    const control = tree.find((e) => e.props['data-site-action'] === action);
    if (control) { (control.props.onClick as () => void)(); return sent; }
    const menu = tree.find((e) => e.type === RowMenu);
    const item = (menu?.props.items as { id: string }[] | undefined)?.find((i) => i.id === action);
    expect(item, `a ${action} control or menu entry`).toBeDefined();
    (menu!.props.onRun as (i: unknown) => void)(item);
    return sent;
}

describe('S6: the site row’s controls are WIRED — each sends the action hosting-actions.ts serves', () => {
    const running = site({ id: 'site_web.example', host: 'web.example.gen', state: 'running', port: 4101, processIds: ['site_web.example'] });
    const stopped = site({ id: 'site_docs', host: 'docs.gen', state: 'stopped' });

    it('Open, Restart, Stop, Edit and Remove each send their own action for THIS site — counted, one action per press', () => {
        const sent = ['open', 'restart', 'stop', 'edit', 'remove'].map((a) => press(running, a));
        expect(sent).toEqual([
            [{ kind: 'hosting.openSite', siteId: 'site_web.example' }],
            [{ kind: 'hosting.restartSite', siteId: 'site_web.example' }],
            [{ kind: 'hosting.stopSite', siteId: 'site_web.example' }],
            [{ kind: 'hosting.editSite', siteId: 'site_web.example' }],
            [{ kind: 'hosting.removeSite', siteId: 'site_web.example' }],
        ]);
        expect(press(stopped, 'start')).toEqual([{ kind: 'hosting.startSite', siteId: 'site_docs' }]);
    });

    it('a server you run yourself (external) can be opened and stopped but has no Restart — Genie runs no process for it', () => {
        const r = row(render([site({ id: 'site_ext', host: 'ext.gen', state: 'external', port: 5173 })]), 'site_ext');
        expect(buttons(r)).toEqual(['Open', 'Stop', 'More actions']);
        const items = (elements(SiteRow({ site: site({ id: 'site_ext', host: 'ext.gen', state: 'external', port: 5173 }), editing: null, onAction: () => {} })).find((e) => e.type === RowMenu)!.props.items as { id: string }[]).map((i) => i.id);
        expect(items).toEqual(['edit', 'remove']);
    });

    it('Remove is the menu\'s last entry, red, behind a confirm that says what it does: naming project.json and that the folder is untouched', () => {
        const r = row(render([running]), 'site_web.example');
        // Nothing to press on the line itself.
        expect(r).not.toContain('data-site-remove');
        expect(r).not.toMatch(/Remove/);
        const items = elements(SiteRow({ site: running, editing: null, onAction: () => {} })).find((e) => e.type === RowMenu)!.props.items as { id: string; danger?: boolean; confirm?: { body: string; confirmLabel: string } }[];
        const last = items[items.length - 1]!;
        expect(last.id).toBe('remove');
        expect(last.danger).toBe(true);
        expect(last.confirm!.body).toMatch(/Remove web\.example\.gen\? It is stopped and taken out of this workspace’s project\.json\. Its folder and files are not touched\./);
        expect(last.confirm!.confirmLabel).toBe('Remove site');
    });

    it('Logs: each of the site’s processes’ output under the row, expandable, its line count and cut said — the Processes row’s pattern', () => {
        const text = ['[genie] started (pid 4001): php-cgi -b 127.0.0.1:4102', 'PHP Fatal error: Uncaught PDOException'].join('\n');
        const logged: HostedSite = {
            ...running,
            processIds: ['site_web.example', 'site_web.example-fcgi'],
            logs: [
                { processId: 'site_web.example', name: 'web.example.gen server', state: 'running', text: '[genie] started (pid 4000): caddy run', lines: 1, dropped: 0 },
                { processId: 'site_web.example-fcgi', name: 'web.example.gen php worker', state: 'running', text, lines: 2, dropped: 7 },
            ],
        };
        const r = row(render([logged]), 'site_web.example');
        expect(r.match(/data-site-log="/g) ?? []).toHaveLength(2);
        expect(r).toMatch(/Logs · web\.example\.gen php worker · last 2 lines \(earlier output was cut\)/);
        expect(r).toMatch(/Logs · web\.example\.gen server · last 1 line</);
        expect(r).toContain('PHP Fatal error: Uncaught PDOException');
        // Control: a row with no logs has no Logs.
        expect(row(render([running]), 'site_web.example')).not.toContain('data-site-log');
    });

    it('Edit: the Add form opens IN the row, prefilled with the site as declared, as `edit-site` with Save; its problems shown; Save sends hosting.updateSite', () => {
        const editing: SiteEditing = { siteId: 'site_web.example', host: 'web.example.gen', defaults: { name: 'web.example', mode: 'static', devServer: null, hostPort: null, root: 'dist', spa: true }, problems: [{ field: 'root', message: 'A static site needs the built directory to serve (for example dist).' }] };
        const r = row(render([running], editing), 'site_web.example');
        expect(r).toContain('data-form="edit-site"');
        expect(r).toContain('value="web.example"');
        expect(r).toContain('value="dist"');
        expect(r).toContain('data-problem="root"');
        expect(r).toMatch(/>Save</);
        // While it is open there is no second Edit button.
        expect(buttons(r)).not.toContain('Edit');
        // The other rows are not in edit.
        expect(render([running, stopped], editing).match(/data-form="edit-site"/g) ?? []).toHaveLength(1);

        const sent: FeatureAction[] = [];
        const form = elements(SiteRow({ site: running, editing, onAction: (a) => sent.push(a) })).find((e) => e.type === AddSiteForm)!;
        expect(form.props.formId).toBe('edit-site');
        (form.props.onSubmit as (f: unknown) => void)({ name: 'app.example', mode: 'proxy', command: 'npm run dev -- --port {port}', hostPort: null, root: null, spa: false });
        (form.props.onCancel as () => void)();
        expect(sent).toEqual([
            { kind: 'hosting.updateSite', siteId: 'site_web.example', form: { name: 'app.example', mode: 'proxy', devServer: { stack: 'node', command: 'npm run dev -- --port {port}' }, hostPort: null, root: null, spa: false } },
            { kind: 'hosting.cancelForm' },
        ]);
    });
});

describe('T4: Edit carries a php site’s PHP pin', () => {
    const shop = site({ id: 'site_shop', host: 'shop.gen', state: 'running', port: 4102, processIds: ['site_shop-fcgi', 'site_shop'], serve: { mode: 'php', root: 'public', version: '8.4' } as SiteInfo['serve'] });
    const editing = { siteId: 'site_shop', host: 'shop.gen', defaults: { name: 'shop', mode: 'php', devServer: null, hostPort: null, root: 'public', spa: false, phpVersion: '8.4' }, problems: [], phpVersions: ['8.5.11', '8.4.26'] } as SiteEditing;

    it('the Edit form is given the versions Add offers and opens ON the pin (a line pin named as the newest managed one, never "not installed")', () => {
        const r = row(render([shop], editing), 'site_shop');
        expect(r).toContain('data-php-version-select');
        expect(r.match(/<option value="8\.5\.11">PHP 8\.5\.11 — managed by Genie<\/option>/g) ?? []).toHaveLength(1);
        expect(r.match(/<option value="8\.4" selected="">PHP 8\.4 — the newest 8\.4 Genie manages<\/option>/g) ?? []).toHaveLength(1);
        expect(r).not.toContain('not installed');
        const form = elements(SiteRow({ site: shop, editing, onAction: () => {} })).find((e) => e.type === AddSiteForm)!;
        expect(form.props.phpVersions).toEqual(['8.5.11', '8.4.26']);
    });

    it('Save sends the pin back — kept when the person changed something else, the new one when they changed it, none for a non-php mode', () => {
        const sent: FeatureAction[] = [];
        const form = elements(SiteRow({ site: shop, editing, onAction: (a) => sent.push(a) })).find((e) => e.type === AddSiteForm)!;
        const submit = form.props.onSubmit as (f: unknown) => void;
        submit({ name: 'store', mode: 'php', command: '', hostPort: null, root: 'public', spa: false, phpVersion: '8.4' });
        submit({ name: 'shop', mode: 'php', command: '', hostPort: null, root: 'public', spa: false, phpVersion: '8.5.11' });
        submit({ name: 'shop', mode: 'static', command: '', hostPort: null, root: 'dist', spa: false, phpVersion: '8.4' });
        expect(sent.map((a) => (a.kind === 'hosting.updateSite' ? a.form : null))).toEqual([
            { name: 'store', mode: 'php', devServer: null, hostPort: null, root: 'public', spa: false, phpVersion: '8.4' },
            { name: 'shop', mode: 'php', devServer: null, hostPort: null, root: 'public', spa: false, phpVersion: '8.5.11' },
            { name: 'shop', mode: 'static', devServer: null, hostPort: null, root: 'dist', spa: false },
        ]);
    });
});

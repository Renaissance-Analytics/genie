// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceInstance } from '../src/core/services.js';
import { AddProcessForm } from '../src/renderer/components/AddForms.js';
import { EngineChoices, HostingSurface, ProcessesPanel } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureAction, type FeatureData, type HostedSite } from '../src/renderer/features.js';
import { buttonTexts } from './helpers/control-markup.js';

/**
 * THE HOSTING PAGES, CALMED (Tynn #708). The owner: service names in large monospace that wrap, five or six worded buttons
 * on every row whose labels wrap, "Detach … (keeps its data)" repeated down the In use list, a raw add form of mismatched
 * inputs above the processes, and Stop / Restart on a second line.
 *
 * Wanted, and asserted here: the app's own type (monospace only for a port or a command, small); ONE line per row: name,
 * workspace and status as badges, the port, the primary action as an icon button, and everything else in a "⋯" menu, the
 * destructive ones last, red, behind a confirm; In use as a table; "Add process" opening a form of labelled fields.
 * What each menu holds is in hosting-rows-708.test.ts; this file is what is on the page and what pressing it does.
 */

const frontDoor = { running: false as const, reason: 'off' };
const workspaces = [{ id: 'tynn', path: '/w/tynn', name: 'Tynn' }];
const pg: ServiceInstance = { id: 'svc_pg18', engine: 'postgres', version: '18', scope: { kind: 'dedicated', workspaceId: 'tynn' }, publishedPort: 54318, credentials: {}, active: true };
const mailpit: ServiceInstance = { id: 'svc_mail', engine: 'mailpit', version: '1.30', scope: { kind: 'shared' }, publishedPort: 4101, credentials: {}, active: true, publishedPorts: { ui: 4102 } };
const data = (over: { sites?: HostedSite[]; processes?: unknown[]; instances?: { instance: ServiceInstance; status: 'running' | 'exited' }[] } = {}): FeatureData => ({
    ...EMPTY_FEATURES,
    hosting: { sites: over.sites ?? [], processes: (over.processes ?? []) as never, adding: null, frontDoor },
    services: { instances: over.instances ?? [], adding: null },
});
const render = (tab: 'sites' | 'processes' | 'services', d: FeatureData) =>
    renderToStaticMarkup(<HostingSurface data={d} onAction={() => {}} onNavigate={() => {}} tab={tab} workspaces={workspaces} />);
const rowOf = (html: string, attr: string) => {
    const start = html.indexOf(attr);
    expect(start, attr).toBeGreaterThan(-1);
    return html.slice(html.lastIndexOf('<li', start), html.indexOf('</li>', start));
};
const words = (html: string) => { let text = html; for (let prev = ''; prev !== text;) { prev = text; text = text.replace(/<[^>]*>/g, ''); } return text.replace(/\s+/g, ' ').trim(); };
const labels = (html: string) => [...html.matchAll(/<button\b[^>]*>/g)].map((m) => /aria-label="([^"]*)"/.exec(m[0])?.[1] ?? '');

describe('Services: one line per engine', () => {
    const html = render('services', data({ instances: [{ instance: pg, status: 'running' }, { instance: mailpit, status: 'running' }] }));
    const pgRow = rowOf(html, 'data-service="svc_pg18"');
    const mailRow = rowOf(html, 'data-service="svc_mail"');

    it('the name is in the app’s own type; only the port is monospace', () => {
        expect(pgRow).toMatch(/postgres 18/);
        expect(pgRow).not.toMatch(/font-mono[^"]*"[^>]*>[^<]*postgres/);
        expect(pgRow).toMatch(/font-mono[^"]*"[^>]*>[^<]*127\.0\.0\.1:54318/);
    });
    it('workspace and status are badges beside the name', () => {
        expect(pgRow.match(/data-react-fancy-badge/g)!.length).toBeGreaterThanOrEqual(2);
        expect(words(pgRow)).toMatch(/Tynn/);
        expect(words(pgRow)).toMatch(/running/);
    });
    it('the primary action is an icon button and the rest is behind one "More actions" button — no worded buttons to wrap', () => {
        expect(labels(pgRow)).toEqual(['Stop', 'More actions']);
        expect(buttonTexts(pgRow).every((t) => t === '')).toBe(true);
        expect(labels(mailRow)).toEqual(['Open inbox', 'Stop', 'More actions']);
        for (const gone of ['Remove (keep data)', 'Remove and delete data', 'Update image', 'Make active']) expect(words(pgRow)).not.toContain(gone);
    });
    it('shows no internal id', () => {
        expect(words(pgRow)).not.toMatch(/svc_/);
    });
});

describe('In use is a table', () => {
    const WS = 'example';
    const shared: ServiceInstance = { id: 'svc_v1_postgres-17', engine: 'postgres', version: '17', scope: { kind: 'shared' }, publishedPort: 2, credentials: {}, active: true, adopted: 'v1', slices: { [WS]: { identifier: 'ws', password: 'y', active: true } } };
    const html = renderToStaticMarkup(<EngineChoices instances={[shared]} workspaces={[{ id: WS, path: '/w/example' }]} onAction={() => {}} />);

    it('columns workspace, service, version; a row for the workspace; no Detach sentence on the line', () => {
        expect(html).toContain('<table');
        expect(words(html.slice(html.indexOf('<thead'), html.indexOf('</thead>')))).toMatch(/Workspace.*Service.*Version/);
        expect(words(html.slice(html.indexOf('<tbody')))).toMatch(/example.*postgres.*17/);
        expect(words(html)).not.toMatch(/Detach/);
        expect(words(html)).not.toMatch(/keeps its data/);
    });
    it('Detach is in the row menu', () => {
        expect(labels(html)).toEqual(['More actions']);
    });
});

describe('Processes: one line per process, and an Add process form that opens on request', () => {
    const row = (over: Record<string, unknown>) => ({ id: 'p1', workspaceId: 'tynn', name: 'queue worker', state: 'running', pid: 4001, exitCode: null, restarts: 0, since: 1, durable: true, command: 'php artisan queue:work', ...over });
    const html = render('processes', data({ processes: [row({})] }));
    const r = rowOf(html, 'data-process="p1"');

    it('Stop is the icon button, the command is small monospace, Restart waits in the menu', () => {
        expect(labels(r)).toEqual(['Stop', 'More actions']);
        expect(buttonTexts(r).every((t) => t === '')).toBe(true);
        expect(r).toMatch(/font-mono[^"]*"[^>]*>php artisan queue:work/);
        expect(r).not.toMatch(/font-mono[^"]*"[^>]*>[^<]*queue worker/);
        expect(words(r)).not.toContain('Restart');
    });
    it('there is no raw form above the list: only an "Add process" button', () => {
        expect(html).not.toContain('data-form="add-process"');
        expect(html).not.toContain('placeholder="Name (queue worker)"');
        const add = /<button\b[^>]*data-action="add-process"[^>]*>/.exec(html);
        expect(add, 'an Add process button').not.toBeNull();
        expect(html).toMatch(/data-action="add-process"[\s\S]{0,400}Add process/);
    });
    it('a service command keeps only its Stop, with no menu', () => {
        const run = rowOf(render('processes', data({ processes: [row({ id: 'command-1', commandRun: true })] })), 'data-process="command-1"');
        expect(labels(run)).toEqual(['Stop']);
    });
});

describe('the Add process form', () => {
    const html = renderToStaticMarkup(<AddProcessForm workspaces={[{ id: 'tynn', path: '/w/tynn', name: 'Tynn' }, { id: 'other', path: '/w/other', name: 'Other' }]} onSubmit={() => {}} onCancel={() => {}} />);

    it('every field has a visible label, and the fields are the ones a process needs', () => {
        for (const label of ['Workspace', 'Name', 'Command', 'Folder', 'Restart', 'Schedule']) expect(html, label).toMatch(new RegExp(`<label[^>]*>[\\s\\S]*?${label}[\\s\\S]*?</label>`));
        for (const field of ['workspace', 'name', 'command', 'folder', 'restart', 'schedule']) expect(html).toContain(`name="${field}"`);
        expect(html).toContain('data-form="add-process"');
        expect(words(html)).toMatch(/Add process/);
        expect(words(html)).toMatch(/Cancel/);
    });
});

describe('pressing it (happy-dom)', () => {
    let host: HTMLDivElement; let root: Root; let sent: FeatureAction[];
    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); sent = [];
    });
    afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; });

    const mount = (tab: 'processes' | 'services', d: FeatureData) => act(() => root.render(<HostingSurface data={d} onAction={(a) => { sent.push(a); }} onNavigate={() => {}} tab={tab} workspaces={workspaces} />));
    const pressed = (el: Element | null | undefined) => { expect(el).toBeTruthy(); act(() => (el as HTMLElement).click()); };

    it('the row menu lists its actions with the destructive ones last; Remove asks first and only then sends', () => {
        mount('services', data({ instances: [{ instance: pg, status: 'running' }] }));
        pressed(host.querySelector('[data-service="svc_pg18"] button[aria-label="More actions"]'));
        const items = [...document.body.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent!.trim());
        expect(items.length).toBe(4);
        expect(items.slice(-2).join(' ')).toMatch(/Remove.*delete/);
        expect(items[0]).toMatch(/Logs/);
        pressed([...document.body.querySelectorAll('[role="menuitem"]')][2]);
        expect(sent, 'nothing is sent before the confirm').toEqual([]);
        const confirm = document.body.querySelector('[data-row-confirm]');
        expect(confirm, 'a confirm').toBeTruthy();
        expect(confirm!.textContent).toMatch(/keep/i);
        pressed(document.body.querySelector('[data-row-confirm-yes]'));
        expect(sent).toEqual([{ kind: 'services.remove', serviceId: 'svc_pg18', deleteData: false }]);
    });

    it('the primary icon button acts at once', () => {
        mount('services', data({ instances: [{ instance: pg, status: 'running' }] }));
        pressed(host.querySelector('[data-service="svc_pg18"] button[aria-label="Stop"]'));
        expect(sent).toEqual([{ kind: 'services.stop', serviceId: 'svc_pg18' }]);
    });

    it('Add process opens the labelled form in a modal; submitting it sends the new process', () => {
        mount('processes', data());
        expect(document.body.querySelector('[data-form="add-process"]')).toBeNull();
        pressed(host.querySelector('[data-action="add-process"]'));
        const form = document.body.querySelector<HTMLFormElement>('[data-form="add-process"]');
        expect(form, 'the form opened').toBeTruthy();
        const set = (name: string, value: string) => { (form!.querySelector(`[name="${name}"]`) as HTMLInputElement).value = value; };
        set('name', 'queue worker'); set('command', 'php artisan queue:work');
        act(() => { form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
        expect(sent).toEqual([expect.objectContaining({ kind: 'hosting.createProcess', workspaceId: 'tynn', name: 'queue worker', command: 'php artisan queue:work', restart: 'on-failure' })]);
    });

    it('the ProcessesPanel still takes the same props (no extra wiring for the form)', () => {
        const spy = vi.fn();
        expect(() => renderToStaticMarkup(<ProcessesPanel processes={[]} workspaces={workspaces} onAction={spy} />)).not.toThrow();
    });
});

describe('Sites: the same calm row', () => {
    const site = { id: 'site_web', name: 'web', host: 'web.example.gen', workspaceId: 'tynn', repoPath: '/w/tynn', serve: { mode: 'proxy' }, port: 4101, state: 'running', processIds: ['site_web'], problem: null } as unknown as HostedSite;
    const r = rowOf(render('sites', data({ sites: [site] })), 'data-site="site_web"');

    it('Open and Stop are icon buttons, the rest is in the menu, and the host is not monospace', () => {
        expect(labels(r)).toEqual(['Open', 'Stop', 'More actions']);
        expect(buttonTexts(r).every((t) => t === '')).toBe(true);
        expect(r).not.toMatch(/font-mono[^"]*"[^>]*>web\.example\.gen/);
        expect(r).toMatch(/font-mono[^"]*"[^>]*>127\.0\.0\.1:4101/);
    });
    it('the workspace is a badge; no "Remove…" disclosure is left on the row', () => {
        expect(words(r)).toMatch(/Tynn/);
        expect(r).toMatch(/data-react-fancy-badge/);
        expect(r).not.toContain('data-site-remove');
        expect(words(r)).not.toContain('Remove');
    });
});

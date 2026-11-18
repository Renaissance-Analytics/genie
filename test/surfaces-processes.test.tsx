import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HostingSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';

/**
 * HOSTING → PROCESSES, the surface half. The tab could only list what the supervisor happened to
 * be running and offer Restart: there was no way to ADD a background process, and none to stop,
 * start or remove one the person keeps. Now:
 * - the tab carries an "Add process" button that opens a form of labelled fields (workspace, name, command, optional folder,
 *   restart policy), Tynn #708;
 * - a kept process that is running offers Stop (an icon button) and, in the row menu, Restart; one that is stopped offers
 *   Start and, in the menu, Remove (what each menu holds is in hosting-rows-708.test.ts);
 * - a site's process (not kept here) is never offered Remove — it goes with its site;
 * - the row shows the command it runs, and a held-back row says why.
 */

const frontDoor = { running: false as const, reason: 'this install has no bundled Caddy; https://<name>.gen in external browsers is off, the in-app browser still works' };
const row = (over: Record<string, unknown>) => ({ id: 'p1', workspaceId: 'tynn', name: 'queue', state: 'running', pid: 4001, exitCode: null, restarts: 0, since: 1, ...over });
const data = (processes: unknown[]): FeatureData => ({ ...EMPTY_FEATURES, hosting: { sites: [], processes: processes as never, adding: null, frontDoor } });
const render = (d: FeatureData) => renderToStaticMarkup(<HostingSurface data={d} onAction={() => {}} onNavigate={() => {}} tab="processes" workspaces={[{ id: 'tynn', path: '/w/tynn' }]} />);

/** The buttons in one row's markup, by their accessible name (icons, not words). */
function buttonsOf(html: string, id: string): string[] {
    const start = html.indexOf(`data-process="${id}"`);
    expect(start).toBeGreaterThan(-1);
    const end = html.indexOf('</li>', start);
    return [...html.slice(start, end).matchAll(/<button\b[^>]*>/g)].map((m) => /aria-label="([^"]*)"/.exec(m[0])?.[1] ?? '');
}

describe('the Processes tab', () => {
    it('offers an "Add process" button; its form (name, command, an optional folder, the restart policy) is tested in hosting-ui-708.test.tsx', () => {
        const html = render(data([]));
        expect(html).toContain('data-action="add-process"');
        expect(html).not.toContain('data-form="add-process"');
        expect(html).toMatch(/Add process/);
        expect(html).toMatch(/No background processes yet/);
    });

    it('a kept process that is running offers Stop and Restart, and shows its command', () => {
        const html = render(data([row({ durable: true, command: 'php artisan queue:work' })]));
        expect(buttonsOf(html, 'p1')).toEqual(['Stop', 'More actions', 'Log']);
        expect(html).toContain('php artisan queue:work');
    });

    it('a kept process that is stopped offers Start and Remove, and a held-back one says why', () => {
        const html = render(data([row({ state: 'stopped', pid: null, durable: true, command: 'npm run watch', reason: 'its workspace is hibernated; nothing starts there until it is woken' })]));
        expect(buttonsOf(html, 'p1')).toEqual(['Start', 'More actions', 'Log']);
        expect(html).toMatch(/hibernated/);
    });

    it('a crashed process shows its log under the row — the output, Genie’s line about the crash, the line count — and the row’s actions are unchanged', () => {
        const text = ['[genie] started (pid 4001): php artisan queue:work', 'PDOException: could not connect', '[genie] exited with code 1; gave up after 5 consecutive failures'].join('\n');
        const html = render(data([row({ state: 'failed', pid: null, exitCode: 1, durable: true, command: 'php artisan queue:work', log: { text, lines: 3, dropped: 0 } })]));
        const start = html.indexOf('data-process-log="p1"');
        expect(start).toBeGreaterThan(html.indexOf('data-process="p1"'));
        expect(start).toBeLessThan(html.indexOf('</li>', html.indexOf('data-process="p1"')));
        expect(html).toMatch(/Log · last 3 lines/);
        expect(html).toContain('PDOException: could not connect');
        expect(html).toContain('[genie] exited with code 1; gave up after 5 consecutive failures');
        expect(buttonsOf(html, 'p1')).toEqual(['Start', 'More actions', 'Log']);
    });

    it('a log the bound has cut says so; a row with no output draws no log (control)', () => {
        const cut = render(data([row({ log: { text: 'line 2001', lines: 1, dropped: 2000 } })]));
        expect(cut).toMatch(/Log · last 1 line \(earlier output was cut\)/);
        const none = render(data([row({ durable: true, command: 'npm run watch' })]));
        expect(none).not.toContain('data-process-log');
        expect(buttonsOf(none, 'p1')).toEqual(['Stop', 'More actions', 'Log']);
    });

    it('a site’s process is never offered Remove — it goes with its site', () => {
        const html = render(data([row({ id: 'site:docs', name: 'docs dev server' }), row({ id: 'site:api', name: 'api dev server', state: 'exited', pid: null, exitCode: 1 })]));
        expect(buttonsOf(html, 'site:docs')).toEqual(['Stop', 'More actions', 'Log']);
        expect(buttonsOf(html, 'site:api')).toEqual(['Restart', 'Log']);
    });
});

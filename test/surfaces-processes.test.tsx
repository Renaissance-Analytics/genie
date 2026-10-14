import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HostingSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';

/**
 * HOSTING → PROCESSES, the surface half. The tab could only list what the supervisor happened to
 * be running and offer Restart: there was no way to ADD a background process, and none to stop,
 * start or remove one the person keeps. Now:
 * - the tab carries an "Add a process" form (workspace, name, command, optional folder, restart policy);
 * - a kept process that is running offers Stop and Restart; one that is stopped offers Start and Remove;
 * - a site's process (not kept here) is never offered Remove — it goes with its site;
 * - the row shows the command it runs, and a held-back row says why.
 */

const frontDoor = { running: false as const, reason: 'this install has no bundled Caddy; https://<name>.gen in external browsers is off, the in-app browser still works' };
const row = (over: Record<string, unknown>) => ({ id: 'p1', workspaceId: 'tynn', name: 'queue', state: 'running', pid: 4001, exitCode: null, restarts: 0, since: 1, ...over });
const data = (processes: unknown[]): FeatureData => ({ ...EMPTY_FEATURES, hosting: { sites: [], processes: processes as never, adding: null, frontDoor } });
const render = (d: FeatureData) => renderToStaticMarkup(<HostingSurface data={d} onAction={() => {}} onNavigate={() => {}} tab="processes" workspaces={[{ id: 'tynn', path: '/w/tynn' }]} />);

/** The buttons in one row's markup, by their text. */
function buttonsOf(html: string, id: string): string[] {
    const start = html.indexOf(`data-process="${id}"`);
    expect(start).toBeGreaterThan(-1);
    const end = html.indexOf('</li>', start);
    return [...html.slice(start, end).matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]!);
}

describe('the Processes tab', () => {
    it('offers an "Add a process" form: name, command, an optional folder inside the workspace, and the restart policy', () => {
        const html = render(data([]));
        expect(html).toContain('data-form="add-process"');
        for (const field of ['name', 'command', 'folder', 'restart']) expect(html).toContain(`name="${field}"`);
        for (const policy of ['on-failure', 'always', 'never']) expect(html).toContain(`value="${policy}"`);
        expect(html).toMatch(/Add a process/);
        expect(html).toMatch(/No background processes yet/);
    });

    it('a kept process that is running offers Stop and Restart, and shows its command', () => {
        const html = render(data([row({ durable: true, command: 'php artisan queue:work' })]));
        expect(buttonsOf(html, 'p1')).toEqual(['Stop', 'Restart']);
        expect(html).toContain('php artisan queue:work');
    });

    it('a kept process that is stopped offers Start and Remove, and a held-back one says why', () => {
        const html = render(data([row({ state: 'stopped', pid: null, durable: true, command: 'npm run watch', reason: 'its workspace is hibernated; nothing starts there until it is woken' })]));
        expect(buttonsOf(html, 'p1')).toEqual(['Start', 'Remove']);
        expect(html).toMatch(/hibernated/);
    });

    it('a site’s process is never offered Remove — it goes with its site', () => {
        const html = render(data([row({ id: 'site:docs', name: 'docs dev server' }), row({ id: 'site:api', name: 'api dev server', state: 'exited', pid: null, exitCode: 1 })]));
        expect(buttonsOf(html, 'site:docs')).toEqual(['Stop', 'Restart']);
        expect(buttonsOf(html, 'site:api')).toEqual(['Restart']);
    });
});

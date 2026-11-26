import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { hostDirectory } from '../src/core/host-directory.js';
import { WINDOW_PAGES } from '../src/main/window-pages.js';
import { HostDirectoryScreen } from '../src/renderer/components/HostDirectoryScreen.js';

/*
 * THE HOST DIRECTORY'S SCREEN (Tynn #1058 L4): what a client with no host to link to shows, in Genie's own design system
 * (react-fancy, the app's tokens). Hook-free, so it is drawn here with no window.
 */
const draw = (view: ReturnType<typeof hostDirectory>, busy: string | null = null) => renderToStaticMarkup(<HostDirectoryScreen view={view} busy={busy} onAction={() => {}} />);

describe('the screen', () => {
    it('empty: the empty state in its words, and Add a host', () => {
        const html = draw(hostDirectory({ profile: 'client', local: { kind: 'none' }, paired: [], launcher: false }));
        expect(html).toContain('data-host-directory=""');
        expect(html).toContain('No host on this computer. Pick a host, or add one.');
        expect(html).toContain('data-action="add-host"');
        expect(html).not.toContain('data-host-row');
    });

    it('a stopped local host: its row, stopped, with Start; Start busy while the launcher starts it', () => {
        const view = hostDirectory({ profile: 'both', local: { kind: 'stopped', build: '2026.11.26-1' }, paired: [], launcher: true });
        const html = draw(view);
        expect(html).toContain('data-host-row="local"');
        expect(html).toContain('data-host-state="stopped"');
        expect(html).toContain('data-action="start"');
        expect(html).not.toContain('No host on this computer.');
        expect(draw(view, 'local')).toMatch(/data-action="start"[^>]*disabled/);
    });

    it('paired hosts: one row each, by name and address, with why they cannot open yet', () => {
        const html = draw(hostDirectory({ profile: 'client', local: { kind: 'none' }, paired: ['wss://studio.example:7443', 'ws://10.0.0.5:7443'], launcher: false }));
        expect(html.match(/data-host-row="/g)).toHaveLength(2);
        expect(html).toContain('studio.example');
        expect(html).toContain('wss://studio.example:7443');
    });
});

describe('its page', () => {
    it('is a window page of its own, built from host-directory.html, loading the screen\'s entry', () => {
        expect(WINDOW_PAGES).toContain('host-directory');
        expect(readFileSync('host-directory.html', 'utf8')).toContain('/src/renderer/host-directory-main.tsx');
        expect(readFileSync('vite.config.ts', 'utf8')).toContain("'host-directory': 'host-directory.html'");
    });

    it('its preload exposes the view and the actions, and nothing else of Genie', () => {
        const preload = readFileSync(join('src', 'main', 'host-directory-preload.ts'), 'utf8');
        expect(preload).toContain("exposeInMainWorld('genieHostDirectory'");
        expect(preload).toMatch(/host-directory:current/);
        expect(preload).toMatch(/host-directory:act/);
        expect(preload).not.toMatch(/genie:(?!host-directory)/);
        expect(readFileSync('vite.preload.config.ts', 'utf8')).toContain("'host-directory-preload': 'src/main/host-directory-preload.ts'");
    });
});

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
        expect(draw(view, 'local').match(/<button[^>]*data-action="start"[^>]*>/)?.[0]).toMatch(/ disabled=""/);
        expect(html.match(/<button[^>]*data-action="start"[^>]*>/)?.[0]).not.toMatch(/ disabled=""/);
    });

    it('paired hosts: one row each, by name and address, with why they cannot open yet', () => {
        const html = draw(hostDirectory({ profile: 'client', local: { kind: 'none' }, paired: ['wss://studio.example:7443', 'ws://10.0.0.5:7443'], launcher: false }));
        expect(html.match(/data-host-row="/g)).toHaveLength(2);
        expect(html).toContain('studio.example');
        expect(html).toContain('wss://studio.example:7443');
    });
});

/** The opening tag of the element carrying `attr`. */
const tag = (html: string, attr: string) => html.match(new RegExp(`<[a-z]+[^>]*${attr}[^>]*>`))?.[0] ?? '';

describe('it looks like Genie (the coordinator\'s review, 2026-11-27)', () => {
    const stopped = hostDirectory({ profile: 'both', local: { kind: 'stopped', build: '2026.11.27-1' }, paired: ['wss://studio.example:7443'], launcher: true });

    it('sits in Genie\'s window chrome: the title bar with the Genie mark and name, a drag region, nothing under the native buttons', () => {
        const html = draw(stopped);
        const bar = html.slice(html.indexOf('data-host-directory-titlebar'), html.indexOf('</header>'));
        expect(bar).toContain('Genie');
        expect(bar).toMatch(/<svg/);
        expect(tag(html, 'data-host-directory-titlebar')).toMatch(/-webkit-app-region:drag/);
    });

    it('each row: its icon, a status dot (not a text pill), the name in bold', () => {
        const html = draw(stopped);
        expect(tag(html, 'data-host-row="local"')).toBeTruthy();
        expect(html).toMatch(/data-host-icon="monitor"/);
        expect(html).toMatch(/data-host-icon="server"/);
        expect(tag(html, 'data-status-dot="amber"')).toMatch(/rounded-full/);
        expect(tag(html, 'data-status-dot="grey"')).toMatch(/rounded-full/);
        expect(tag(html, 'data-host-name="local"')).toMatch(/font-semibold/);
        expect(html).not.toMatch(/>Stopped<|>Paired</);
    });

    it('a paired row: one short muted line, and the rest behind an info icon', () => {
        const html = draw(stopped);
        expect(html).toContain('Open from a computer with a host until sign-in arrives');
        expect(html).toMatch(/data-host-more="wss:\/\/studio\.example:7443"/);
        expect(html).not.toContain('which is coming. Open it from a computer');
    });

    it('Add a host and Start are the primary actions; Start says Starting… while the launcher starts the host', () => {
        expect(tag(draw(stopped), 'data-action="add-host"')).toMatch(/data-primary=""/);
        expect(tag(draw(stopped), 'data-action="start"')).toMatch(/data-primary=""/);
        expect(draw(stopped, 'local')).toContain('Starting…');
        expect(draw(stopped)).not.toContain('Starting…');
    });

    it('the result on the row: running, a green dot, nothing to press', () => {
        const running = hostDirectory({ profile: 'both', local: { kind: 'running', build: '2026.11.27-1' }, paired: [], launcher: true });
        const html = draw(running);
        expect(html).toMatch(/data-status-dot="green"/);
        expect(html).not.toMatch(/data-action="start"/);
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

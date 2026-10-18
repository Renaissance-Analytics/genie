import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MenuItemConstructorOptions } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { genieDocsUrl, whatsNewFor } from '../src/core/whats-new.js';
import { appMenuTemplate } from '../src/main/app-menu.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { handleFeatureAction, type FeatureState } from '../src/main/feature-ipc.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * HELP (Tynn #762; Genie 1's "Help & documentation" and "What's new"). Genie's documentation is Tynn's docs site — the
 * Genie pages at `<tynn>/docs/genie-getting-started` — opened in the person's browser, not a manual Genie carries. And
 * What's new can be read again, any time, from Help: the window opens for the running version even once it was seen;
 * closing it records the version and it goes away.
 */
const NOTES = { '2.0.0-beta.31': '# Genie 2.0.0-beta.31\n\n## What\'s new\n\n- A thing.\n' };

function walk(items: readonly MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
    return items.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? walk(item.submenu) : [])]);
}

describe('the Help menu', () => {
    it('Genie documentation and What’s new, each wired to its own handler', () => {
        const onDocs = vi.fn();
        const onWhatsNew = vi.fn();
        const all = walk(appMenuTemplate('win32', '2.0.0-beta.31', { onSettings: vi.fn(), onCheckUpdates: vi.fn(), onQuit: vi.fn(), onCloseWindow: vi.fn(), onOpenRepo: vi.fn(), onReportIssue: vi.fn(), onDocs, onWhatsNew }));
        (all.find((i) => i.label === 'Genie documentation')?.click as () => void)();
        (all.find((i) => i.label === 'What’s new')?.click as () => void)();
        expect(onDocs).toHaveBeenCalledTimes(1);
        expect(onWhatsNew).toHaveBeenCalledTimes(1);
    });

    it('the documentation is the Tynn docs site’s Genie pages, on the Tynn Genie is signed in to', () => {
        expect(genieDocsUrl('https://tynn.ai')).toBe('https://tynn.ai/docs/genie-getting-started');
        expect(genieDocsUrl('https://tynn.example/')).toBe('https://tynn.example/docs/genie-getting-started');
    });
});

describe('What’s new, again', () => {
    it('asked for, it shows for the running version even when already seen (CONTROL: not asked, it does not)', () => {
        expect(whatsNewFor('2.0.0-beta.31', '2.0.0-beta.31', NOTES, true)?.version).toBe('2.0.0-beta.31');
        expect(whatsNewFor('2.0.0-beta.31', '2.0.0-beta.31', NOTES)).toBeNull();
    });

    describe('the actions', () => {
        const pty: PtyPort = {
            open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
            write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
        };
        let dir: string;
        let services: ComposedServices;
        beforeEach(async () => {
            dir = await mkdtemp(join(tmpdir(), 'genie2-help-'));
            services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0 });
        });
        afterEach(async () => {
            await services.shutdown();
            await rm(dir, { recursive: true, force: true });
        });
        const ports = { whatsNew: (shown: boolean) => whatsNewFor('2.0.0-beta.31', String(services.settings.get('whats_new_seen_version') ?? ''), NOTES, shown) };

        it('show: open although seen; close: the version recorded and the window gone', async () => {
            await services.settings.set('whats_new_seen_version', '2.0.0-beta.31');
            const state: FeatureState = { toolStatuses: null, knowledgeQuery: '' };
            const shown = await handleFeatureAction(services, { kind: 'whatsNew.show' }, state, ports);
            expect(shown.whatsNew?.version).toBe('2.0.0-beta.31');
            const closed = await handleFeatureAction(services, { kind: 'whatsNew.close', version: '2.0.0-beta.31' }, { ...state, whatsNewShown: true }, ports);
            expect(closed.whatsNew).toBeNull();
            expect(services.settings.get('whats_new_seen_version')).toBe('2.0.0-beta.31');
        });
    });
});

describe('the wiring', () => {
    const main = readFileSync('src/main/main.ts', 'utf8').split(/\r?\n/).map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');
    it('main: the docs open in the browser; What’s new opens over the page; the port honours an asked-for show', () => {
        expect(main).toMatch(/onDocs: \(\) => \{ void shell\.openExternal\(genieDocsUrl\(tynnHost\(\)\)\); \},/);
        expect(main).toMatch(/onWhatsNew: \(\) => \{ revealMainWindow\(\); broadcast\('genie:navigate', WHATS_NEW_ROUTE\); \},/);
        expect(main).toMatch(/whatsNew: \(shown\) => whatsNewFor\(app\.getVersion\(\), String\(composed\.settings\.get\('whats_new_seen_version'\) \?\? ''\), RELEASE_NOTES, shown\)/);
    });
    it('App: What’s new asked for over the page; closing goes through whatsNew.close', () => {
        const app = readFileSync('src/renderer/App.tsx', 'utf8');
        expect(app).toMatch(/if \(route === WHATS_NEW_ROUTE\) \{ onWhatsNew\(\); return; \}/);
        expect(app).toMatch(/featureAct\(\{ kind: 'whatsNew\.close', version: features\.whatsNew!?\.version \}/);
    });
});

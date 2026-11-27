import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TITLE_BAR_HEIGHT, hostDirectoryWindowOptions, mainWindowOptions } from '../src/core/window.js';

/*
 * THE HOST DIRECTORY'S WINDOW IS GENIE'S WINDOW (Tynn #1058 L4; the coordinator's review, 2026-11-27): the main window's
 * frame (the OS title bar hidden, the native buttons kept as an overlay the height of Genie's bar), the overlay in the
 * colours of the page's theme, which follows the OS.
 */
describe('hostDirectoryWindowOptions', () => {
    it('Windows and Linux: the main window\'s frame, the overlay in the bar\'s colours for the theme', () => {
        for (const platform of ['win32', 'linux'] as const) {
            const dark = hostDirectoryWindowOptions(platform, true);
            const light = hostDirectoryWindowOptions(platform, false);
            expect(dark.titleBarStyle).toBe(mainWindowOptions(platform).titleBarStyle);
            expect(dark.titleBarOverlay).toEqual({ height: TITLE_BAR_HEIGHT, color: '#15151a', symbolColor: '#e4e4e7' });
            expect(light.titleBarOverlay).toEqual({ height: TITLE_BAR_HEIGHT, color: '#fafafa', symbolColor: '#18181b' });
        }
    });

    it('macOS keeps its traffic lights, no overlay', () => {
        expect(hostDirectoryWindowOptions('darwin', true).titleBarOverlay).toBeUndefined();
        expect(hostDirectoryWindowOptions('darwin', true).titleBarStyle).toBe('hidden');
    });

    it('main.ts opens the directory with them, dark as the OS is', () => {
        const main = readFileSync(join('src', 'main', 'main.ts'), 'utf8');
        expect(main).toMatch(/\.\.\.hostDirectoryWindowOptions\(process\.platform, nativeTheme\.shouldUseDarkColors\)/);
    });
});

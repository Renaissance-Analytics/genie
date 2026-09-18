import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
    applyWindowTheme,
    rememberTitleBarOverlay,
    windowThemePalette,
} from '../window-theme';

describe('native window theme', () => {
    it('has matching light and dark native chrome palettes', () => {
        expect(windowThemePalette(false)).toEqual({
            backgroundColor: '#ffffff',
            overlayColor: '#ffffff',
            symbolColor: '#18181b',
        });
        expect(windowThemePalette(true)).toEqual({
            backgroundColor: '#09090b',
            overlayColor: '#09090b',
            symbolColor: '#a1a1aa',
        });
    });

    it('repaints a tracked title-bar overlay without losing its height', () => {
        const win = {
            isDestroyed: () => false,
            setBackgroundColor: vi.fn(),
            setTitleBarOverlay: vi.fn(),
        };

        rememberTitleBarOverlay(win, 46);
        applyWindowTheme(win, false);

        expect(win.setBackgroundColor).toHaveBeenCalledWith('#ffffff');
        expect(win.setTitleBarOverlay).toHaveBeenCalledWith({
            color: '#ffffff',
            symbolColor: '#18181b',
            height: 46,
        });
    });

    it('only updates the background of an ordinary framed window', () => {
        const win = {
            isDestroyed: () => false,
            setBackgroundColor: vi.fn(),
            setTitleBarOverlay: vi.fn(),
        };

        applyWindowTheme(win, true);

        expect(win.setBackgroundColor).toHaveBeenCalledWith('#09090b');
        expect(win.setTitleBarOverlay).not.toHaveBeenCalled();
    });

    it('routes every hidden title bar through the shared theme palette', () => {
        const root = path.resolve(__dirname, '../..');
        const background = fs.readFileSync(path.join(root, 'main/background.ts'), 'utf8');
        const testingBrowser = fs.readFileSync(
            path.join(root, 'main/testing-browser/index.ts'),
            'utf8',
        );

        expect(background.match(/rememberTitleBarOverlay\(win, 46\)/g)).toHaveLength(3);
        expect(testingBrowser).toContain('rememberTitleBarOverlay(win, 34)');
        expect(`${background}\n${testingBrowser}`).not.toMatch(
            /titleBarOverlay:\s*\{[\s\S]{0,200}color:\s*['"]#(?:0a0a0c|131318)/,
        );
    });
});

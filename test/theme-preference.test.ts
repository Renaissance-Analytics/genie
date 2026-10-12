import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SETTINGS } from '../src/core/settings.js';
import { themePreferenceFrom } from '../src/core/theme.js';

/**
 * LIGHT MEANS LIGHT. The owner's desktop is light; 2.0.0-beta.7 opened dark with a WHITE chat composer whose
 * text could not be seen. Two causes: the renderer pinned `dark` once at first launch and never read the
 * `theme` setting; and Tailwind's `dark:` variant (which Fancy's components use) was bound to the OS
 * preference instead of the class Fancy's theme sets, so Genie's chrome and Fancy's components disagreed.
 */
describe('theme', () => {
    it('the setting says dark, light or system; anything else is null (not a guess)', () => {
        expect(themePreferenceFrom({ theme: 'light' })).toBe('light');
        expect(themePreferenceFrom({ theme: 'dark' })).toBe('dark');
        expect(themePreferenceFrom({ theme: 'system' })).toBe('system');
        expect(themePreferenceFrom({ theme: 'blue' })).toBeNull();
        expect(themePreferenceFrom({})).toBeNull();
        expect(themePreferenceFrom(null)).toBeNull();
    });

    it('the default follows the system — a light desktop opens Genie light', () => {
        const def = SETTINGS.find((s) => s.key === 'theme');
        expect(def?.default).toBe('system');
    });

    it("Tailwind's dark variant is bound to the class Fancy's theme sets, so Genie's chrome and Fancy's components agree", () => {
        const css = readFileSync('src/renderer/styles.css', 'utf8');
        expect(css).toMatch(/@custom-variant dark \(&:where\(\.dark, \.dark \*\)\);/);
    });

    it('the renderer no longer pins dark at first launch', () => {
        const main = readFileSync('src/renderer/main.tsx', 'utf8');
        expect(main).not.toMatch(/setThemePreference\('dark'\)/);
    });
});

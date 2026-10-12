/**
 * THE THEME, FROM THE SETTING. `theme` is a device-scoped setting (dark / light / system) and it was
 * never applied: the renderer pinned dark once at first launch and read nothing afterwards, so the
 * owner's light desktop showed a dark Genie — with Fancy's components (whose `dark:` styles were still
 * bound to the OS preference, not to Genie's class) rendering LIGHT inside it: a white chat composer
 * with invisible text. One function says what the preference is; the renderer applies it.
 */
export type ThemePreference = 'dark' | 'light' | 'system';

export function themePreferenceFrom(values: Readonly<Record<string, boolean | string>> | null | undefined): ThemePreference | null {
    const v = values?.theme;
    return v === 'dark' || v === 'light' || v === 'system' ? v : null;
}

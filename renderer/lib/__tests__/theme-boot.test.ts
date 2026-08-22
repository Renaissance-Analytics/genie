import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
    THEME_STORAGE_KEY,
    THEME_BOOT_SCRIPT,
    resolveDarkTheme,
} from '../theme-boot';

/**
 * genie#229 part 2 — the whole window flashes white.
 *
 * Genie is a dark app whose dark palette hangs off a `.dark` class on <html>:
 * bare `:root` in globals.css IS the light theme (`--bg-0: #ffffff`), and
 * `.boot-screen` — the full-window `position: fixed; inset: 0; z-index: 9999`
 * overlay that master.html ships PRERENDERED as its entire <body> — has a
 * near-white `:root:not(.dark)` variant.
 *
 * That class used to be applied only by `_app.tsx`'s `useEffect`, which React
 * runs AFTER paint. So every frame between first paint and hydration painted
 * the LIGHT boot screen full-window. Measured on the shipped 0.7.0-beta.265
 * build (offscreen capture of `app/master.html`): 4 consecutive frames at
 * luma 249-255 out of 255 — a pure-white window — before it flipped dark.
 *
 * The fix is the standard no-FOUC one: resolve the theme in a BLOCKING inline
 * script in <head>, before the first paint, instead of after hydration. These
 * tests pin the decision and the script's behaviour; the script is exercised
 * for real by evaluating it against a stub window/document, because it has to
 * run in a page with no bundle loaded yet.
 */
describe('resolveDarkTheme', () => {
    it('honours an explicit dark preference over the OS', () => {
        expect(resolveDarkTheme('dark', false)).toBe(true);
    });

    it('honours an explicit light preference over the OS', () => {
        expect(resolveDarkTheme('light', true)).toBe(false);
    });

    it("follows the OS when the preference is 'system'", () => {
        expect(resolveDarkTheme('system', true)).toBe(true);
        expect(resolveDarkTheme('system', false)).toBe(false);
    });

    it('follows the OS when nothing is stored (first run)', () => {
        expect(resolveDarkTheme(null, true)).toBe(true);
        expect(resolveDarkTheme(null, false)).toBe(false);
    });

    it('follows the OS for an unknown/legacy stored value', () => {
        expect(resolveDarkTheme('midnight', true)).toBe(true);
        expect(resolveDarkTheme('', false)).toBe(false);
    });
});

/** Run THEME_BOOT_SCRIPT against a stub environment and report the class. */
function runBootScript(opts: {
    saved?: string | null;
    prefersDark?: boolean;
    storageThrows?: boolean;
    matchMediaMissing?: boolean;
}): { classes: Set<string>; threw: unknown } {
    const classes = new Set<string>();
    const documentStub = {
        documentElement: {
            classList: {
                add: (c: string) => classes.add(c),
                remove: (c: string) => classes.delete(c),
                toggle: (c: string, on?: boolean) => {
                    if (on === true) classes.add(c);
                    else if (on === false) classes.delete(c);
                    else if (classes.has(c)) classes.delete(c);
                    else classes.add(c);
                    return classes.has(c);
                },
                contains: (c: string) => classes.has(c),
            },
        },
    };
    const windowStub = {
        localStorage: {
            getItem: (k: string) => {
                if (opts.storageThrows) throw new Error('private mode');
                return k === THEME_STORAGE_KEY ? (opts.saved ?? null) : null;
            },
        },
        matchMedia: opts.matchMediaMissing
            ? undefined
            : () => ({ matches: !!opts.prefersDark }),
    };
    let threw: unknown = null;
    try {
        // The script runs as a bare <script> in <head>, so `window`/`document`
        // are free globals — shadow them with the stubs.
        // eslint-disable-next-line no-new-func
        new Function('window', 'document', THEME_BOOT_SCRIPT)(
            windowStub,
            documentStub,
        );
    } catch (e) {
        threw = e;
    }
    return { classes, threw };
}

describe('THEME_BOOT_SCRIPT', () => {
    it('adds `dark` for a stored dark preference', () => {
        const { classes, threw } = runBootScript({ saved: 'dark', prefersDark: false });
        expect(threw).toBeNull();
        expect(classes.has('dark')).toBe(true);
    });

    it('leaves `dark` off for a stored light preference, even on a dark OS', () => {
        const { classes } = runBootScript({ saved: 'light', prefersDark: true });
        expect(classes.has('dark')).toBe(false);
    });

    it('follows the OS when nothing is stored — the default Genie install', () => {
        expect(runBootScript({ saved: null, prefersDark: true }).classes.has('dark')).toBe(true);
        expect(runBootScript({ saved: null, prefersDark: false }).classes.has('dark')).toBe(false);
    });

    it('still themes the page when localStorage throws (private mode)', () => {
        const { classes, threw } = runBootScript({ storageThrows: true, prefersDark: true });
        expect(threw).toBeNull();
        expect(classes.has('dark')).toBe(true);
    });

    it('never throws when matchMedia is unavailable', () => {
        const { threw } = runBootScript({ saved: null, matchMediaMissing: true });
        expect(threw).toBeNull();
    });

    it('is a self-contained expression with no bundle dependency', () => {
        // It runs before any chunk has loaded, so it may not reference imports,
        // and it must not be deferred behind module evaluation.
        expect(THEME_BOOT_SCRIPT).not.toMatch(/\bimport\b|\brequire\(/);
        expect(THEME_BOOT_SCRIPT).not.toMatch(/\baddEventListener\(\s*['"]DOMContentLoaded/);
    });
});

describe('_document.tsx wiring', () => {
    /**
     * Wiring guard. The paint behaviour itself is proven by capturing frames
     * from the built master.html; this only fails loudly if the blocking script
     * is ever dropped from the document head, which would silently restore the
     * white flash.
     */
    const documentSrc = fs.readFileSync(
        path.join(__dirname, '..', '..', 'pages', '_document.tsx'),
        'utf8',
    );

    it('injects the boot script into <Head>', () => {
        expect(documentSrc).toMatch(/THEME_BOOT_SCRIPT/);
        expect(documentSrc).toMatch(/dangerouslySetInnerHTML/);
    });

    it('does not defer the script', () => {
        expect(documentSrc).not.toMatch(/<script[^>]*\bdefer\b/);
        expect(documentSrc).not.toMatch(/<script[^>]*\basync\b/);
    });
});

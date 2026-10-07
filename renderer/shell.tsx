import { useEffect, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import '@particle-academy/react-fancy/styles.css';
import '@particle-academy/fancy-code/styles.css';
import '@particle-academy/fancy-slides/styles.css';
import '@particle-academy/fancy-sheets/styles.css';
import '@particle-academy/fancy-git-ui/styles.css';
import '@particle-academy/fancy-artboard/styles.css';
import './styles/globals.css';
import './styles/master.css';
import ErrorBoundary from './components/ErrorBoundary';
import { FilePickerHost } from './components/FilePickerModal';
import {
    PREFERS_DARK_QUERY,
    THEME_CHANGE_EVENT,
    THEME_STORAGE_KEY,
    resolveDarkTheme,
} from './lib/theme-boot';

/**
 * What every Genie window wraps its page in — formerly `pages/_app.tsx`.
 *
 * Next is gone (owner directive). This file carries the two things `_app` did and nothing
 * else: the global stylesheets, and the live theme sync. The per-page HTML carries the
 * BLOCKING pre-paint theme script that `_document.tsx` used to own.
 */
function Shell({ Page }: { Page: ComponentType }) {
    // Keep the persisted theme preference ('system' | 'light' | 'dark') applied WHILE THE
    // WINDOW IS OPEN. 'system' (the default, incl. an unset/legacy value) tracks the OS pref
    // live via matchMedia; an explicit 'light'/'dark' pins the class and ignores the OS.
    //
    // It is NOT what decides the FIRST frame — React runs this after paint, and an unclassed
    // <html> is Genie's LIGHT theme, so relying on it painted a white full-screen window
    // until hydration (genie#229). The per-page HTML resolves the same preference in a
    // blocking head script before anything paints; both sides share `resolveDarkTheme` so
    // they cannot drift.
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const apply = () => {
            let saved: string | null = null;
            try {
                saved = window.localStorage.getItem(THEME_STORAGE_KEY);
            } catch {
                /* private mode — fall through to the OS preference */
            }
            let prefersDark = false;
            try {
                prefersDark = window.matchMedia(PREFERS_DARK_QUERY).matches;
            } catch {
                /* no matchMedia — the head script already made the call */
            }
            const dark = resolveDarkTheme(saved, prefersDark);
            document.documentElement.classList.toggle('dark', dark);
            // CSS owns the page; Electron owns the background + Windows control strip.
            // Report the same resolved choice so those two layers cannot split into light
            // and dark halves (genie#714).
            window.genie?.app.setWindowTheme(dark);
        };
        let mql: MediaQueryList | null = null;
        const onStorage = (event: StorageEvent) => {
            if (event.key === THEME_STORAGE_KEY) apply();
        };
        try {
            mql = window.matchMedia(PREFERS_DARK_QUERY);
            // Listening even for an explicit choice is intentional: resolveDarkTheme ignores
            // the OS then, and changing back to "system" works immediately.
            mql.addEventListener('change', apply);
        } catch {
            /* no matchMedia — the head script already made the call */
        }
        window.addEventListener('storage', onStorage);
        window.addEventListener(THEME_CHANGE_EVENT, apply);
        apply();
        return () => {
            mql?.removeEventListener('change', apply);
            window.removeEventListener('storage', onStorage);
            window.removeEventListener(THEME_CHANGE_EVENT, apply);
        };
    }, []);

    // Surface uncaught async errors (which React's error boundary does not catch on its own)
    // so they are visible in dev tools at least.
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const onUnhandled = (e: PromiseRejectionEvent) => {
            // eslint-disable-next-line no-console
            console.error('[Genie unhandled rejection]', e.reason);
        };
        window.addEventListener('unhandledrejection', onUnhandled);
        return () => window.removeEventListener('unhandledrejection', onUnhandled);
    }, []);

    return (
        <ErrorBoundary>
            <Page />
            {/* One picker host per window drives pickPath() from anywhere in it. */}
            <FilePickerHost />
        </ErrorBoundary>
    );
}

/**
 * Mount a page into its window. Called by the generated per-page entry.
 *
 * `#root` is created by the page HTML. A missing root is thrown rather than ignored: the
 * alternative is a window that loads, paints the boot screen from CSS, and then silently
 * stays empty — indistinguishable from a hung preload bridge, which is the hardest failure
 * in this app to diagnose.
 */
export function mountPage(Page: ComponentType): void {
    const el = document.getElementById('root');
    if (!el) throw new Error('genie: #root missing from the page HTML — nothing can mount');
    createRoot(el).render(<Shell Page={Page} />);
}

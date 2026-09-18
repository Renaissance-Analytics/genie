import type { AppProps } from 'next/app';
import { useEffect } from 'react';
import '@particle-academy/react-fancy/styles.css';
import '@particle-academy/fancy-code/styles.css';
import '@particle-academy/fancy-slides/styles.css';
import '@particle-academy/fancy-sheets/styles.css';
import '@particle-academy/fancy-git-ui/styles.css';
import '@particle-academy/fancy-artboard/styles.css';
import '../styles/globals.css';
import '../styles/master.css';
import ErrorBoundary from '../components/ErrorBoundary';
import { FilePickerHost } from '../components/FilePickerModal';
import {
    PREFERS_DARK_QUERY,
    THEME_CHANGE_EVENT,
    THEME_STORAGE_KEY,
    resolveDarkTheme,
} from '../lib/theme-boot';

export default function App({ Component, pageProps }: AppProps) {
    // Keep the persisted theme preference ('system' | 'light' | 'dark') applied
    // WHILE THE WINDOW IS OPEN. 'system' (the default, incl. an unset/legacy
    // value) tracks the OS pref live via a matchMedia listener so flipping the
    // OS theme re-themes the app; an explicit 'light'/'dark' pins the class and
    // ignores the OS. Settings → Customization writes 'genie.theme' and applies
    // live too; this effect re-syncs on every window/page (re)load.
    //
    // It is NOT what decides the FIRST frame — React runs this after paint, and
    // an unclassed <html> is Genie's LIGHT theme, so relying on it painted a
    // white full-screen window until hydration (genie#229). `_document.tsx`
    // resolves the same preference in a blocking head script before anything
    // paints; both sides share `resolveDarkTheme` so they cannot drift.
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
            // CSS owns the page; Electron owns the background + Windows control
            // strip. Report the same resolved choice so those two layers cannot
            // split into light and dark halves (genie#714).
            window.genie?.app.setWindowTheme(dark);
        };
        let mql: MediaQueryList | null = null;
        const onStorage = (event: StorageEvent) => {
            if (event.key === THEME_STORAGE_KEY) apply();
        };
        try {
            mql = window.matchMedia(PREFERS_DARK_QUERY);
            // Listening even for an explicit choice is intentional: resolveDarkTheme
            // ignores the OS then, and changing back to "system" works immediately
            // without rebuilding this effect.
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

    // Surface uncaught async errors (which React's error boundary doesn't
    // catch on its own) so they're visible in dev tools at least.
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
            <Component {...pageProps} />
            {/* One picker host per window drives pickPath() from anywhere in it. */}
            <FilePickerHost />
        </ErrorBoundary>
    );
}

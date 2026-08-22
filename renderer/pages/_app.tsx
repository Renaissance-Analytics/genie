import type { AppProps } from 'next/app';
import { useEffect } from 'react';
import '@particle-academy/react-fancy/styles.css';
import '@particle-academy/fancy-code/styles.css';
import '@particle-academy/fancy-slides/styles.css';
import '@particle-academy/fancy-sheets/styles.css';
import '@particle-academy/fancy-git-ui/styles.css';
import '../styles/globals.css';
import '../styles/master.css';
import ErrorBoundary from '../components/ErrorBoundary';
import { FilePickerHost } from '../components/FilePickerModal';
import {
    PREFERS_DARK_QUERY,
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
        const apply = (dark: boolean) => {
            document.documentElement.classList.toggle('dark', dark);
        };
        let mql: MediaQueryList | null = null;
        let onChange: ((e: MediaQueryListEvent) => void) | null = null;
        try {
            let saved: string | null = null;
            try {
                saved = window.localStorage.getItem(THEME_STORAGE_KEY);
            } catch {
                /* private mode — fall through to the OS preference */
            }
            if (saved === 'dark' || saved === 'light') {
                return apply(resolveDarkTheme(saved, false));
            }
            // 'system' or unset → follow the OS, and keep following it live.
            mql = window.matchMedia(PREFERS_DARK_QUERY);
            apply(resolveDarkTheme(saved, mql.matches));
            onChange = (e: MediaQueryListEvent) =>
                apply(resolveDarkTheme(saved, e.matches));
            mql.addEventListener('change', onChange);
        } catch {
            /* no matchMedia — the head script already made the call */
        }
        return () => {
            if (mql && onChange) mql.removeEventListener('change', onChange);
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

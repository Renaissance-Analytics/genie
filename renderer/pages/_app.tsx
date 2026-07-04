import type { AppProps } from 'next/app';
import { useEffect } from 'react';
import '@particle-academy/react-fancy/styles.css';
import '@particle-academy/fancy-code/styles.css';
import '@particle-academy/fancy-slides/styles.css';
import '@particle-academy/fancy-sheets/styles.css';
import '../styles/globals.css';
import '../styles/master.css';
import ErrorBoundary from '../components/ErrorBoundary';

export default function App({ Component, pageProps }: AppProps) {
    // Apply the persisted theme preference ('system' | 'light' | 'dark').
    // 'system' (the default, incl. an unset/legacy value) tracks the OS pref
    // live via a matchMedia listener so flipping the OS theme re-themes the app
    // while it's open. An explicit 'light'/'dark' pins the class and ignores the
    // OS. Settings → Customization writes 'genie.theme' and applies live too;
    // this effect re-syncs on every window/page (re)load.
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const apply = (dark: boolean) => {
            document.documentElement.classList.toggle('dark', dark);
        };
        let mql: MediaQueryList | null = null;
        let onChange: ((e: MediaQueryListEvent) => void) | null = null;
        try {
            const saved = window.localStorage.getItem('genie.theme');
            if (saved === 'dark') return apply(true);
            if (saved === 'light') return apply(false);
            // 'system' or unset → follow the OS, and keep following it live.
            mql = window.matchMedia('(prefers-color-scheme: dark)');
            apply(mql.matches);
            onChange = (e: MediaQueryListEvent) => apply(e.matches);
            mql.addEventListener('change', onChange);
        } catch {
            /* private mode */
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
        </ErrorBoundary>
    );
}

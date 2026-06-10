import type { AppProps } from 'next/app';
import { useEffect } from 'react';
import '@particle-academy/react-fancy/styles.css';
import '../styles/globals.css';
import '../styles/master.css';
import ErrorBoundary from '../components/ErrorBoundary';

export default function App({ Component, pageProps }: AppProps) {
    // Apply persisted dark mode preference. Falls back to system pref.
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const apply = (dark: boolean) => {
            document.documentElement.classList.toggle('dark', dark);
        };
        try {
            const saved = window.localStorage.getItem('genie.theme');
            if (saved === 'dark') return apply(true);
            if (saved === 'light') return apply(false);
            apply(window.matchMedia('(prefers-color-scheme: dark)').matches);
        } catch {
            /* private mode */
        }
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

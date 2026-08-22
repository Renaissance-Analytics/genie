import { Html, Head, Main, NextScript } from 'next/document';
import { THEME_BOOT_SCRIPT } from '../lib/theme-boot';

/**
 * Custom document — it exists for ONE reason: to put the theme on <html>
 * before the first paint (genie#229).
 *
 * Genie's dark palette hangs off a `.dark` class, so an unclassed <html> is the
 * LIGHT theme, and every page ships a prerendered full-window `.boot-screen`
 * whose light variant is near-white. Resolving the theme from `_app.tsx`'s
 * `useEffect` — which React runs after paint — therefore painted a white
 * full-screen window until hydration finished. The script below is blocking and
 * inline, so the class is on the element before anything is composited.
 *
 * It must stay a plain inline <script>: no `defer`, no `async`, no
 * `next/script`, or it stops being pre-paint and the flash comes back.
 */
export default function Document() {
    return (
        <Html>
            <Head>
                <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
            </Head>
            <body>
                <Main />
                <NextScript />
            </body>
        </Html>
    );
}

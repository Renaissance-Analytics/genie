/**
 * PURE body/path rewriting for the Testing Browser `.gen` proxy (serve-local-sites
 * follow-on: absolute-origin asset URLs).
 *
 * Phase D's shim serves each site under its REAL `https://<name>.gen` origin and
 * relies on the site's HTML using SAME-ORIGIN, RELATIVE asset URLs (`/build/…`),
 * so the `.gen` origin resolves them through the proxy. That holds for a site like
 * `tynn.gen`. It BREAKS when the served HTML hardcodes an ABSOLUTE origin that
 * isn't the `.gen` host:
 *
 *   - **Laravel built assets** — `asset()` with `APP_URL=https://fow.test` emits
 *     `<link href="https://fow.test/build/assets/app-*.css">`. The browser fetches
 *     `fow.test` — a non-`.gen` host the shim refuses → the page renders unstyled.
 *   - **Laravel + Vite DEV** — `@vite` emits `<script src="http://[::1]:5173/@vite/client">`
 *     etc. From the `https://biz.gen` page these are cross-origin AND http-on-https
 *     (mixed content) → blocked → the SPA never boots.
 *
 * The fix (Part 1) is a TEXT rewrite of the served HTML: map the site's own
 * absolute origin (its `.test` vhost) and the Vite dev origin onto the current
 * `https://<name>.gen` origin, so every asset URL loads SAME-ORIGIN over https
 * through the proxy — no `ERR_TUNNEL_CONNECTION_FAILED`, no mixed-content block.
 * Capturing the Vite dev port also lets the carrier route the now-same-origin
 * Vite-owned paths to the Vite dev server (Part 2, {@link isViteAssetPath}).
 *
 * These functions are PURE (no I/O, no Node builtins) so they are exhaustively
 * unit-tested — correctness must come from tests + reasoning, not the real sites.
 */

/** Escape a string for literal use inside a `RegExp`. */
function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The loopback authorities a Laravel-Vite dev server is referenced by in the
 * served HTML: the IPv6 loopback literal `[::1]`, `localhost`, and the IPv4
 * loopback `127.0.0.1`. We only ever rewrite the `http://` form (the mixed-content
 * case the fix targets); an https dev origin has no mixed-content problem.
 */
const VITE_LOOPBACK_AUTHORITY = String.raw`(?:\[::1\]|localhost|127\.0\.0\.1)`;

/**
 * PURE. Rewrite the served HTML text so a site whose markup emits ABSOLUTE-origin
 * asset URLs renders through the `.gen` proxy. Two independent maps:
 *
 *   1. **The site's own `.test` vhost** — `https://<vhost>` / `http://<vhost>`
 *      (with an optional `:port`) → `https://<genHost>`. Matches the EXACT vhost
 *      only (a trailing hostname char after it — `fow.test.example.com` — is left
 *      alone), so a look-alike or a third-party host is never touched.
 *   2. **The Vite dev origin** — `http://[::1]:<port>` / `http://localhost:<port>` /
 *      `http://127.0.0.1:<port>` → `https://<genHost>`, and the `<port>` is
 *      captured as `vitePort` (the Vite dev-server port) so the carrier can route
 *      Vite-owned paths to it. Upgrading http→https + collapsing to the same
 *      origin removes BOTH the mixed-content and the cross-origin (CORS) block.
 *
 * An UNRELATED absolute URL (a real CDN, a third-party API) is left untouched —
 * only the site's own origin and the loopback Vite origin are mapped. `vitePort`
 * is null when no Vite dev origin appears (the common built-asset / plain-relative
 * case), which is the signal to keep normal (Laravel-port) routing.
 */
export function rewriteSiteHtml(
    html: string,
    vhost: string,
    genHost: string,
): { html: string; vitePort: number | null } {
    const genOrigin = `https://${genHost}`;

    // 1. The site's own absolute origin (its `.test` vhost, any scheme, optional
    //    port). The trailing negative lookahead `(?![\w.-])` pins the EXACT vhost:
    //    it will not match when a hostname-continuation char follows (so
    //    `fow.test` never matches inside `fow.test.example.com`).
    const vhostRe = new RegExp(`https?://${escapeRegExp(vhost)}(?::\\d+)?(?![\\w.-])`, 'gi');
    let out = html.replace(vhostRe, genOrigin);

    // 2. The Vite dev origin (loopback, http only). Capture the port from the
    //    first occurrence — every `@vite`/`@react-refresh`/source URL shares it.
    let vitePort: number | null = null;
    const viteRe = new RegExp(`http://${VITE_LOOPBACK_AUTHORITY}:(\\d+)`, 'gi');
    out = out.replace(viteRe, (_match, port: string) => {
        if (vitePort === null) {
            const n = Number(port);
            if (Number.isInteger(n) && n > 0 && n < 65536) vitePort = n;
        }
        return genOrigin;
    });

    return { html: out, vitePort };
}

/**
 * The URL path prefixes a Vite dev server owns (as opposed to the Laravel app).
 * After {@link rewriteSiteHtml} collapses the Vite origin onto `<name>.gen`, the
 * browser requests these same-origin through the proxy; the carrier routes them
 * to the Vite dev port instead of the Laravel port.
 *
 *   - `/@vite/`         — the Vite client + internal endpoints (`/@vite/client`).
 *   - `/@react-refresh` — the React Fast Refresh runtime (exact module, no slash).
 *   - `/@fs/`           — Vite's filesystem-absolute imports.
 *   - `/@id/`           — Vite's resolved bare-import ids.
 *   - `/@vite-plugin`   — plugin virtual modules (e.g. `/@vite-plugin-checker…`).
 *   - `/node_modules/`  — pre-bundled deps Vite serves in dev.
 *   - `/resources/`     — the Laravel-Vite source dir (`resources/js/app.tsx`, …).
 *
 * Everything else — the HTML document itself, `/api/*`, `/build/*` (production
 * assets), `/storage/*`, favicons — stays on the Laravel port.
 */
const VITE_PATH_PREFIXES = [
    '/@vite/',
    '/@react-refresh',
    '/@fs/',
    '/@id/',
    '/@vite-plugin',
    '/node_modules/',
    '/resources/',
];

/**
 * PURE. Does this request path belong to the Vite dev server (vs the Laravel app)?
 * Compares the PATHNAME only (query/hash stripped) against {@link VITE_PATH_PREFIXES}.
 * Used by the local carrier to pick the Vite port for a site that served a Vite
 * dev origin; a no-match keeps the request on the Laravel port.
 */
export function isViteAssetPath(path: string): boolean {
    const pathname = path.split(/[?#]/, 1)[0];
    return VITE_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

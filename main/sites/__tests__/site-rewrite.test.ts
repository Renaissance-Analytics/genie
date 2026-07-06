import { describe, expect, it } from 'vitest';
import { isViteAssetPath, rewriteSiteHtml } from '../site-rewrite';

/**
 * PURE-logic tests for the `.gen` absolute-origin asset rewrite. These stand in for
 * the owner's real dev sites (unreachable from here): correctness comes from the two
 * confirmed real-DevTools patterns —
 *   - fow.gen (Laravel BUILT assets): `<link href="https://fow.test/build/…">`
 *   - biz.gen (Laravel + Vite DEV): `<script src="http://[::1]:5173/@vite/client">`
 * — plus the invariant that an UNRELATED absolute URL is never touched.
 */

describe('rewriteSiteHtml — the site vhost origin (fow.gen / Laravel built assets)', () => {
    it("maps the site's own https vhost origin onto the .gen origin", () => {
        const html = '<link rel="stylesheet" href="https://fow.test/build/assets/app-a1b2c3.css">';
        const { html: out, vitePort } = rewriteSiteHtml(html, 'fow.test', 'fow.gen');
        expect(out).toBe('<link rel="stylesheet" href="https://fow.gen/build/assets/app-a1b2c3.css">');
        expect(vitePort).toBeNull();
    });

    it('maps an http vhost origin (and any :port) up to the https .gen origin', () => {
        const html = 'a <img src="http://fow.test/logo.png"> b <a href="https://fow.test:8443/x">';
        const { html: out } = rewriteSiteHtml(html, 'fow.test', 'fow.gen');
        expect(out).toContain('https://fow.gen/logo.png');
        expect(out).toContain('https://fow.gen/x'); // :8443 dropped — .gen is on 443
    });

    it('matches the EXACT vhost only — a look-alike host is left alone', () => {
        const html = '<a href="https://fow.test.evil.com/x"> <a href="https://notfow.test/y">';
        const { html: out } = rewriteSiteHtml(html, 'fow.test', 'fow.gen');
        expect(out).toBe(html); // neither is the exact fow.test origin
    });

    it('leaves an unrelated third-party absolute URL untouched', () => {
        const html = '<script src="https://cdn.example.com/lib.js"></script>';
        const { html: out, vitePort } = rewriteSiteHtml(html, 'fow.test', 'fow.gen');
        expect(out).toBe(html);
        expect(vitePort).toBeNull();
    });
});

describe('rewriteSiteHtml — the Vite dev origin (biz.gen / Laravel + Vite)', () => {
    it('maps http://[::1]:<port> onto the https .gen origin and captures vitePort', () => {
        const html =
            '<script type="module" src="http://[::1]:5173/@vite/client"></script>' +
            '<script type="module" src="http://[::1]:5173/resources/js/app.tsx"></script>';
        const { html: out, vitePort } = rewriteSiteHtml(html, 'biz.test', 'biz.gen');
        expect(out).toContain('src="https://biz.gen/@vite/client"');
        expect(out).toContain('src="https://biz.gen/resources/js/app.tsx"');
        expect(out).not.toContain('[::1]');
        expect(vitePort).toBe(5173);
    });

    it('also maps the localhost and 127.0.0.1 loopback forms', () => {
        expect(rewriteSiteHtml('x http://localhost:5174/@vite/client', 'b.test', 'b.gen')).toEqual({
            html: 'x https://b.gen/@vite/client',
            vitePort: 5174,
        });
        expect(rewriteSiteHtml('x http://127.0.0.1:5175/@react-refresh', 'b.test', 'b.gen')).toEqual({
            html: 'x https://b.gen/@react-refresh',
            vitePort: 5175,
        });
    });

    it('rewrites BOTH the vhost and the Vite origin in one pass', () => {
        const html =
            '<link href="https://biz.test/build/app.css">' +
            '<script src="http://[::1]:5173/@vite/client"></script>';
        const { html: out, vitePort } = rewriteSiteHtml(html, 'biz.test', 'biz.gen');
        expect(out).toBe(
            '<link href="https://biz.gen/build/app.css">' +
                '<script src="https://biz.gen/@vite/client"></script>',
        );
        expect(vitePort).toBe(5173);
    });

    it('does not treat an https loopback origin as a Vite origin (no mixed content)', () => {
        // Only the http form is the mixed-content case we rewrite.
        const html = '<script src="https://127.0.0.1:5173/@vite/client"></script>';
        const { html: out, vitePort } = rewriteSiteHtml(html, 'b.test', 'b.gen');
        expect(out).toBe(html);
        expect(vitePort).toBeNull();
    });

    it('the same-origin-relative case (tynn.gen) is a no-op with no vitePort', () => {
        const html = '<link href="/build/assets/app.css"><script src="/build/assets/app.js"></script>';
        const { html: out, vitePort } = rewriteSiteHtml(html, 'tynn.test', 'tynn.gen');
        expect(out).toBe(html);
        expect(vitePort).toBeNull();
    });
});

describe('isViteAssetPath', () => {
    it('matches Vite-owned prefixes', () => {
        for (const p of [
            '/@vite/client',
            '/@react-refresh',
            '/@react-refresh?t=123',
            '/@fs/home/user/proj/x.js',
            '/@id/vue',
            '/@vite-plugin-checker/runtime',
            '/node_modules/.vite/deps/react.js',
            '/resources/js/app.tsx',
            '/resources/css/app.css?direct',
        ]) {
            expect(isViteAssetPath(p), p).toBe(true);
        }
    });

    it('does NOT match the page, api, or Laravel-served/built paths', () => {
        for (const p of [
            '/',
            '/dashboard',
            '/api/user',
            '/build/assets/app-a1b2c3.css',
            '/storage/avatars/1.png',
            '/favicon.ico',
            '/resource', // not the /resources/ dir
        ]) {
            expect(isViteAssetPath(p), p).toBe(false);
        }
    });
});

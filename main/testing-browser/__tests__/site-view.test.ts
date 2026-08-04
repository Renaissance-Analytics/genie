import { describe, expect, it } from 'vitest';
import { SITE_VIEW_WEB_PREFERENCES, isSecureBrowserUrl } from '../site-view';

/**
 * The Testing-Browser SITE-CONTENT view's webPreferences (genie #120).
 *
 * These are extracted into a pure, Electron-free module precisely so the
 * security posture is directly assertable — the rest of `index.ts` is behind the
 * documented "Electron E2E gate" and cannot be unit-tested without a live
 * runtime.
 */
describe('Testing-Browser site-view webPreferences', () => {
    it('runs the site view UNSANDBOXED — a sandboxed child WebContentsView never receives its startupData (electron#44897), which blanks the page', () => {
        // This is the render blocker: with `sandbox: true` the site renderer
        // throws "Cannot destructure property 'preloadScripts' of
        // 'binding.startupData' as it is null" and the `.gen` page is blank.
        expect(SITE_VIEW_WEB_PREFERENCES.sandbox).toBe(false);
    });

    it('keeps the remote site content isolated from Node despite the OS sandbox being off', () => {
        expect(SITE_VIEW_WEB_PREFERENCES.contextIsolation).toBe(true);
        expect(SITE_VIEW_WEB_PREFERENCES.nodeIntegration).toBe(false);
    });

    it('never gives remote site content the Genie preload bridge', () => {
        expect('preload' in SITE_VIEW_WEB_PREFERENCES).toBe(false);
    });
});

describe('isSecureBrowserUrl — only secured web traffic (user directive)', () => {
    it('allows the secure web transports', () => {
        expect(isSecureBrowserUrl('https://web.acme.gen/app')).toBe(true);
        expect(isSecureBrowserUrl('wss://web.acme.gen/socket')).toBe(true);
    });

    it('DENIES the insecure variants a web app might reach for', () => {
        expect(isSecureBrowserUrl('http://web.acme.gen/asset.js')).toBe(false);
        expect(isSecureBrowserUrl('ws://web.acme.gen/hmr')).toBe(false);
        expect(isSecureBrowserUrl('ftp://example.com/f')).toBe(false);
        expect(isSecureBrowserUrl('file:///etc/passwd')).toBe(false);
    });

    it('allows the internal schemes a normal page legitimately uses', () => {
        expect(isSecureBrowserUrl('about:blank')).toBe(true);
        expect(isSecureBrowserUrl('data:text/html,hi')).toBe(true);
        expect(isSecureBrowserUrl('blob:https://web.acme.gen/uuid')).toBe(true);
        expect(isSecureBrowserUrl('devtools://devtools/bundled/x.js')).toBe(true);
    });

    it('fails closed on an unparseable URL', () => {
        expect(isSecureBrowserUrl('not a url')).toBe(false);
        expect(isSecureBrowserUrl('')).toBe(false);
    });
});

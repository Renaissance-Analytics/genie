import { describe, expect, it } from 'vitest';
import { SITE_VIEW_WEB_PREFERENCES } from '../site-view';

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

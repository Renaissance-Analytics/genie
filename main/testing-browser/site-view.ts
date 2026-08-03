import type { WebPreferences } from 'electron';

/**
 * The webPreferences for a Testing-Browser SITE-CONTENT view — the tab that
 * loads `https://<name>.gen`. Extracted as a pure, Electron-free constant so the
 * security posture is directly assertable without the Electron runtime; the rest
 * of `index.ts` is behind the documented "Electron E2E gate".
 *
 * ## `sandbox: false` — deliberate, and load-bearing (electron#44897, genie #120)
 *
 * Electron has a known bug where a SANDBOXED child `WebContentsView` never
 * receives its renderer `startupData`, so the sandboxed renderer throws
 * `TypeError: Cannot destructure property 'preloadScripts' of
 * 'binding.startupData' as it is null` at init and the page renders BLANK. With
 * `sandbox: true` a `.gen` site never draws at all — this is a render blocker,
 * not a cosmetic setting. Turning the OS-level sandbox OFF on this view is what
 * makes hosted sites actually render.
 *
 * The remote site content stays isolated from Node regardless: `contextIsolation`
 * on, `nodeIntegration` off, and NO preload — it never receives the Genie
 * bridge. These are the user's OWN dev sites, served over a private `.gen`
 * network with a per-session CA, so dropping only the OS sandbox (while keeping
 * every Node-isolation guarantee) is an acceptable, deliberate trade-off rather
 * than a general weakening. The CHROME window is unaffected — it keeps its Genie
 * preload and its own webPreferences (see `index.ts#openTestingBrowser`).
 */
export const SITE_VIEW_WEB_PREFERENCES = {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    // NO `preload` — remote site content is never handed the Genie bridge.
} satisfies WebPreferences;

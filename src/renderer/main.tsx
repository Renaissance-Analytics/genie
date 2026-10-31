import { initTheme } from '@particle-academy/react-fancy';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { registerAppIcons } from './icons.js';
import './styles.css';
// xterm's stylesheet, via Fancy's kit-named export rather than the third-party package name.
// Without it the terminal's character-measure element is visible and the grid never lays out.
import '@particle-academy/fancy-term/styles.css';
// The flow editor window's canvas (genie#1204): fancy-flow's own nodes, palette and inspector.
import '@particle-academy/fancy-flow/styles.css';
// The editors' own sheets (each package's README): fancy-code's editor metrics, and the official plugins' sheet and slide
// editors (beta.33 item 14). Tailwind scans their classes through styles.css's @source lines.
import '@particle-academy/fancy-code/styles.css';
import '@particle-academy/fancy-sheets/styles.css';
import '@particle-academy/fancy-slides/styles.css';

/**
 * THE RENDERER'S ENTRY POINT. Four statements, in an order that matters.
 *
 * 1. **Icons first.** `Icon` renders an empty span for an unregistered name, with no warning
 *    and no fallback glyph. Registering after the first paint means a frame of blank gaps.
 * 2. **Theme before mount**, so there is no flash of light on a dark-first app.
 * 3. Mount.
 *
 * Nothing else belongs here. The shell's data comes from `window.genie`, which the preload
 * script put there before this file ran.
 */

registerAppIcons();

/**
 * Genie is **dark-first** and must also work light.
 *
 * `initTheme` resolves an absent stored choice to `system`, which on a light desktop would
 * open Genie light on first launch. So an absent choice is written as `dark` once — and only
 * when absent, so a user who picked light or system keeps it, and someone who later chooses
 * `system` gets the OS back (`setThemePreference('system')` removes the stored value rather
 * than storing the word).
 */
// The theme is the `theme` setting (dark / light / system, default system), applied by App once the settings
// arrive; until then initTheme resolves a stored choice or follows the OS — a light desktop opens light.
initTheme();

const host = document.getElementById('root');
if (!host) throw new Error('#root is missing from index.html');

// THE LAST NET (parity audit #7; Genie 1 `renderer/pages/_app.tsx:91`): under every surface's own boundary, the whole window's.
createRoot(host).render(<ErrorBoundary surface="Genie" whole><App /></ErrorBoundary>);

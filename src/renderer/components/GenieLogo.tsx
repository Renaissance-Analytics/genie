import genieLogo from '../assets/genie-logo.png';

/**
 * GENIE'S MARK — the logo itself, the same art as the app icon: the lamp with a terminal prompt on white
 * (`.ai/design/genie-logo-white.png`, the owner's choice 2026-10-18; test/genie-logo-white.test.ts). The title bar showed a gradient square in its place, and the owner, 2026-10-15, read the
 * upper-left as having no icon at all: a square of colour is not Genie's mark. Bundled by Vite and loaded from the
 * renderer's own folder, so it works over `file://` in an installed app with no network and no main-process help.
 *
 * Decorative beside the word "Genie" (which is the accessible name of the control around it), so it is hidden from
 * assistive tech and carries an empty `alt`.
 */
export function GenieLogo({ size = 18 }: { size?: number }) {
    return <img data-brand-mark="" src={genieLogo} alt="" aria-hidden="true" width={size} height={size} draggable={false} className="shrink-0 select-none" />;
}

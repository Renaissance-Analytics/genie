/**
 * Genie's top-level overlay layer (genie #114).
 *
 * Overlays that can be opened from ANYWHERE — today the in-app file picker,
 * tomorrow anything else that must outrank a dialog — cannot be left to render
 * wherever their React host happens to sit. Two things break when they are:
 *
 *  1. STACKING. `--z-picker` (950) only outranks the Fancy portal layer (900)
 *     while every ancestor of the host is stacking-context-free. One
 *     `transform` / `filter` / `contain` / `will-change` on any ancestor traps
 *     the whole subtree in that ancestor's context and the number stops meaning
 *     anything — silently, and only on the screens that grew the property.
 *  2. TOKENS. Genie's surface tokens (`--shell`, `--shadow-xl`, `--card`, the
 *     `--term-*` palette, …) are declared on `.gwrap`, the master page's
 *     wrapper. Anything rendered outside that wrapper resolves them to nothing,
 *     the declarations go invalid-at-computed-value-time, and the surface falls
 *     back to `background: transparent; box-shadow: none`. That is genie #114:
 *     the file picker painted see-through over the Add-workspace modal, so it
 *     read as "behind the modal" even though it was genuinely on top and
 *     clickable (which is why the #86 z-index fix did not settle it).
 *
 * So overlays portal into ONE host that is a direct child of `<body>` and
 * carries the token scope in its class. Being a body child makes its layer
 * answerable only to the root stacking context; carrying `OVERLAY_ROOT_CLASS`
 * makes `var(--shell)` resolve there exactly as it does inside `.gwrap` (see
 * the shared `.gwrap, .genie-overlay-root` declaration in master.css).
 *
 * The host itself is `display: contents` — it must add a layer, never a box.
 */

/** `id` of the singleton host element, for lookup. */
export const OVERLAY_ROOT_ID = 'genie-overlay-root';

/** Class carrying the token scope + `display: contents` (see master.css). */
export const OVERLAY_ROOT_CLASS = 'genie-overlay-root';

/** The bits of an element {@link ensureOverlayRoot} touches. */
export interface OverlayRootNode {
    id: string;
    className: string;
}

/** The bits of a document {@link ensureOverlayRoot} touches. */
export interface OverlayRootHost<N extends OverlayRootNode> {
    getElementById(id: string): N | null;
    createElement(tagName: 'div'): N;
    readonly body: { appendChild(child: N): void } | null;
}

/**
 * Get the overlay host, creating it on first use. Idempotent: repeat calls
 * return the same element and never append a second one.
 *
 * Returns null before `<body>` exists (static export / pre-hydration), so
 * callers render nothing rather than throwing.
 *
 * The class is (re)asserted on every call, not just at creation: an element
 * that lost it — a stale host left by a hot reload, anything that rewrote
 * `className` — would resolve no tokens at all, which is the exact failure this
 * layer exists to prevent, and it must not be able to persist.
 */
export function ensureOverlayRoot<N extends OverlayRootNode>(
    doc: OverlayRootHost<N>,
): N | null {
    const existing = doc.getElementById(OVERLAY_ROOT_ID);
    if (existing) {
        if (!existing.className.split(/\s+/).includes(OVERLAY_ROOT_CLASS)) {
            existing.className = OVERLAY_ROOT_CLASS;
        }
        return existing;
    }
    if (!doc.body) return null;
    const host = doc.createElement('div');
    host.id = OVERLAY_ROOT_ID;
    host.className = OVERLAY_ROOT_CLASS;
    doc.body.appendChild(host);
    return host;
}

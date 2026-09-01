import { useEffect, useState } from 'react';
import { ensureOverlayRoot } from './overlay-root';

/**
 * The overlay host to portal into — NEVER `document.body` (genie #114).
 *
 * Genie's surface tokens (`--shell`, `--card`, `--shadow-xl`, the `--term-*`
 * palette) live on `.gwrap` / `.genie-overlay-root`, not on `:root`. A portal
 * into `document.body` lands outside that subtree, every one of those
 * declarations goes invalid-at-computed-value-time, and the surface paints
 * `background: transparent; box-shadow: none`.
 *
 * The failure is quiet, which is why it kept coming back: `--border-1` and
 * `--fg-1` ARE on `:root`, so the border and the text still render and the
 * result looks almost right — just see-through.
 *
 * Resolved in an EFFECT rather than during render, because `ensureOverlayRoot`
 * appends to `<body>` on first use and that is a DOM mutation. It returns null
 * on the first pass (and in any non-DOM environment), so callers render nothing
 * until it is ready — the same shape `FilePickerModal` has used since #114.
 */
export function useOverlayRoot(): HTMLElement | null {
    const [root, setRoot] = useState<HTMLElement | null>(null);
    useEffect(() => {
        setRoot(ensureOverlayRoot<HTMLElement>(document));
    }, []);
    return root;
}

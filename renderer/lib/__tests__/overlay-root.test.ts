import { describe, expect, it } from 'vitest';
import {
    OVERLAY_ROOT_CLASS,
    OVERLAY_ROOT_ID,
    ensureOverlayRoot,
    type OverlayRootHost,
    type OverlayRootNode,
} from '../overlay-root';

/**
 * genie #114 — the overlay host is the whole fix's load-bearing piece, so it is
 * tested as a pure function against a stub document (the suite runs in Node
 * with no DOM; see vitest.config.ts).
 *
 * What matters is not that it creates a div — it is that the div is a BODY
 * child (so its stacking answers to the root context and nothing else) and that
 * it carries the token-scope class (so `var(--shell)` resolves and the panel
 * paints opaque). Everything below pins one of those two.
 */

interface StubNode extends OverlayRootNode {}

function stubDoc(opts: { hasBody?: boolean } = {}) {
    const appended: StubNode[] = [];
    const byId = new Map<string, StubNode>();
    const doc: OverlayRootHost<StubNode> & { appended: StubNode[] } = {
        appended,
        getElementById: (id) => byId.get(id) ?? null,
        createElement: () => ({ id: '', className: '' }),
        body:
            opts.hasBody === false
                ? null
                : {
                      appendChild: (child) => {
                          appended.push(child);
                          // A real appendChild makes the node findable by id.
                          if (child.id) byId.set(child.id, child);
                      },
                  },
    };
    return doc;
}

describe('overlay host (genie #114)', () => {
    it('creates a body child carrying the id and the token-scope class', () => {
        const doc = stubDoc();

        const host = ensureOverlayRoot(doc);

        expect(host).not.toBeNull();
        expect(host!.id).toBe(OVERLAY_ROOT_ID);
        // Without this class the host resolves none of `.gwrap`'s surface
        // tokens and every overlay portaled into it paints transparent.
        expect(host!.className.split(/\s+/)).toContain(OVERLAY_ROOT_CLASS);
        // A BODY child, not a child of whatever tree the caller sits in — that
        // is what keeps `--z-picker` answerable to the root stacking context.
        expect(doc.appended).toEqual([host]);
    });

    it('is idempotent — a second call reuses the host instead of stacking another', () => {
        const doc = stubDoc();

        const first = ensureOverlayRoot(doc);
        const second = ensureOverlayRoot(doc);

        expect(second).toBe(first);
        expect(doc.appended).toHaveLength(1);
    });

    it('re-asserts the token class on a host that lost it', () => {
        // A stale host from a hot reload, or anything that rewrote className,
        // would silently strip the token scope back off. Reusing it as-is would
        // reintroduce the transparent-panel bug on the second open only.
        const doc = stubDoc();
        const host = ensureOverlayRoot(doc)!;
        host.className = 'something-else';

        expect(ensureOverlayRoot(doc)!.className.split(/\s+/)).toContain(OVERLAY_ROOT_CLASS);
        expect(doc.appended).toHaveLength(1);
    });

    it('returns null before <body> exists rather than throwing', () => {
        // The renderer is a Next static export; `_app` renders once with no
        // document. Callers must be able to render nothing, not crash.
        expect(ensureOverlayRoot(stubDoc({ hasBody: false }))).toBeNull();
    });
});

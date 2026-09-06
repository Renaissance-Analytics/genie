import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ErrorBoundary from '../ErrorBoundary';
import { SearchGroup } from '../../pages/settings';

/**
 * A settings section must not be able to kill the Settings window.
 *
 * Genie has exactly ONE error boundary — the root one in `_app.tsx` — so a throw
 * anywhere under it replaces the ENTIRE window with the full-screen "Genie hit
 * an error" takeover. In the Settings window that means one bad section (a row
 * whose shape main answered differently than expected, a tab nobody has a test
 * for) takes down every other section with it, including the ones that would
 * have let the person fix or work around whatever broke.
 *
 * The owner hit precisely this: "the settings window crashes when I try to go to
 * the toolchain CLI tab". Whatever threw, the window is not supposed to be the
 * blast radius — and the takeover is also why the error text never reached
 * anybody, because a full-screen page nobody screenshots is a stack trace that
 * does not exist.
 *
 * `SearchGroup` is the one wrapper every section already goes through, so the
 * boundary goes there: one place, no section able to opt out of it, and the
 * section's own LABEL on the card so the failure names itself.
 */

/** Every element in a returned tree, so a wrapper can be asserted without a DOM. */
function walk(node: unknown, out: React.ReactElement[] = []): React.ReactElement[] {
    if (Array.isArray(node)) {
        for (const child of node) walk(child, out);
        return out;
    }
    if (!React.isValidElement(node)) return out;
    out.push(node);
    const props = node.props as { children?: unknown };
    if (props?.children !== undefined) walk(props.children, out);
    return out;
}

describe('every settings section renders inside its own error boundary', () => {
    it('wraps a section in a COMPACT boundary that names it', () => {
        const tree = walk(SearchGroup({ label: 'Toolchain', searching: false, children: 'body' }));
        const boundary = tree.find((el) => el.type === ErrorBoundary);
        expect(boundary, 'no ErrorBoundary around the section').toBeDefined();
        const props = boundary!.props as { compact?: boolean; name?: string };
        // COMPACT: an inline card in place of the section, not a full-screen
        // takeover of a window with fifteen other sections in it.
        expect(props.compact).toBe(true);
        // Named, so the card says WHICH section broke.
        expect(props.name).toBe('Toolchain');
    });

    it('wraps it while searching too — the same sections, a different layout', () => {
        const tree = walk(SearchGroup({ label: 'Toolchain', searching: true, children: 'body' }));
        expect(tree.some((el) => el.type === ErrorBoundary)).toBe(true);
    });

    // The positive control. "It no longer takes the window down" is also true of
    // a wrapper that renders nothing at all, so the section still has to appear.
    it('still renders the section it is guarding', () => {
        for (const searching of [false, true]) {
            const html = renderToStaticMarkup(
                React.createElement(SearchGroup, {
                    label: 'Toolchain',
                    searching,
                    children: React.createElement('span', null, 'the toolchain section'),
                }),
            );
            expect(html, `searching=${searching}`).toContain('the toolchain section');
            expect(html, `searching=${searching}`).toContain('settings-tab');
        }
    });

    it('shows the section name and the error when it does catch one', () => {
        // The boundary's error state is not reachable through the server
        // renderer (it never calls getDerivedStateFromError), so the fallback is
        // rendered directly — the same code path React would take.
        const boundary = new ErrorBoundary({ children: null, compact: true, name: 'Toolchain' });
        boundary.state = { error: new Error('agentRows exploded'), info: null };
        const html = renderToStaticMarkup(boundary.render() as React.ReactElement);
        expect(html).toContain('Toolchain hit an error');
        expect(html).toContain('agentRows exploded');
    });
});

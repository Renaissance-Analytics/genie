import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Workspace } from '../src/renderer/components/Workspace.js';
import type { GenieBridge } from '../src/renderer/bridge.js';

/**
 * THE WORKSPACE SURFACE'S MARKUP — the first paint, rendered with `react-dom/server`.
 *
 * No browser, no Electron, no jsdom. This proves the surface mounts and offers the one thing a
 * person must find on it — a way to open a terminal — before any terminal exists. What a
 * terminal looks like once open is xterm's to draw and the smoke's to assert: an xterm needs a
 * real container, and `renderToStaticMarkup` runs no effects.
 *
 * The bridge is a fake that RECORDS. In a static render nothing calls it (effects do not run),
 * and that is asserted too: a surface that talked to the engine during render would open a
 * terminal every time React re-rendered.
 */

function fakeTerminals() {
    const calls: string[] = [];
    const terminals: GenieBridge['terminals'] = {
        open: async (workspaceId) => { calls.push(`open:${workspaceId}`); return { id: 'term_x', pid: 1, shell: '/bin/sh', scrollback: '' }; },
        write: (id) => { calls.push(`write:${id}`); },
        resize: (id) => { calls.push(`resize:${id}`); },
        close: (id) => { calls.push(`close:${id}`); },
        list: async () => { calls.push('list'); return []; },
        attach: async (_ws, id) => { calls.push(`attach:${id}`); return null; },
        previousSession: async () => null,
        onData: () => () => {},
        onExit: () => () => {},
    };
    return { terminals, calls };
}

const workspace = { id: 'tynn', name: 'tynn', path: 'C:\\_Projects\\tynn.ai' };

describe('the Workspace surface, before any terminal exists', () => {
    it('names itself and its workspace, so the smoke and the route can find it', () => {
        const { terminals } = fakeTerminals();
        const html = renderToStaticMarkup(<Workspace workspace={workspace} terminals={terminals} />);

        expect(html).toContain('data-surface="workspace"');
        expect(html).toContain('data-workspace="tynn"');
    });

    it('shows the workspace name and path in a 56px header, like the Dashboard group header', () => {
        const { terminals } = fakeTerminals();
        const html = renderToStaticMarkup(<Workspace workspace={workspace} terminals={terminals} />);

        expect(html).toContain('>tynn<');
        expect(html).toContain('C:\\_Projects\\tynn.ai');
        expect(html).toContain('h-14');
    });

    it('offers a way to open a terminal — TWICE, in the strip and in the empty state', () => {
        /**
         * COUNTED. A person arriving at an empty workspace must find the control without a
         * shortcut (§4.0's acceptance test). It is in the tab strip for the ordinary case and
         * in the body for the empty one; asserting "a button exists" would pass with either
         * missing.
         */
        const { terminals } = fakeTerminals();
        const html = renderToStaticMarkup(<Workspace workspace={workspace} terminals={terminals} />);

        expect(html.match(/data-terminal-add=""/g)?.length ?? 0).toBe(1);
        expect(html.match(/data-terminal-add-empty=""/g)?.length ?? 0).toBe(1);
        expect(html).toContain('No terminals open in tynn.');
    });

    it('renders NO terminal pane and NO tab when there is nothing to show', () => {
        // The absence claims, in the same render as the presence claims above.
        const { terminals } = fakeTerminals();
        const html = renderToStaticMarkup(<Workspace workspace={workspace} terminals={terminals} />);

        expect(html).not.toContain('data-terminal-pane');
        expect(html).not.toContain('data-terminal-tab=');
    });

    it('talks to the engine in effects only — a static render makes NO bridge calls', () => {
        const { terminals, calls } = fakeTerminals();
        renderToStaticMarkup(<Workspace workspace={workspace} terminals={terminals} />);

        expect(calls).toEqual([]);
    });

    it('has no agent anywhere in its markup — the one rule, at the surface', () => {
        // A grep-shaped assertion, deliberately: the attribute every agent surface carries must
        // not appear on this one. The positive control is the Dashboard render test, which
        // asserts that attribute IS present there.
        const { terminals } = fakeTerminals();
        const html = renderToStaticMarkup(<Workspace workspace={workspace} terminals={terminals} />);

        expect(html).not.toContain('data-agent');
    });
});

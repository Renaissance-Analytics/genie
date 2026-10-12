import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { emptyWorkspace, terminalHidden, terminalOpened, terminalSuspended } from '../src/core/workspace-view.js';
import { NO_TERMINALS } from '../src/renderer/bridge.js';
import { Workspace } from '../src/renderer/components/Workspace.js';

/**
 * TERMINAL LIFECYCLE IN THE WORKSPACE SURFACE (§6.5): every tab offers Hide (keeps running) beside
 * Close (ends it) — two controls, two words, never one button doing both; a Suspend toggle per tab,
 * which says how many bytes it held back while suspended; and a chip listing hidden terminals so a
 * hidden shell is one click from being seen again. Rendered from an initial state, server-side.
 */

const tab = (id: string) => ({ id, workspaceId: 'tynn', shell: '/bin/bash', pid: 1, exited: null });
const render = (state: ReturnType<typeof emptyWorkspace>) =>
    renderToStaticMarkup(<Workspace view="terminals" workspace={{ id: 'tynn', path: '/w/tynn' }} terminals={NO_TERMINALS} initialState={state} />);

describe('tab controls', () => {
    it('each tab has Hide AND Close, and a Suspend toggle; a suspended tab says so and shows the held-back count', () => {
        let s = terminalOpened(emptyWorkspace(), tab('t1'), '');
        s = terminalOpened(s, tab('t2'), '');
        s = terminalSuspended(s, 't2', true);
        s = { ...s, terminals: s.terminals.map((t) => (t.id === 't2' ? { ...t, droppedWhileSuspended: 1234 } : t)) };
        const html = render(s);
        expect(html).toContain('data-terminal-hide="t1"');
        expect(html).toContain('data-terminal-close="t1"');
        expect(html).toContain('data-terminal-suspend="t1"');
        expect(html).toContain('data-terminal-suspended="t2"');
        expect(html).toMatch(/1\.2 kB held/);
        expect(html).not.toContain('data-terminal-hidden-list');
    });

    it('hidden terminals are listed on a chip with a Show per terminal; the strip no longer carries them', () => {
        let s = terminalOpened(emptyWorkspace(), tab('t1'), '');
        s = terminalOpened(s, tab('t2'), '');
        s = terminalHidden(s, 't1');
        const html = render(s);
        expect(html).not.toContain('data-terminal-tab="t1"');
        expect(html).toContain('data-terminal-tab="t2"');
        expect(html).toContain('data-terminal-hidden-list');
        expect(html).toContain('data-terminal-show="t1"');
        expect(html).toMatch(/1 hidden/);
    });
});

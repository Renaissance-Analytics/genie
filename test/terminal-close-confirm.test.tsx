import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { closeCancelled, closeRequested, emptyWorkspace, terminalExited, terminalOpened } from '../src/core/workspace-view.js';
import { NO_TERMINALS } from '../src/renderer/bridge.js';
import { Workspace } from '../src/renderer/components/Workspace.js';

/**
 * CLOSING A RUNNING TERMINAL ASKS FIRST (Tynn #763 row 49; Genie 1's "Delete terminal — … any running shell is killed").
 * The tab's × ended the shell at once: one stray click and a build, a server or a REPL was gone. Now a RUNNING terminal
 * asks — naming it and what stops — with Close terminal and Cancel; one that has already exited closes at once, there is
 * nothing left to lose.
 */
const tab = (id: string) => ({ id, workspaceId: 'tynn', shell: '/bin/bash', pid: 1, exited: null });
const render = (state: ReturnType<typeof emptyWorkspace>) =>
    renderToStaticMarkup(<Workspace view="terminals" workspace={{ id: 'tynn', path: '/w/tynn' }} terminals={NO_TERMINALS} initialState={state} />);

describe('the close request', () => {
    it('a running terminal asks first: nothing is closed yet, and it is waiting on THAT terminal', () => {
        const s = terminalOpened(emptyWorkspace(), tab('t1'), '');
        const r = closeRequested(s, 't1');
        expect(r.closeNow).toBe(false);
        expect(r.state.closing).toBe('t1');
        expect(r.state.terminals.map((t) => t.id)).toEqual(['t1']);
        // Cancel: nothing happened.
        expect(closeCancelled(r.state).closing ?? null).toBeNull();
    });

    it('CONTROL: an exited terminal closes at once — there is nothing left to lose', () => {
        const s = terminalExited(terminalOpened(emptyWorkspace(), tab('t1'), ''), 't1', 0);
        expect(closeRequested(s, 't1').closeNow).toBe(true);
    });
});

describe('the strip', () => {
    it('asking: names the terminal and says its shell is ended, with Close terminal and Cancel (COUNTED: one confirm)', () => {
        const s = closeRequested(terminalOpened(terminalOpened(emptyWorkspace(), tab('t1'), ''), tab('t2'), ''), 't2').state;
        const html = render(s);
        expect(html.match(/data-terminal-close-confirm=/g)).toHaveLength(1);
        expect(html).toContain('data-terminal-close-confirm="t2"');
        expect(html).toMatch(/Close bash\?/);
        expect(html).toMatch(/whatever is running in it stops/);
        expect(html).toMatch(/data-action="confirm-close-terminal"/);
        expect(html).toMatch(/data-action="cancel-close-terminal"/);
    });

    it('CONTROL: not asking, no confirm', () => {
        expect(render(terminalOpened(emptyWorkspace(), tab('t1'), ''))).not.toContain('data-terminal-close-confirm');
    });

    it('the tab’s × asks through closeRequested; Close terminal ends it', () => {
        const src = readFileSync('src/renderer/components/Workspace.tsx', 'utf8');
        expect(src).toMatch(/onClick=\{\(\) => requestClose\(t\.id\)\}/);
        expect(src).toMatch(/const r = closeRequested\(state, id\);/);
    });
});

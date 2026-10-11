import { describe, expect, it } from 'vitest';
import { PREVIOUS_SESSION_DIVIDER, emptyWorkspace, terminalClosed, terminalData, terminalHidden, terminalOpened, terminalShown, terminalSuspended, type TerminalTab } from '../src/core/workspace-view.js';

/**
 * TERMINAL LIFECYCLE (§6.5) — in the view model. HIDE keeps the shell running and takes its tab off
 * the strip (it is listed as hidden, and can be shown again with its output intact); CLOSE ends it
 * and forgets it, hidden or not. SUSPEND keeps the tab but stops output from reaching the pane —
 * the bytes that arrived meanwhile are COUNTED, not dropped silently — and resume lets output flow
 * again. A terminal restored from a snapshot opens above a `— previous session —` divider, so what
 * is old and what is live are never confused.
 */

const tab = (id: string, over: Partial<TerminalTab> = {}): TerminalTab => ({ id, workspaceId: 'tynn', shell: '/bin/bash', pid: 100, exited: null, ...over });

describe('hide and show', () => {
    it('hiding takes the tab off the strip, keeps its output, lists it as hidden, and moves activation; showing brings it back active', () => {
        let s = terminalOpened(emptyWorkspace(), tab('t1'), '');
        s = terminalOpened(s, tab('t2'), '');
        s = terminalData(s, 't1', 'kept\n');
        s = terminalHidden(s, 't1');
        expect(s.terminals.map((t) => t.id)).toEqual(['t2']);
        expect(s.hidden).toEqual([{ id: 't1', workspaceId: 'tynn', shell: '/bin/bash', pid: 100, exited: null }]);
        expect(s.active).toBe('t2');
        expect(s.output['t1']).toBe('kept\n');
        s = terminalData(s, 't1', 'still running\n');
        expect(s.output['t1']).toBe('kept\nstill running\n');
        s = terminalShown(s, 't1');
        expect(s.terminals.map((t) => t.id)).toEqual(['t2', 't1']);
        expect(s.hidden).toEqual([]);
        expect(s.active).toBe('t1');
    });

    it('closing a hidden terminal forgets it entirely; hiding an unknown id changes nothing', () => {
        let s = terminalOpened(emptyWorkspace(), tab('t1'), '');
        s = terminalHidden(s, 't1');
        s = terminalClosed(s, 't1');
        expect(s.hidden).toEqual([]);
        expect(s.output['t1']).toBeUndefined();
        expect(terminalHidden(s, 'nope')).toEqual(s);
    });
});

describe('suspend and resume', () => {
    it('a suspended tab stays on the strip, output is held back and COUNTED; resume lets output flow and clears the count', () => {
        let s = terminalOpened(emptyWorkspace(), tab('t1'), '');
        s = terminalSuspended(s, 't1', true);
        expect(s.terminals[0]).toMatchObject({ id: 't1', suspended: true });
        s = terminalData(s, 't1', 'abc');
        s = terminalData(s, 't1', 'de');
        expect(s.output['t1']).toBe('');
        expect(s.terminals[0]!.droppedWhileSuspended).toBe(5);
        s = terminalSuspended(s, 't1', false);
        expect(s.terminals[0]).toMatchObject({ suspended: false, droppedWhileSuspended: 0 });
        s = terminalData(s, 't1', 'f');
        expect(s.output['t1']).toBe('f');
    });
});

describe('restored from a snapshot', () => {
    it('opens above the previous-session divider; a live reattach with scrollback does not', () => {
        const restored = terminalOpened(emptyWorkspace(), tab('t1'), 'old output\n', { restored: true });
        expect(restored.output['t1']).toBe(`old output\n${PREVIOUS_SESSION_DIVIDER}`);
        expect(PREVIOUS_SESSION_DIVIDER).toMatch(/— previous session —/);
        const live = terminalOpened(emptyWorkspace(), tab('t1'), 'live scrollback\n');
        expect(live.output['t1']).toBe('live scrollback\n');
        const empty = terminalOpened(emptyWorkspace(), tab('t1'), '', { restored: true });
        expect(empty.output['t1']).toBe('');
    });
});

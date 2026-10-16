import { describe, expect, it } from 'vitest';
import {
    OUTPUT_CAP,
    activate,
    emptyWorkspace,
    terminalClosed,
    terminalData,
    terminalExited,
    terminalOpened,
    type TerminalTab,
} from '../src/core/workspace-view.js';

/**
 * THE WORKSPACE SURFACE'S STATE — pure, so a window is not needed to prove it.
 *
 * §4.6: terminals for shells, builds, services and hosted sites. No agent has one, and no
 * assertion here can name one.
 */

const tab = (id: string, over: Partial<TerminalTab> = {}): TerminalTab => ({
    id, workspaceId: 'tynn', shell: '/bin/bash', pid: 100, exited: null, ...over,
});

describe('opening', () => {
    it('adds the terminal, makes it active, and seeds its output with the scrollback', () => {
        // Multi-attach (§6.5): a window joining a running build sees what it missed, not an
        // empty pane with a live cursor.
        const s = terminalOpened(emptyWorkspace(), tab('t1'), 'earlier output\n');

        expect(s.terminals.map((t) => t.id)).toEqual(['t1']);
        expect(s.active).toBe('t1');
        expect(s.output['t1']).toBe('earlier output\n');
    });

    it('a second terminal becomes the active one — the user just asked for it', () => {
        const s = terminalOpened(terminalOpened(emptyWorkspace(), tab('t1'), ''), tab('t2'), '');
        expect(s.active).toBe('t2');
        expect(s.terminals).toHaveLength(2);
    });
});

describe('output', () => {
    it('appends', () => {
        let s = terminalOpened(emptyWorkspace(), tab('t1'), '');
        s = terminalData(s, 't1', 'ok 1');
        s = terminalData(s, 't1', ' - it works\n');
        expect(s.output['t1']).toBe('ok 1 - it works\n');
    });

    it('IGNORES data for a terminal this workspace does not hold', () => {
        /**
         * Data for another workspace's terminal arrives on the same channel. Conjuring a tab
         * for it would show a terminal nobody opened here. The POSITIVE CONTROL is in the same
         * test: the known id still appends, so "ignored" cannot pass on a reducer that ignores
         * everything.
         */
        let s = terminalOpened(emptyWorkspace(), tab('t1'), '');
        s = terminalData(s, 't-elsewhere', 'leak');
        s = terminalData(s, 't1', 'mine');

        expect(s.terminals.map((t) => t.id)).toEqual(['t1']);
        expect(s.output['t-elsewhere']).toBeUndefined();
        expect(s.output['t1']).toBe('mine');
    });

    it('caps the buffer from the FRONT, so the newest output is always present', () => {
        // COUNTED, with the boundary pinned both ways: at the cap nothing is dropped; one over,
        // exactly one character goes, and it is the oldest.
        let s = terminalOpened(emptyWorkspace(), tab('t1'), '');
        s = terminalData(s, 't1', 'A'.repeat(OUTPUT_CAP));
        expect(s.output['t1']).toHaveLength(OUTPUT_CAP);

        s = terminalData(s, 't1', 'Z');
        expect(s.output['t1']).toHaveLength(OUTPUT_CAP);
        expect(s.output['t1']?.endsWith('Z')).toBe(true);
        expect(s.output['t1']?.startsWith('A')).toBe(true);
    });
});

describe('ending', () => {
    it('an exit MARKS the tab and keeps it, with its code', () => {
        // A tab that vanished when a build finished would take its last screen with it.
        let s = terminalOpened(emptyWorkspace(), tab('t1'), '');
        s = terminalData(s, 't1', 'done\n');
        s = terminalExited(s, 't1', 2);

        expect(s.terminals[0]).toMatchObject({ id: 't1', exited: 2 });
        expect(s.output['t1']).toBe('done\n');
    });

    it('an exit code of ZERO is still an exit, not "running"', () => {
        // `exited: 0` and `exited: null` are different claims (§5), and a truthiness check
        // would collapse them.
        const s = terminalExited(terminalOpened(emptyWorkspace(), tab('t1'), ''), 't1', 0);
        expect(s.terminals[0]?.exited).toBe(0);
    });

    it('closing removes the tab and its output', () => {
        let s = terminalOpened(emptyWorkspace(), tab('t1'), 'x');
        s = terminalClosed(s, 't1');
        expect(s.terminals).toEqual([]);
        expect(s.output).toEqual({});
        expect(s.active).toBeNull();
    });

    it('closing the ACTIVE tab activates its neighbour, so the panel never goes blank with tabs left', () => {
        let s = emptyWorkspace();
        for (const id of ['t1', 't2', 't3']) s = terminalOpened(s, tab(id), '');
        s = activate(s, 't2');

        s = terminalClosed(s, 't2');
        expect(s.active).toBe('t3'); // the one that took its place

        s = terminalClosed(s, 't3');
        expect(s.active).toBe('t1'); // nothing to the right; fall back left
    });

    it('closing an INACTIVE tab leaves the active one alone', () => {
        // POSITIVE CONTROL for the neighbour rule: it must only engage when the active tab goes.
        let s = emptyWorkspace();
        for (const id of ['t1', 't2']) s = terminalOpened(s, tab(id), '');
        s = activate(s, 't1');

        s = terminalClosed(s, 't2');
        expect(s.active).toBe('t1');
    });

    it('ignores a close or an exit for an id it does not hold', () => {
        const s = terminalOpened(emptyWorkspace(), tab('t1'), '');
        expect(terminalClosed(s, 'nope')).toBe(s);
        expect(terminalExited(s, 'nope', 1)).toBe(s);
        expect(activate(s, 'nope')).toBe(s);
    });
});

import { describe, expect, it } from 'vitest';
import { parseRoute } from '../src/core/route.js';
import { arrive, NO_PULSES, pulse, pulsingIds, viewDelivery, viewReaches } from '../src/core/view-requests.js';

/**
 * AN AGENT NEVER MOVES THE PERSON'S VIEW (genie#1265; the owner, 2026-10-27: "when an agent opens a file in the file
 * browser or a tab or does anything that right now draws my focus to whatever workspace it was done in, [it] should not
 * change my view or cursor focus, the workspace row in the sidebar and dashboard (if open) should pulse until I navigate
 * there"). genie#1237 stopped agents taking the WINDOW; their actions still navigated it (`openFileForUser` broadcast
 * `genie:navigate`). The rule here is window-activation.ts's, one level in: who asked decides what may move.
 */

describe('who asked decides what reaches the window', () => {
    it('the person’s gesture (tray, menu, a notification) navigates — the positive control', () => {
        expect(viewDelivery({ activation: 'user-gesture', route: 'genie://hosting?tab=processes', reason: 'tray: Task Manager' }))
            .toEqual({ channel: 'genie:navigate', payload: 'genie://hosting?tab=processes' });
    });

    it('an agent’s action never navigates: it marks its workspace, with what it opened there', () => {
        const d = viewDelivery({ activation: 'background', workspaceId: 'tynn', file: 'docs/plan.md', line: 12, reason: 'openFileForUser' });
        expect(d.channel).toBe('genie:workspace-pulse');
        expect(d).toEqual({ channel: 'genie:workspace-pulse', payload: { workspaceId: 'tynn', reason: 'openFileForUser', file: 'docs/plan.md', line: 12 } });
    });

    it('an agent action with nothing to open (a tab, a site) still only marks the workspace', () => {
        expect(viewDelivery({ activation: 'background', workspaceId: 'fancy', reason: 'workspaceTabs' }))
            .toEqual({ channel: 'genie:workspace-pulse', payload: { workspaceId: 'fancy', reason: 'workspaceTabs', file: null, line: null } });
    });
});

describe('the pulse lasts until the person goes there', () => {
    const opened = pulse(NO_PULSES, { workspaceId: 'tynn', reason: 'openFileForUser', file: 'README.md', line: null });

    it('a marked workspace pulses; nothing else does', () => {
        expect([...pulsingIds(opened)]).toEqual(['tynn']);
        expect(pulsingIds(NO_PULSES).size).toBe(0);
    });

    it('the person going anywhere else leaves it pulsing and their route alone', () => {
        for (const route of ['genie://dashboard', 'genie://workspace/fancy', 'genie://settings', 'genie://agent/kai']) {
            const a = arrive(opened, route);
            expect(a.show).toBeNull();
            expect([...pulsingIds(a.pulses)]).toEqual(['tynn']);
        }
    });

    it('arriving at the workspace clears the pulse and shows what the agent opened: its file panel on the file', () => {
        const a = arrive(opened, 'genie://workspace/tynn');
        expect(pulsingIds(a.pulses).size).toBe(0);
        expect(a.show).not.toBeNull();
        expect(parseRoute(a.show!)).toMatchObject({ surface: 'workspace', workspaceId: 'tynn', panel: 'files', file: 'README.md' });
    });

    it('the line comes too, and the view the person asked for is kept', () => {
        const withLine = pulse(NO_PULSES, { workspaceId: 'tynn', reason: 'openFileForUser', file: 'src/a.ts', line: 40 });
        const a = arrive(withLine, 'genie://workspace/tynn?view=tab:t1');
        expect(parseRoute(a.show!)).toMatchObject({ surface: 'workspace', workspaceId: 'tynn', view: 'tab:t1', panel: 'files', file: 'src/a.ts', line: 40 });
    });

    it('a file the person named on the way in wins: the pulse clears and their route is left as it is', () => {
        const a = arrive(opened, 'genie://workspace/tynn?files=other.md');
        expect(a.show).toBeNull();
        expect(pulsingIds(a.pulses).size).toBe(0);
    });

    it('a tab or a site leaves nothing to show: arriving only clears the pulse', () => {
        const tabbed = pulse(NO_PULSES, { workspaceId: 'fancy', reason: 'workspaceTabs', file: null, line: null });
        const a = arrive(tabbed, 'genie://workspace/fancy');
        expect(a.show).toBeNull();
        expect(pulsingIds(a.pulses).size).toBe(0);
    });

    it('a later tab change keeps the file opened earlier; a later file replaces it', () => {
        const then = pulse(opened, { workspaceId: 'tynn', reason: 'workspaceTabs', file: null, line: null });
        expect(parseRoute(arrive(then, 'genie://workspace/tynn').show!)).toMatchObject({ file: 'README.md' });
        const later = pulse(opened, { workspaceId: 'tynn', reason: 'openFileForUser', file: 'CHANGELOG.md', line: null });
        expect(parseRoute(arrive(later, 'genie://workspace/tynn').show!)).toMatchObject({ file: 'CHANGELOG.md' });
    });

    it('arriving where nothing pulses changes nothing (the same object back — no re-render)', () => {
        const a = arrive(opened, 'genie://workspace/fancy');
        expect(a.pulses).toBe(opened);
        expect(arrive(NO_PULSES, 'genie://workspace/tynn').pulses).toBe(NO_PULSES);
    });
});

/**
 * A NAVIGATION REACHES THE MAIN WINDOW ONLY (genie#1302 follow-up). The tray's Settings and Task Manager and Help's What's
 * new reveal the MAIN window and navigate it. They were broadcast to every window, and every window's renderer obeys
 * `genie:navigate` by writing its hash: an open flow editor, take-over or file window turned into the main app (a second
 * copy of it) at the moment the main window came up. A pulse is not a navigation (it moves nothing) and still reaches
 * every window, as before.
 */
describe('which windows a view request reaches', () => {
    const windows = [
        { name: 'main', main: true },
        { name: 'flow editor', main: false },
        { name: 'take-over', main: false },
        { name: 'files', main: false },
    ];
    const gestures = [
        { activation: 'user-gesture', route: 'genie://settings', reason: 'Settings' },
        { activation: 'user-gesture', route: 'genie://hosting?tab=processes', reason: 'tray: Task Manager' },
        { activation: 'user-gesture', route: 'genie://whats-new', reason: 'menu: What is new' },
    ] as const;

    it('the person’s gesture navigates the MAIN window (the positive control)', () => {
        for (const g of gestures) expect(viewReaches(viewDelivery(g), { main: true }), g.reason).toBe(true);
    });

    it('…and never a flow editor, take-over or files window', () => {
        for (const g of gestures) {
            const reached = windows.filter((w) => viewReaches(viewDelivery(g), w)).map((w) => w.name);
            expect(reached, g.reason).toEqual(['main']);
        }
    });

    it('a pulse (an agent’s action) still reaches every window: it moves nothing', () => {
        const d = viewDelivery({ activation: 'background', workspaceId: 'tynn', reason: 'workspaceTabs' });
        expect(windows.filter((w) => viewReaches(d, w)).map((w) => w.name)).toEqual(['main', 'flow editor', 'take-over', 'files']);
    });
});

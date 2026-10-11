import { describe, expect, it } from 'vitest';
import { FilesWindows } from '../src/main/files-windows.js';

/**
 * THE POPPED-OUT PANELS' WINDOWS (§4.3), tracked in main. One per workspace: popping out a panel
 * that is already out focuses its window (the window layer's job) and changes nothing here; a window
 * closing — by the user or by "bring it back" — returns the panel. Every change is pushed to the
 * renderer as the whole list, so the dock can draw the bar or the panel from one fact.
 */

function harness() {
    const opened: string[] = [];
    const closed: string[] = [];
    const changes: string[][] = [];
    const windows = new FilesWindows({ openWindow: (route) => { opened.push(route); }, closeWindow: (route) => { closed.push(route); } });
    windows.onChange((list) => changes.push([...list]));
    return { windows, opened, closed, changes };
}

describe('FilesWindows', () => {
    it('popOut opens the route once per workspace and lists it; a second popOut re-opens (focus) without a second entry or change', () => {
        const h = harness();
        h.windows.popOut('tynn');
        expect(h.opened).toEqual(['genie://files/tynn']);
        expect(h.windows.list()).toEqual(['tynn']);
        expect(h.changes).toEqual([['tynn']]);
        h.windows.popOut('tynn');
        expect(h.opened).toEqual(['genie://files/tynn', 'genie://files/tynn']);
        expect(h.windows.list()).toEqual(['tynn']);
        expect(h.changes).toEqual([['tynn']]);
        h.windows.popOut('fancy');
        expect(h.windows.list()).toEqual(['tynn', 'fancy']);
    });

    it('windowClosed returns the panel; bringBack asks the window layer to close that route and the close event does the rest', () => {
        const h = harness();
        h.windows.popOut('tynn');
        h.windows.bringBack('tynn');
        expect(h.closed).toEqual(['genie://files/tynn']);
        // Nothing changes until the window has actually gone.
        expect(h.windows.list()).toEqual(['tynn']);
        h.windows.windowClosed('tynn');
        expect(h.windows.list()).toEqual([]);
        expect(h.changes).toEqual([['tynn'], []]);
        // Closing a window that was never tracked, or bringing back one that is not out, is a no-op.
        h.windows.windowClosed('tynn');
        h.windows.bringBack('fancy');
        expect(h.closed).toEqual(['genie://files/tynn']);
        expect(h.changes).toEqual([['tynn'], []]);
    });
});

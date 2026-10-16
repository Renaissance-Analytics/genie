import { describe, expect, it } from 'vitest';
import { formatRoute, parseRoute } from '../src/core/route.js';

/**
 * THE TAKE OVER WINDOW'S ROUTE — `genie://takeover/<terminalId>`.
 *
 * A second BrowserWindow loads the same renderer with this hash, and renders ONLY the terminal
 * pane for that id: no rail, no title bar, nothing of Genie's chrome. The TUI is the window.
 */

describe('the take-over route', () => {
    it('parses and formats', () => {
        const parsed = parseRoute('genie://takeover/term_abc');
        expect(parsed).toMatchObject({ surface: 'takeover', terminalId: 'term_abc' });
        expect(formatRoute(parsed)).toBe('genie://takeover/term_abc');
    });

    it('refuses a take-over route with no id, like an agent or workspace route', () => {
        expect(parseRoute('genie://takeover/')).toMatchObject({ surface: 'dashboard' });
        expect(parseRoute('genie://takeover')).toMatchObject({ surface: 'dashboard' });
    });

    it('carries no modifiers — there is no chat on a TUI window', () => {
        // `chat=` on a take-over route is dropped on format: the window has no flyout to open.
        const parsed = parseRoute('genie://takeover/term_abc?chat=kai');
        expect(formatRoute(parsed)).toBe('genie://takeover/term_abc');
    });
});

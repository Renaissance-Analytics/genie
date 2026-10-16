import { describe, expect, it } from 'vitest';
import { parseRoute } from '../src/core/route.js';
import { SERVABLE } from '../src/renderer/bridge.js';

/**
 * THE POPPED-OUT FILE PANEL IS A WINDOW WITH A ROUTE (§4.3): `genie://files/<workspaceId>`, one
 * panel, no chrome — like the Take Over window. No id is not a window. It is servable, so it is not
 * §0.4 (built and unreachable).
 */

describe('genie://files/<workspaceId>', () => {
    it('parses to the files surface for that workspace, with no modifiers', () => {
        expect(parseRoute('genie://files/tynn')).toEqual({ surface: 'files', workspaceId: 'tynn', chat: null, pin: null });
        expect(parseRoute('genie://files/tynn?chat=kai&pin=right')).toEqual({ surface: 'files', workspaceId: 'tynn', chat: null, pin: null });
    });

    it('no id is the Dashboard, not a blank window', () => {
        expect(parseRoute('genie://files')).toMatchObject({ surface: 'dashboard' });
        expect(parseRoute('genie://files/')).toMatchObject({ surface: 'dashboard' });
    });

    it('is servable', () => {
        expect(SERVABLE).toContain('files');
    });
});

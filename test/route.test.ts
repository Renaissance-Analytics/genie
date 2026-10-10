import { describe, expect, it } from 'vitest';
import { DEFAULT_ROUTE, formatRoute, parseRoute, type Route } from '../src/core/route.js';

describe('routes are the application’s state, so they parse exactly', () => {
    it('lands on the Dashboard by default, grouped by workspace', () => {
        // The default surface is the Dashboard, reachable with no shortcut and no prior state.
        expect(DEFAULT_ROUTE).toBe('genie://dashboard?group=workspace');
        expect(parseRoute(DEFAULT_ROUTE)).toEqual({ surface: 'dashboard', group: 'workspace', chat: null, pin: null });
    });

    it('parses an agent route with its tab, lane range and event anchor', () => {
        expect(parseRoute('genie://agent/kai?tab=stream&lane=tools&at=ev_8831')).toEqual({
            surface: 'agent', agentId: 'kai', tab: 'stream', lane: 'tools', at: 'ev_8831', range: null, chat: null, pin: null,
        });
    });

    it('defaults an agent to the Stream tab rather than to nothing', () => {
        // Stream is ALWAYS present for a declared agent and is never gated on a fidelity
        // check. A route with no tab resolving to "no tab" is how the Conversation UI shipped
        // unreachable: one condition hid a finished feature.
        expect(parseRoute('genie://agent/kai')).toMatchObject({ surface: 'agent', agentId: 'kai', tab: 'stream' });
    });

    it('carries the chat flyout and its pin on ANY surface', () => {
        // The flyout is a modifier, not a surface — it rides whatever you are looking at.
        expect(parseRoute('genie://dashboard?group=status&chat=wren&pin=right')).toEqual({
            surface: 'dashboard', group: 'status', chat: 'wren', pin: 'right',
        });
        expect(parseRoute('genie://workspace/tynn?panel=files&chat=kai')).toMatchObject({
            surface: 'workspace', workspaceId: 'tynn', panel: 'files', chat: 'kai', pin: null,
        });
    });

    it('round-trips every route it can parse', () => {
        // The rail writes routes and the chrome displays them; a format/parse pair that
        // disagrees means the bar shows one place while the view renders another.
        const routes = [
            'genie://dashboard?group=workspace',
            'genie://dashboard?group=status&chat=wren&pin=right',
            'genie://deck',
            'genie://agent/kai?tab=stream',
            'genie://agent/kai?tab=stream&lane=tools&at=ev_8831',
            'genie://workspace/tynn?panel=files',
        ];

        for (const r of routes) expect(formatRoute(parseRoute(r))).toBe(r);
    });

    it('falls back to the Dashboard for an unknown surface rather than rendering a blank', () => {
        // A blank window with a stale route in the bar is unrecoverable without the keyboard.
        expect(parseRoute('genie://wat')).toMatchObject({ surface: 'dashboard' });
        expect(parseRoute('')).toMatchObject({ surface: 'dashboard' });
        expect(parseRoute('not-a-route-at-all')).toMatchObject({ surface: 'dashboard' });
    });

    it('refuses an agent or workspace route with no id, instead of inventing one', () => {
        // `genie://agent/` with an empty id would look up an agent named "" and render an
        // empty session forever — §0.4's failure, reached by a different door.
        expect(parseRoute('genie://agent/')).toMatchObject({ surface: 'dashboard' });
        expect(parseRoute('genie://workspace')).toMatchObject({ surface: 'dashboard' });
    });

    it('ignores a tab the surface does not have', () => {
        // A Declared agent has Stream | Files | Changes. `tab=terminal` belongs to an Observed
        // one; honouring it on a declared agent would render a tab that cannot populate.
        expect(parseRoute('genie://agent/kai?tab=nonsense')).toMatchObject({ tab: 'stream' });
    });

    it('keeps an UNKNOWN agent id — a 404 is the view’s to report, not the parser’s', () => {
        // The parser does not know the roster, and a parser that silently redirects an id it
        // cannot resolve produces "I clicked the link and it put me on the Dashboard".
        expect(parseRoute('genie://agent/ghost-that-does-not-exist')).toMatchObject({
            surface: 'agent', agentId: 'ghost-that-does-not-exist',
        });
    });

    it('never emits a query string with no parameters in it', () => {
        // COUNT over every route shape: a trailing `?` is the kind of drift that makes the
        // bar's text differ from the link an agent pasted, for no visible reason.
        const shapes: Route[] = [
            { surface: 'deck', chat: null, pin: null },
            { surface: 'dashboard', group: 'workspace', chat: null, pin: null },
            { surface: 'agent', agentId: 'kai', tab: 'stream', lane: null, at: null, range: null, chat: null, pin: null },
            { surface: 'workspace', workspaceId: 'tynn', panel: null, chat: null, pin: null },
        ];

        expect(shapes.map(formatRoute).filter((r) => r.endsWith('?'))).toEqual([]);
        // POSITIVE CONTROL: these DO produce query strings where there is something to say.
        expect(shapes.map(formatRoute).filter((r) => r.includes('?'))).toHaveLength(2);
    });
});

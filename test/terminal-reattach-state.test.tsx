import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { reattachWithState, type ReattachState } from '../src/renderer/reattach.js';
import { ReattachBanner } from '../src/renderer/components/ReattachBanner.js';

/**
 * RE-ATTACHING TERMINALS SHOWS WHERE IT IS (the host split, P2.1; the owner's rule: every action shows its progress, then
 * success or a failure with Retry). After a window restart the open terminals are taken back from genie-host: the
 * workspace says "Re-attaching terminals…", then how many it attached, or why it could not, with Retry. A failure that
 * used to be an unhandled rejection with nothing on screen is now said.
 */

type Listed = { id: string; workspaceId: string; pid: number; shell: string };
const bridge = (over: { list?: () => Promise<Listed[]>; attach?: (ws: string, id: string) => Promise<{ id: string; pid: number; shell: string; workspaceId: string; scrollback: string } | null> } = {}) => ({
    list: over.list ?? (async () => [{ id: 't1', workspaceId: 'ws', pid: 1, shell: 'bash' }, { id: 't2', workspaceId: 'ws', pid: 2, shell: 'zsh' }]),
    attach: over.attach ?? (async (_ws: string, id: string) => ({ id, pid: 1, shell: 'bash', workspaceId: 'ws', scrollback: `out of ${id}` })),
});

describe('re-attach states', () => {
    it('re-attaching, then attached with the count; the terminals come back with their scrollback', async () => {
        const states: ReattachState[] = [];
        const joined = await reattachWithState(bridge(), 'ws', (s) => states.push(s));
        expect(states).toEqual([{ phase: 'reattaching' }, { phase: 'attached', count: 2 }]);
        expect(joined.map((t) => [t.id, t.scrollback])).toEqual([['t1', 'out of t1'], ['t2', 'out of t2']]);
    });

    it('nothing running: one quiet state, no banner worth showing', async () => {
        const states: ReattachState[] = [];
        await reattachWithState(bridge({ list: async () => [] }), 'ws', (s) => states.push(s));
        expect(states).toEqual([{ phase: 'reattaching' }, { phase: 'attached', count: 0 }]);
    });

    it('a failure is SAID, with its reason — never an unhandled rejection with nothing on screen', async () => {
        const states: ReattachState[] = [];
        const joined = await reattachWithState(bridge({ list: async () => { throw new Error('the agent host is not connected'); } }), 'ws', (s) => states.push(s));
        expect(joined).toEqual([]);
        expect(states).toEqual([{ phase: 'reattaching' }, { phase: 'failed', reason: 'the agent host is not connected' }]);
    });
});

describe('the banner', () => {
    it('re-attaching: says so, busy', () => {
        const html = renderToStaticMarkup(<ReattachBanner state={{ phase: 'reattaching' }} onRetry={() => {}} />);
        expect(html).toContain('Re-attaching terminals');
        expect(html).toContain('aria-busy="true"');
    });

    it('attached: how many came back', () => {
        expect(renderToStaticMarkup(<ReattachBanner state={{ phase: 'attached', count: 2 }} onRetry={() => {}} />)).toContain('Re-attached 2 terminals');
        expect(renderToStaticMarkup(<ReattachBanner state={{ phase: 'attached', count: 1 }} onRetry={() => {}} />)).toContain('Re-attached 1 terminal');
    });

    it('failed: the reason, and a Retry button', () => {
        const html = renderToStaticMarkup(<ReattachBanner state={{ phase: 'failed', reason: 'the agent host is not connected' }} onRetry={() => {}} />);
        expect(html).toContain('the agent host is not connected');
        expect(html).toMatch(/<button[^>]*data-action="reattach-retry"[^>]*>[\s\S]*Retry/);
    });

    it('nothing to say (idle, or none came back) renders nothing', () => {
        expect(renderToStaticMarkup(<ReattachBanner state={{ phase: 'idle' }} onRetry={() => {}} />)).toBe('');
        expect(renderToStaticMarkup(<ReattachBanner state={{ phase: 'attached', count: 0 }} onRetry={() => {}} />)).toBe('');
    });
});

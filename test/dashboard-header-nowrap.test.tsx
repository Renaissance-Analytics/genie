import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentRow } from '../src/core/dashboard-view.js';
import { Dashboard } from '../src/renderer/components/Dashboard.js';

/**
 * A GROUP HEADER NEVER WRAPS (the beta.34 release check, Windows, 2026-10-21: "800px — nothing overflows a fixed-height
 * row — relative flex h-7 … 27→30"). The workspace header is a 28 px row; with the chat docked and a workspace named
 * `release-beta34`, its name wrapped onto a second line and the row's content stood 30 px tall. beta.33's run passed only
 * because its workspace was named `release33`. Every h-7 header now holds one line: nothing in it wraps, and the path —
 * the one part that may give way — truncates (a flex child truncates only with `min-w-0`).
 */

const row = (over: Partial<AgentRow> = {}): AgentRow => ({
    id: 'a1', name: 'atlas', provider: 'claude', workspaceId: 'release-beta34', fidelity: 'declared', state: 'idle', duration: null,
    ask: null, reason: null, fixes: [], step: null, target: null, activity: null, delivery: null, collaborators: null,
    commsAgeSeconds: null, contextUsed: null, contextSize: null, ...over,
});
const WORKSPACES = [{ id: 'release-beta34', name: 'release-beta34', path: 'C:/Users/genie/work/a-long-workspace-folder-name/release-beta34' }];
const noop = () => {};

/** Every h-7 header row in the markup, as its opening tag and what is inside it up to the next row. */
function headers(html: string): string[] {
    return html.split('<div class="relative flex h-7').slice(1).map((s) => `<div class="relative flex h-7${s.slice(0, s.indexOf('</div>'))}`);
}

function render(group: 'workspace' | 'status') {
    return renderToStaticMarkup(
        <Dashboard rows={[row()]} genie={row({ id: 'g', name: 'genie', workspaceId: '' })} workspaces={WORKSPACES as never} onOpenAgent={noop} onAddAgent={noop} group={group} />,
    );
}

describe('the Dashboard’s group headers hold one line', () => {
    for (const group of ['workspace', 'status'] as const) {
        it(`grouped by ${group}: every header row is nowrap (COUNTED, so "every" is not true of none)`, () => {
            const hs = headers(render(group));
            expect(hs.length).toBeGreaterThanOrEqual(group === 'workspace' ? 2 : 1);
            for (const h of hs) expect(h.slice(0, h.indexOf('>')), h.slice(0, 120)).toMatch(/\bwhitespace-nowrap\b/);
        });
    }

    it('the path is the part that gives way: it truncates, and can (min-w-0)', () => {
        const hs = headers(render('workspace'));
        const truncating = hs.flatMap((h) => [...h.matchAll(/class="([^"]*\btruncate\b[^"]*)"/g)].map((m) => m[1]!));
        expect(truncating.length).toBeGreaterThanOrEqual(2);
        for (const c of truncating) expect(c).toMatch(/\bmin-w-0\b/);
    });
});

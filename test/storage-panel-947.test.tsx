// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StorageReport, StorageView } from '../src/core/workspace-storage.js';
import { StoragePanel } from '../src/renderer/components/StoragePanel.js';
import type { FeatureAction } from '../src/renderer/features.js';
import { registerAppIcons } from '../src/renderer/icons.js';

/**
 * THE STORAGE TAB SAYS WHAT IS HAPPENING (Tynn #947). In beta.65 the owner pressed Move to .trash (641 items) and Empty trash
 * and the tab said nothing: no progress, a one-line result drawn at the top of a list hundreds of rows long, and a refusal
 * from the host only in the console. Pinned: a status block that stays in view (sticky) with the progress (n of m, bytes,
 * the item now), the result, and each item it did not move or delete with the reason; a refusal of the action itself is
 * drawn there too; and nothing else can be started while the host is working.
 */
registerAppIcons();

const report: StorageReport = {
    measuredAt: Date.now(), truncated: false,
    totals: { repos: 0, worktrees: 1_000_000, 'ci-artifacts': 0, 'chat-files': 0, dirty: 0, trash: 1000 },
    reclaimableBytes: 1_000_000,
    items: [{ id: 'worktrees:wt/a', category: 'worktrees', label: 'wt/a (wt-a)', rel: 'wt/a', bytes: 1_000_000, files: 3, truncated: false, reclaimable: true, refusal: null, state: 'merged', newest: 1 }],
    trash: [{ id: 'old', origin: { kind: 'unknown', name: 'old' }, movedAt: null, bytes: 1000 }],
};
const view = (over: Partial<StorageView> = {}): StorageView => ({ measuring: false, report, error: null, outcome: null, ...over });

let host: HTMLDivElement;
let root: Root;
let actions: FeatureAction[];
let answer: { ok: true } | { ok: false; reason: string };
beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    actions = [];
    answer = { ok: true };
});
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; });
const draw = (v: StorageView | null) => act(() => { root.render(<StoragePanel workspaceId="ws1" view={v} onAction={async (a) => { actions.push(a); return answer; }} />); });
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;

describe('the Storage tab while the host works, and after', () => {
    it('progress: n of m, bytes, the item now, in a status block that stays in view', () => {
        draw(view({ progress: { action: 'move', done: 12, total: 641, bytes: 1_258_291, current: 'wt/a' } }));
        const status = q('[data-storage-status]')!;
        expect(status.className).toMatch(/sticky/);
        expect(q('[data-storage-progress]')!.textContent).toMatch(/Moving to \.trash: 12 of 641 \(1\.2 MB\)/);
        expect(q('[data-storage-progress]')!.textContent).toMatch(/wt\/a/);
        expect(q('[data-storage-progress] progress, [data-storage-progress] [role="progressbar"]')).not.toBeNull();
    });

    it('emptying says so', () => {
        draw(view({ progress: { action: 'empty', done: 1, total: 2, bytes: 1000, current: 'old' } }));
        expect(q('[data-storage-progress]')!.textContent).toMatch(/Emptying \.trash: 1 of 2/);
    });

    it('while the host works, no Move, Clean up or Empty can be started', () => {
        draw(view({ progress: { action: 'move', done: 1, total: 2, bytes: 0, current: null } }));
        for (const sel of ['[data-action="storage-trash"]', '[data-action="storage-empty-trash"]']) {
            const b = q(sel);
            expect(b === null || b.hasAttribute('disabled')).toBe(true);
        }
        // CONTROL: idle, they are there and enabled.
        draw(view());
        expect(q('[data-action="storage-trash"]')!.hasAttribute('disabled')).toBe(false);
        expect(q('[data-action="storage-empty-trash"]')!.hasAttribute('disabled')).toBe(false);
    });

    it('the result, and each item not moved with its reason, in the status block', () => {
        draw(view({ outcome: 'Moved 1 of 3 items (2.0 KB) to .trash; 2 were not moved.', failures: [{ label: 'wt/dirty', reason: 'It has uncommitted changes.' }, { label: 'x/coverage', reason: 'EBUSY: resource busy or locked' }] }));
        const status = q('[data-storage-status]')!;
        expect(status.textContent).toMatch(/Moved 1 of 3 items/);
        const rows = [...document.querySelectorAll('[data-storage-failure]')].map((e) => e.textContent);
        expect(rows).toEqual([expect.stringMatching(/wt\/dirty.*uncommitted changes/), expect.stringMatching(/x\/coverage.*EBUSY/)]);
    });

    it('a refusal of the action itself is drawn, not left in the console', async () => {
        answer = { ok: false, reason: 'Genie is still moving items to .trash in this workspace (3 of 641); wait for it to finish.' };
        draw(view());
        await act(async () => { q('[data-action="storage-trash"]')!.click(); await new Promise((r) => setTimeout(r, 0)); });
        expect(actions).toEqual([{ kind: 'storage.trash', workspaceId: 'ws1', itemId: 'worktrees:wt/a' }]);
        expect(q('[data-storage-refusal]')!.textContent).toMatch(/still moving items/);
    });
});
